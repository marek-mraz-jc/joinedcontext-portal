/**
 * The records screen, over what a raw space answers (T-2436, T-2437).
 *
 * `fetch` is what is stubbed and nothing below it, so every case goes through the SDK's own
 * endpoint source and the grid it feeds: the same URLs, the same NGSI-LD bodies and the same
 * refusal handling the published bundle uses.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer, CITY, REGION } from "./fixtures/records";
import { LOCALES, noteWords, SPACE_OF } from "./locales";
import { NOTE, NOTE_MAX } from "./records";

const CITY_SLUG = "ovr4ttzywhad2oiogf67n7zyn2g2elfc";
const REGION_SLUG = "7u4ns3cdg2mqlx5gmxhk7rqai6pmokdj";
const sk = LOCALES.sk;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "ngsild-results-count": String(CITY.length) },
  });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: "Refused", status, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

let calls: Array<{ path: string; method: string; body?: unknown; init?: RequestInit }>;

function serving(options: { rows?: () => Response; write?: () => Response } = {}) {
  return vi.fn(async (path: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      path,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      init,
    });
    if (method === "PATCH") {
      return options.write ? options.write() : new Response(null, { status: 204 });
    }
    if (path.includes("/entities")) {
      return options.rows ? options.rows() : json(answer(CITY));
    }
    throw new Error(`no stub for ${method} ${path}`);
  });
}

function show(
  options: Parameters<typeof serving>[0] = {},
  over: { language?: string; space?: string; slug?: string } = {},
) {
  vi.stubGlobal("fetch", serving(options));
  const client = stubClient(undefined, {
    slug: over.slug ?? CITY_SLUG,
    orgDomain: "banskabystrica.sk",
    space: over.space ?? SPACE_OF.banskabystrica,
    transport: "origin",
    appName: "banskabystrica-zaznamy",
    language: over.language ?? "sk",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

const rows = () => screen.getAllByRole("row").filter((row) => within(row).queryAllByRole("gridcell").length > 0);
const noteBox = (index: number) => screen.getAllByRole("textbox", { name: `${sk.grid.edit} ${sk.column[NOTE]}` })[index];

beforeEach(() => {
  calls = [];
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the records of one publisher", () => {
  it("shows one row per entity, under this body's own heading", async () => {
    show();
    expect(screen.getByRole("heading", { name: sk.title.banskabystrica, level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(CITY.length));
    expect(screen.getByText(sk.source.banskabystrica)).toBeInTheDocument();
    expect(screen.queryByText(sk.title.bbsk)).toBeNull();
  });

  it("shows the region's rows under the region's heading, from the space alone", async () => {
    show({ rows: () => json(answer(REGION, SPACE_OF.bbsk, "bbsk.sk")) }, { space: SPACE_OF.bbsk, slug: REGION_SLUG });
    expect(screen.getByRole("heading", { name: sk.title.bbsk, level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(rows()).toHaveLength(REGION.length));
    // The same bundle, and it reads the region's endpoint because that is what it was served.
    expect(calls[0].path).toContain(`/api/endpoint/${REGION_SLUG}/`);
  });

  it("says on the page why the figures cannot be edited", () => {
    show();
    expect(screen.getByText(sk.readOnlyWhy)).toBeInTheDocument();
  });

  it("opens the note and no other column: a figure has no editable control at all", async () => {
    show();
    await waitFor(() => expect(rows()).toHaveLength(CITY.length));
    // One text box per row, and it is the note's.
    expect(screen.getAllByRole("textbox", { name: `${sk.grid.edit} ${sk.column[NOTE]}` })).toHaveLength(CITY.length);
    for (const column of ["value", "indicator", "refArea", "refPeriod", "dateObserved"]) {
      expect(
        screen.queryAllByRole("textbox", { name: `${sk.grid.edit} ${sk.column[column]}` }),
        column,
      ).toHaveLength(0);
      expect(screen.queryAllByRole("spinbutton", { name: `${sk.grid.edit} ${sk.column[column]}` }), column).toHaveLength(0);
    }
  });

  it("asks the endpoint for one page of one type, and says how many match", async () => {
    show();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const asked = new URL(calls[0].path, "http://localhost");
    expect(asked.searchParams.get("type")).toBe("StatisticalObservation");
    expect(asked.searchParams.get("limit")).toBe("25");
    expect(asked.searchParams.get("count")).toBe("true");
  });
});

describe("a filter is the endpoint's own query", () => {
  it("sends what the filter row says it sends, and never filters in the browser", async () => {
    const user = userEvent.setup();
    show();
    await waitFor(() => expect(rows()).toHaveLength(CITY.length));

    await user.selectOptions(
      screen.getByRole("combobox", { name: `${sk.grid.filter}: ${sk.column.refPeriod}` }),
      "equals",
    );
    await user.type(screen.getByRole("textbox", { name: `${sk.grid.value}: ${sk.column.refPeriod}` }), "2023");

    await waitFor(() => {
      const last = new URL(calls[calls.length - 1].path, "http://localhost");
      expect(last.searchParams.get("q")).toBe('refPeriod=="2023"');
    });
    // The query the screen shows is the query it sent.
    expect(screen.getByText(`q=refPeriod=="2023"`)).toBeInTheDocument();
  });
});

describe("writing the note", () => {
  async function typeNote(user: ReturnType<typeof userEvent.setup>, text: string) {
    await waitFor(() => expect(rows()).toHaveLength(CITY.length));
    await user.type(noteBox(0), text);
    await user.click(screen.getByRole("button", { name: sk.grid.review! }));
    await user.click(within(screen.getByRole("region", { name: sk.grid.review })).getByRole("button", { name: sk.grid.apply! }));
  }

  it("sends one PATCH carrying the note and nothing else, with the person's own session", async () => {
    const user = userEvent.setup();
    show();
    await typeNote(user, "Overené.");

    const writes = calls.filter((call) => call.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toContain(`/api/endpoint/${CITY_SLUG}/ngsi-ld/v1/entities/`);
    expect(writes[0].path.endsWith("/attrs")).toBe(true);
    expect(writes[0].body).toEqual({ [NOTE]: { type: "Property", value: "Overené." } });
    // The person carries the write: the same-origin session, never a credential of the bundle.
    expect(writes[0].init?.credentials).toBe("same-origin");
    const headers = (writes[0].init?.headers ?? {}) as Record<string, string>;
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
  });

  it("shows a 403 from the Policy in the gateway's own words, and keeps what was typed", async () => {
    const user = userEvent.setup();
    const refusal = "writing value needs the steward role";
    show({ write: () => problem(403, refusal) });
    await typeNote(user, "Overené.");

    expect(await screen.findByText(new RegExp(refusal))).toBeInTheDocument();
    // The value is still the person's: it stays pending rather than being thrown away.
    expect(noteBox(0)).toHaveValue("Overené.");
    expect(screen.getAllByRole("status").map((one) => one.textContent).join(" ")).toContain(
      sk.grid.pending!,
    );
  });

  it("does not retry a refused write without the person, and asks once (AP-40)", async () => {
    const user = userEvent.setup();
    show({ write: () => problem(401, "no session") });
    await typeNote(user, "Overené.");

    const writes = calls.filter((call) => call.method === "PATCH");
    expect(writes).toHaveLength(1);
    expect((writes[0].init?.headers ?? {}) as Record<string, string>).not.toHaveProperty("Authorization");
  });

  it("never sends a note the model would refuse", async () => {
    const user = userEvent.setup();
    show();
    await typeNote(user, "a".repeat(NOTE_MAX + 1));

    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    expect(await screen.findByText(new RegExp(noteWords(sk).tooLong(NOTE_MAX)))).toBeInTheDocument();
  });
});

describe("what the screen says about itself", () => {
  it("is Slovak by default and English when the configuration asks", async () => {
    const { unmount } = show();
    expect(screen.getByRole("heading", { name: sk.title.banskabystrica, level: 1 })).toBeInTheDocument();
    unmount();

    show({}, { language: "en" });
    expect(
      screen.getByRole("heading", { name: LOCALES.en.title.banskabystrica, level: 1 }),
    ).toBeInTheDocument();
  });

  it("says so rather than guessing when it is configured for a space it does not know", () => {
    show({}, { space: "helsinki" });
    expect(screen.getByRole("alert")).toHaveTextContent(sk.unknownSpace);
    expect(calls).toHaveLength(0);
  });

  it("has no axe violation with the records on screen", async () => {
    const { container } = show();
    await waitFor(() => expect(rows()).toHaveLength(CITY.length));
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});
