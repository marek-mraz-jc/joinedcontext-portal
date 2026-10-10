import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerProblem } from "../plans";
import type { NewPlan, PlanSummary, PlansApi, SavedPlan } from "../plans";
import { problemText, SavedPlans } from "./SavedPlans";

const STOP = { id: "urn:ngsi-ld:BikeHireDockingStation:001", name: "Kamppi", at: [24.93, 60.17] as [number, number], action: "pick" as const, bikes: 5, load: 5, legKm: 0 };

/** A server in memory, as the component sees the real one. */
function memory(): PlansApi & { saved: SavedPlan[] } {
  const saved: SavedPlan[] = [];
  const summary = (p: SavedPlan): PlanSummary => ({ id: p.id, operator: p.operator, vanCapacity: p.vanCapacity, km: p.km, moved: p.moved, stopCount: p.stops.length, createdAt: p.createdAt, drives: p.drives.length });
  return {
    saved,
    list: vi.fn(async (operator: string) => saved.filter((p) => !operator.trim() || p.operator === operator.trim()).map(summary)),
    save: vi.fn(async (plan: NewPlan) => {
      const made: SavedPlan = { ...plan, id: saved.length + 1, stops: [STOP], km: 1.5, moved: 5, createdAt: "2026-10-10T08:00:00Z", drives: [] };
      saved.push(made);
      return made;
    }),
    get: vi.fn(async (id: number) => {
      const plan = saved.find((p) => p.id === id);
      if (!plan) throw new ServerProblem(404, "no such plan");
      return plan;
    }),
    remove: vi.fn(async (id: number) => {
      saved.splice(saved.findIndex((p) => p.id === id), 1);
    }),
    drive: vi.fn(async (id: number, stops: string[]) => {
      const record = { id: 1, stops, km: null, note: null, drivenAt: "2026-10-10T09:00:00Z" };
      saved.find((p) => p.id === id)?.drives.push(record);
      return record;
    }),
    sheetUrl: vi.fn(async () => "https://store.example/apps/s1/x/sheets/1.csv?X-Amz-Signature=x"),
  };
}

const CURRENT = { vanCapacity: 12, start: null, include: ["a"], exclude: ["b"] };

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => window.history.replaceState(null, "", "/"));

// T-3346: a plan saved on the server comes back after a reload, for the van it was saved for.
describe("SavedPlans", () => {
  it("asks for the van or crew before it saves, then saves the plan on screen and lists it", async () => {
    const api = memory();
    render(<SavedPlans lang="en" api={api} current={CURRENT} onOpen={vi.fn()} />);
    expect(await screen.findByText("No plan is saved yet.")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save this plan" });
    expect(save).toBeDisabled();
    expect(screen.getByText("Name the van or crew the plan is for first.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Van or crew"), { target: { value: "Van 2" } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Plan saved: 1 stops for Van 2"));
    expect(api.save).toHaveBeenCalledWith({ ...CURRENT, operator: "Van 2" });
    const list = screen.getByRole("list", { name: "Saved plans" });
    expect(within(list).getByText(/^Van 2 ·/)).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("op")).toBe("Van 2");
  });

  it("opens a saved plan's choices, records a drive and deletes only after a second click", async () => {
    const api = memory();
    await api.save({ ...CURRENT, operator: "Van 2" });
    window.history.replaceState(null, "", "/?op=Van%202");
    const onOpen = vi.fn();
    render(<SavedPlans lang="en" api={api} current={CURRENT} onOpen={onOpen} />);
    const row = (await screen.findByText(/^Van 2 ·/)).closest("li") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /^Open:/ }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 1, include: ["a"], exclude: ["b"] })));
    fireEvent.click(within(row).getByRole("button", { name: /^Mark as driven:/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("The drive is recorded."));
    expect(api.drive).toHaveBeenCalledWith(1, [STOP.id]);
    expect(await screen.findByText(/driven 1 times/)).toBeInTheDocument();

    fireEvent.click(within(screen.getByText(/^Van 2 ·/).closest("li") as HTMLElement).getByRole("button", { name: /^Delete:/ }));
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(screen.getByText("No plan is saved for Van 2.")).toBeInTheDocument());
    expect(api.saved).toHaveLength(0);
  });

  it("says in the operator's language why the server refused", async () => {
    const api = memory();
    api.save = vi.fn(async () => {
      throw new ServerProblem(400, "the van carries 1 to 200 bikes");
    });
    render(<SavedPlans lang="fi" api={api} current={CURRENT} onOpen={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("Auto tai tiimi"), { target: { value: "Auto 1" } });
    fireEvent.click(screen.getByRole("button", { name: "Tallenna suunnitelma" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ei tallennettu: the van carries 1 to 200 bikes"));
  });

  it("maps every refusal to words a person can act on", () => {
    expect(problemText("en", new ServerProblem(0, ""), "saveFailed")).toMatch(/could not be reached/);
    expect(problemText("en", new ServerProblem(401, ""), "saveFailed")).toMatch(/Sign in again/);
    expect(problemText("en", new ServerProblem(403, ""), "saveFailed")).toMatch(/may not read/);
    expect(problemText("en", new ServerProblem(404, ""), "openFailed")).toMatch(/no longer there/);
    expect(problemText("en", new ServerProblem(507, ""), "saveFailed")).toMatch(/storage is full/);
    expect(problemText("en", new ServerProblem(502, ""), "saveFailed")).toMatch(/did not answer/);
    expect(problemText("en", new Error("x"), "saveFailed")).toMatch(/did not answer/);
  });
});
