import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import { EVENTS } from "../fixtures/events";
import { hourOf, MyDay } from "./MyDay";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = vi.fn();
    remove = vi.fn();
  },
  LngLatBounds: class {
    extend = vi.fn();
  },
  Popup: class {},
  setWorkerUrl: vi.fn(),
}));
vi.mock("echarts/core", () => ({ use: vi.fn(), init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn(), on: vi.fn() })) }));
const downloads: Array<{ blob: Blob; name: string }> = [];
vi.mock("@joinedcontext/sdk", async (original) => ({
  ...(await original<typeof import("@joinedcontext/sdk")>()),
  download: (blob: Blob, name: string) => downloads.push({ blob, name }),
}));

const READ = {
  permissions: [{ resource: { type: "Event" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

function show(language = "en", entities = EVENTS) {
  const client = stubClient({ entities, access: READ }, { appName: "event-day-planner", language });
  render(
    <JcProvider client={client}>
      <MyDay />
    </JcProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-10-20T05:00:00Z"));
  window.history.replaceState(null, "", "/");
  downloads.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

// T-3329: the first screen answers "what can I see today" without a click.
describe("MyDay", () => {
  it("suggests a day of events that follow one another, read only through the app's endpoint", async () => {
    const client = show();
    const plan = await screen.findByRole("list", { name: "The plan" });
    expect(screen.getByText(/A suggested day/)).toBeInTheDocument();
    expect(within(plan).getAllByRole("listitem").length).toBeGreaterThan(1);
    expect(within(plan).getByText("Workshop for Families")).toBeInTheDocument();
    expect(client.transport.calls.every((call) => call.method === "GET" && call.path.includes("/api/endpoint/"))).toBe(true);
  });

  it("plans the events a visitor picks, flags a clash, and keeps the picks in the address", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Events of the day" });
    fireEvent.click(within(list).getByRole("checkbox", { name: /Organ concert/ }));
    fireEvent.click(within(list).getByRole("checkbox", { name: /Poetry reading/ }));
    await waitFor(() => expect(screen.getByText("2 chosen events in their best order.")).toBeInTheDocument());
    expect(screen.getByText("Organ concert and Poetry reading take place at the same time.")).toBeInTheDocument();
    expect(screen.getByText(/min late/)).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("pick")).toBe("helsinki-agf2,helsinki-agf3");
  });

  it("downloads the day as a calendar file", async () => {
    show();
    await screen.findByRole("list", { name: "The plan" });
    fireEvent.click(screen.getByRole("button", { name: "Download to calendar (.ics)" }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("2030-10-20-helsinki.ics");
    expect(await downloads[0].blob.text()).toContain("BEGIN:VCALENDAR");
  });

  it("lists a cancelled event without letting it be picked", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Events of the day" });
    expect(within(list).getByRole("checkbox", { name: /Cancelled lecture/ })).toBeDisabled();
    expect(within(list).getByText("Cancelled")).toBeInTheDocument();
  });

  it("narrows the list to an hour from the address, and a click on the chip shows every hour", async () => {
    window.history.replaceState(null, "", "/?hour=18");
    show();
    const list = await screen.findByRole("list", { name: "Events of the day" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show every hour, not only at 18" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Events of the day" })).getAllByRole("listitem")).toHaveLength(6));
  });

  it("speaks Finnish when the Portal does", async () => {
    show("fi");
    expect(await screen.findByRole("list", { name: "Suunnitelma" })).toBeInTheDocument();
    expect(screen.getByText(/Ehdotettu päivä/)).toBeInTheDocument();
  });

  it("says so when the day has no event, and in words when the events cannot be read", async () => {
    show("en", []);
    expect(await screen.findAllByText("No event takes place on this day.")).not.toHaveLength(0);
  });

  it("offers to try again when the endpoint fails", async () => {
    const client = stubClient(
      { entities: EVENTS, access: READ, refuse: () => ({ status: 503, body: { title: "Unavailable" } }) },
      { appName: "event-day-planner", language: "en" },
    );
    render(
      <JcProvider client={client}>
        <MyDay />
      </JcProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The events could not be read (HTTP 503). Try again later.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

describe("hourOf", () => {
  it("takes an hour only in the day", () => {
    expect(hourOf("0")).toBe(0);
    expect(hourOf("23")).toBe(23);
    for (const wrong of ["", "24", "-1", "1.5", "noon"]) expect(hourOf(wrong)).toBeNull();
  });
});
