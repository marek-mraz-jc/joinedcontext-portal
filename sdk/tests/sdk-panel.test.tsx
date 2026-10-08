/**
 * SDK-39, SDK-40 (T-3371): the one shell and the entity panel. An entity opens from any element by a
 * click or the keyboard; Edit shows only when the signed-in reader's access document allows the
 * write; a change is checked against the schema and shown before it is written; a conflict and a
 * refusal are said in words; without the right the panel links to the entity in the Portal.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { AccessDocument, Row } from "../src/sdk";
import { AppShell, JcProvider, ProblemError, SDK_WORDS, parseValue, portalLinkOf, selectable, useEntitySelection } from "../src/sdk";
import { parseConfig } from "../src/sdk/config";
import { stubClient } from "../src/sdk/testing";
import type { Field } from "../src/write";

const STATION: Row = {
  id: "urn:ngsi-ld:BikeHireDockingStation:hel.fi:helsinki:001",
  type: "BikeHireDockingStation",
  name: "Kaivopuisto",
  availableBikeNumber: 4,
  status: "working",
  location: { type: "Point", coordinates: [24.95, 60.16] },
};

const SCHEMA = {
  BikeHireDockingStation: {
    properties: {
      name: { type: "string", "x-ngsi-ld-kind": "Property" },
      availableBikeNumber: { type: ["integer", "null"], minimum: 0, maximum: 40, "x-ngsi-ld-kind": "Property" },
      status: { type: ["string", "null"], enum: ["working", "outOfService"], "x-ngsi-ld-kind": "Property" },
      location: { type: ["object", "null"], "x-ngsi-ld-kind": "GeoProperty" },
    },
  },
};

const READ: AccessDocument = {
  permissions: [{ resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" }],
  prohibitions: [],
};
const WRITE: AccessDocument = {
  permissions: [{ resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity", "retrieveEntity", "updateAttrs"], attributes: "*" }],
  prohibitions: [],
};

const PERSON = { id: "u1", name: "Aino", roles: ["steward"] };
const PORTAL = "https://portal.dev.example.org/projects/helsinki";

/** A page with the three kinds of opener the panel serves: a map feature, a table row and a chart point. */
function Openers(): React.JSX.Element {
  const { select } = useEntitySelection();
  const entity = { id: STATION.id, type: STATION.type };
  return (
    <div>
      <div data-testid="map-feature" aria-label="Kaivopuisto on the map" {...selectable(entity, select)} />
      <table>
        <tbody>
          <tr>
            <td>
              <button type="button" onClick={() => select(entity)}>
                Kaivopuisto row
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <button type="button" aria-label="chart point Kaivopuisto" onClick={() => select(entity)} />
    </div>
  );
}

function show(access: AccessDocument, config: Record<string, unknown> = {}, refuse?: (path: string, method: string) => { status: number; body: unknown } | null) {
  const client = stubClient(
    {
      entities: [STATION],
      schema: SCHEMA,
      access,
      refuse: refuse ? (request) => refuse(request.path, request.method) : undefined,
    },
    { user: PERSON, portal: PORTAL, ...config },
  );
  render(
    <JcProvider client={client}>
      <AppShell title="Bikes" pages={[{ id: "stations", label: "Stations", render: () => <Openers /> }]} />
    </JcProvider>,
  );
  return client;
}

async function openFromTable() {
  fireEvent.click(screen.getByRole("button", { name: "Kaivopuisto row" }));
  return screen.findByRole("dialog", { name: "Kaivopuisto" });
}

