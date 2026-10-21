/**
 * T-5066: keeping a new model as a shared draft writes `?draft=<name>` into the address (AG-61).
 * The page wrote that address for itself, so the page stays mounted: the view the person chose in
 * the editor stays open. Written with a bare `history.replaceState`, HandOff took it for an
 * assistant hand-off and mounted the page afresh, and the live journey's Source tab fell back to
 * Structure a moment after Monaco opened.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import { jsonResponse, renderRoute } from "./pageHarness";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a new model kept as a draft", () => {
  it("keeps the editor view the person chose when the draft lands in the address", async () => {
    const user = userEvent.setup();
    const kept: string[] = [];
    await renderRoute({
      path: "/projects/helsinki/models?new=blank&lang=en",
      answer: (path, request) => {
        if (request.method === "PUT" && path.startsWith("/api/v1/projects/helsinki/drafts/DataModel/")) {
          kept.push(path);
          return jsonResponse({
            project: "helsinki",
            kind: "DataModel",
            name: "stations",
            manifest: {},
            touchedBy: "demo.steward",
            touchedKind: "person",
            version: 1,
            updatedAt: "2026-10-21T21:00:00Z",
          });
        }
        return undefined;
      },
    });
    const region = await screen.findByRole("region", { name: en.models.create.title });
    await user.type(within(region).getByLabelText(en.models.create.name, { exact: true }), "stations");
    // A first edit is what makes the page keep the model.
    await user.type(screen.getByLabelText("New type"), "Station");
    await user.click(screen.getByRole("button", { name: "Add type" }));
    await user.click(screen.getByRole("tab", { name: en.models.view.preview }));
    expect(screen.getByRole("tab", { name: en.models.view.preview })).toHaveAttribute("aria-selected", "true");

    await waitFor(() => expect(new URL(window.location.href).searchParams.get("draft")).toBe("stations"));
    expect(kept).toEqual(["/api/v1/projects/helsinki/drafts/DataModel/stations"]);
    expect(await screen.findByText(en.models.create.held.replace("{name}", "stations"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: en.models.view.preview })).toHaveAttribute("aria-selected", "true");
  });
});