describe("the shell (SDK-39)", () => {
  it("carries the title, one page, the reader's name, and the same states for every App", async () => {
    show(READ);
    expect(screen.getByRole("heading", { level: 1, name: "Bikes" })).toBeInTheDocument();
    expect(screen.getByText("Aino")).toBeInTheDocument();
    // One page needs no navigation.
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("offers the language switch only when the App speaks two or more", () => {
    const onLanguage = vi.fn();
    const client = stubClient({}, {});
    render(
      <JcProvider client={client}>
        <AppShell
          title="Pyörät"
          language="fi"
          languages={[
            { code: "fi", label: "Suomi" },
            { code: "en", label: "English" },
          ]}
          onLanguage={onLanguage}
          pages={[
            { id: "a", label: "A", render: () => <p>first</p> },
            { id: "b", label: "B", render: () => <p>second</p> },
          ]}
        />
      </JcProvider>,
    );
    fireEvent.change(screen.getByLabelText("Kieli"), { target: { value: "en" } });
    expect(onLanguage).toHaveBeenCalledWith("en");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Sivut" })).getByRole("button", { name: "B" }));
    expect(screen.getByText("second")).toBeInTheDocument();
  });
});

describe("the entity panel (SDK-40)", () => {
  it("opens from a map feature by click and by Enter, from a table row and from a chart point", async () => {
    show(READ);
    fireEvent.click(screen.getByTestId("map-feature"));
    expect(await screen.findByRole("dialog", { name: "Kaivopuisto" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(screen.getByTestId("map-feature"), { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "Kaivopuisto" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "chart point Kaivopuisto" }));
    const panel = await screen.findByRole("dialog", { name: "Kaivopuisto" });
    // The attributes with their labels, in the schema's order.
    expect(within(panel).getByText("Available bike number")).toBeInTheDocument();
    expect(within(panel).getByText("4")).toBeInTheDocument();
  });

  it("closes on Escape and gives the focus back to what opened it", async () => {
    show(READ);
    const opener = screen.getByRole("button", { name: "Kaivopuisto row" });
    opener.focus();
    fireEvent.click(opener);
    const panel = await screen.findByRole("dialog", { name: "Kaivopuisto" });
    await waitFor(() => expect(within(panel).getByRole("heading", { name: "Kaivopuisto" })).toHaveFocus());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("offers no Edit without the write right, and links to the entity in the Portal instead", async () => {
    show(READ);
    const panel = await openFromTable();
    await within(panel).findByText("Available bike number");
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
    const link = within(panel).getByRole("link", { name: "Open in the Portal" });
    expect(link).toHaveAttribute("href", `${PORTAL}/explore?space=demo&entityId=${encodeURIComponent(STATION.id)}`);
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("offers no Edit to an anonymous reader even where the access document would allow it", async () => {
    show(WRITE, { user: null });
    const panel = await openFromTable();
    await within(panel).findByText("Available bike number");
    expect(within(panel).queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("checks the change, shows it, and writes it only after the reader confirms", async () => {
    const client = show(WRITE);
    const panel = await openFromTable();
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
    // A geometry is the Portal's: shown, not an input.
    expect(within(panel).getByText(/edited in the Portal/)).toBeInTheDocument();

    fireEvent.change(within(panel).getByLabelText("Available bike number"), { target: { value: "99" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Review the change" }));
    expect(within(panel).getByText("At most 40.")).toBeInTheDocument();
    expect(client.transport.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);

    fireEvent.change(within(panel).getByLabelText("Available bike number"), { target: { value: "7" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Review the change" }));
    expect(within(panel).getByText("Available bike number: 4 → 7")).toBeInTheDocument();
    expect(client.transport.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Save the change" }));
    });
    const patches = client.transport.calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toContain(`/entities/${encodeURIComponent(STATION.id)}/attrs`);
    expect(patches[0].body).toEqual({ availableBikeNumber: { type: "Property", value: 7 } });
    expect(await within(panel).findByText("Saved.")).toBeInTheDocument();
  });

  it("says nothing changed when nothing did, and writes nothing", async () => {
    const client = show(WRITE);
    const panel = await openFromTable();
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
    fireEvent.click(within(panel).getByRole("button", { name: "Review the change" }));
    expect(within(panel).getByText("Nothing changed.")).toBeInTheDocument();
    expect(client.transport.calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("says a conflict and a refusal in words", async () => {
    let answer = 409;
    show(WRITE, {}, (_path, method) =>
      method === "PATCH" ? { status: answer, body: { title: answer === 409 ? "Conflict" : "Forbidden", detail: answer === 403 ? "no write on availableBikeNumber" : undefined } } : null,
    );
    const panel = await openFromTable();
    fireEvent.click(await within(panel).findByRole("button", { name: "Edit" }));
    fireEvent.change(within(panel).getByLabelText("Available bike number"), { target: { value: "5" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Review the change" }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Save the change" }));
    });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Someone changed this entity meanwhile");

    answer = 403;
    fireEvent.click(within(panel).getByRole("button", { name: "Review the change" }));
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Save the change" }));
    });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("You may not change this entity: no write on availableBikeNumber");
  });

  it("is axe clean, open and in its edit form", async () => {
    show(WRITE);
    const panel = await openFromTable();
    await within(panel).findByText("Available bike number");
    expect((await axe.run(panel)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    fireEvent.click(within(panel).getByRole("button", { name: "Edit" }));
    expect((await axe.run(panel)).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });

  it("speaks the App's language", async () => {
    show(READ, { language: "fi" });
    const panel = await openFromTable();
    expect(await within(panel).findByRole("link", { name: "Avaa portaalissa" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Sulje" })).toBeInTheDocument();
  });

  it("says an entity that is gone", async () => {
    show(READ, {}, (path, method) => (method === "GET" && path.includes("/entities/urn") ? { status: 404, body: { title: "Not Found" } } : null));
    fireEvent.click(screen.getByRole("button", { name: "Kaivopuisto row" }));
    // Unread, the panel is named by the id's local part.
    const panel = await screen.findByRole("dialog", { name: "001" });
    expect(await within(panel).findByText("This entity is no longer there.")).toBeInTheDocument();
  });
});

describe("the entity panel's failed read", () => {
  it("says a read that failed, and reads again on Retry", async () => {
    let failing = true;
    show(READ, {}, (path, method) => (failing && method === "GET" && path.includes("/entities/urn") ? { status: 502, body: { title: "Bad Gateway", detail: "The broker did not answer." } } : null));
    fireEvent.click(screen.getByRole("button", { name: "Kaivopuisto row" }));
    const panel = await screen.findByRole("dialog", { name: "001" });
    expect(await within(panel).findByRole("alert")).toHaveTextContent("The broker did not answer.");
    failing = false;
    fireEvent.click(within(panel).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("dialog", { name: "Kaivopuisto" })).toBeInTheDocument();
  });
});

describe("the panel's pieces", () => {
  const number: Field = { name: "n", input: "number", min: 0, max: 40, required: false };
  it("checks a value against the schema", () => {
    expect(parseValue(number, "12,5", "en")).toEqual({ value: 12.5 });
    expect(parseValue(number, "abc", "en")).toEqual({ error: "Enter a number." });
    expect(parseValue(number, "-1", "sk")).toEqual({ error: "Najmenej 0." });
    expect(parseValue(number, "", "en")).toEqual({ value: null });
    expect(parseValue({ ...number, required: true }, " ", "cs")).toEqual({ error: "Povinné." });
    const status: Field = { name: "s", input: "select", options: [{ value: "working" }, { value: "outOfService" }], required: false };
    expect(parseValue(status, "broken", "en")).toEqual({ error: "One of: working, outOfService." });
    expect(parseValue({ name: "c", input: "text", pattern: "[0-9]{3}", required: false }, "12a", "en")).toEqual({ error: "Not in the expected form." });
  });

  it("links to the Portal only with a portal address, the id escaped", () => {
    expect(portalLinkOf(undefined, "s", "urn:x")).toBeNull();
    expect(portalLinkOf(PORTAL, "helsinki", "urn:ngsi-ld:T:a&b")).toBe(`${PORTAL}/explore?space=helsinki&entityId=urn%3Angsi-ld%3AT%3Aa%26b`);
  });

  it("takes a portal address only as https://{host}/projects/{project}", () => {
    const base = { slug: "s1", orgDomain: "hel.fi", space: "helsinki", transport: "bridge" };
    expect(parseConfig({ ...base, portal: PORTAL }).portal).toBe(PORTAL);
    expect(parseConfig({ ...base, portal: "https://dev.example.org/portal/projects/x" }).portal).toBe("https://dev.example.org/portal/projects/x");
    for (const bad of ["http://portal/projects/x", "javascript:alert(1)//projects/x", "https://portal/projects/x?y=1", "https://portal/admin"]) {
      expect(() => parseConfig({ ...base, portal: bad })).toThrow(/portal:/);
    }
  });

  it("speaks four languages with the same words and placeholders", () => {
    const keys = Object.keys(SDK_WORDS.en).sort();
    for (const language of ["fi", "sk", "cs"] as const) {
      expect(Object.keys(SDK_WORDS[language]).sort()).toEqual(keys);
      for (const key of keys) {
        const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
        const word = key as keyof typeof SDK_WORDS.en;
        expect(placeholders(SDK_WORDS[language][word]), `${language} ${key}`).toEqual(placeholders(SDK_WORDS.en[word]));
        expect(SDK_WORDS[language][word].trim()).not.toBe("");
      }
    }
  });

  it("keeps a ProblemError's status for the panel to word", () => {
    expect(new ProblemError(409, { title: "Conflict" }).status).toBe(409);
  });
});
