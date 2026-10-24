/** T-0529: the explorer's "Your access" panel from the endpoint's AuthZEN surfaces (UI-33, R51, R17). */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";
import cs from "../src/locales/cs.json";
import de from "../src/locales/de.json";
import { App } from "../src/App";
import { CHECKED_ACTIONS, deniedAttributes, editableAttributes } from "../src/components/entities/AccessPanel";

const IDENTITY = { subject: "b7c1e0f4", username: "demo.viewer", name: "Demo Viewer", roles: [] };
const list = (items: unknown[]) => ({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items });

const MODEL = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "DataModel",
  metadata: { name: "bikes", namespace: "helsinki" },
  spec: {
    version: "1.0.0",
    classes: ["BikeHireDockingStation"],
    linkml: [
      "id: https://hel.fi/models/bikes",
      "name: bikes",
      "classes:",
      "  BikeHireDockingStation:",
      "    slots: [id, availableBikeNumber, name, location]",
      "slots:",
      "  id: {}",
      "  availableBikeNumber: { range: integer }",
      "  name: { range: string }",
      "  location: { range: string }",
      "",
    ].join("\n"),
  },
};
const SPACES = list([
  { apiVersion: "joinedcontext.com/v1alpha1", kind: "ContextSpace", metadata: { name: "mobility", namespace: "helsinki" }, spec: { dataModelRef: "bikes" } },
]);
const ENDPOINTS = list([
  {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Endpoint",
    metadata: { name: "helsinki-bikes", namespace: "helsinki" },
    spec: { contextSpaceRef: "mobility", slug: "scsd2eehkx42n53z2zyd6vshfh7s7irf", audience: "public" },
  },
]);
/** The public grant on the bikes endpoint: reads only, two attributes, never the location. */
const GRANTS = {
  subject: { type: "role", id: "public" },
  resource: { type: "endpoint", id: "scsd2eehkx42n53z2zyd6vshfh7s7irf", space: "helsinki" },
  permissions: [
    {
      resource: { type: "BikeHireDockingStation" },
      actions: ["retrieveEntity", "queryEntity"],
      attributes: ["availableBikeNumber", "name", "location"],
      constraints: { scopeQ: "/helsinki/#" },
    },
  ],
  prohibitions: [{ resource: { type: "BikeHireDockingStation" }, actions: ["queryEntity"], attributes: ["location"], constraints: {} }],
};

function renderExplore() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
    if (url.pathname.endsWith("/auth/me")) return json(IDENTITY);
    if (url.pathname.endsWith("/access/check")) {
      return request
        .clone()
        .json()
        .then((body: { action: { name: string } }) => json({ decision: body.action.name === "queryEntity" }));
    }
    if (url.pathname.endsWith("/access")) return json(GRANTS);
    if (url.pathname.includes("/ngsi-ld/v1/entities")) return json([]);
    if (url.pathname.endsWith("/spaces")) return json(SPACES);
    if (url.pathname.endsWith("/endpoints")) return json(ENDPOINTS);
    if (url.pathname.endsWith("/datamodels")) return json(list([MODEL]));
    return json(list([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

describe("your access in the explorer", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.pushState({}, "", "/projects/helsinki/explore");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the grant and the dry-run decisions, and disables a denied attribute with the reason", async () => {
    const fetchMock = renderExplore();
    await screen.findByRole("option", { name: "mobility" });
    await userEvent.selectOptions(screen.getByLabelText(en.explore.space), "mobility");
    const panel = await screen.findByRole("region", { name: en.access.panel.title });
    expect(within(panel).getByText(en.access.panel.chooseType)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(en.entities.type), "BikeHireDockingStation");
    expect(await within(panel).findByText(/retrieveEntity, queryEntity/)).toBeInTheDocument();
    expect(within(panel).getByText(/scopeQ=\/helsinki\/#/)).toBeInTheDocument();
    // One check per action, with the user's session, answered before the query runs.
    expect(await within(panel).findByText("You may read BikeHireDockingStation")).toBeInTheDocument();
    expect(within(panel).getByText("You may not change BikeHireDockingStation")).toBeInTheDocument();
    // T-4264: the operation names wait behind the disclosure, closed.
    expect(within(panel).getByText(/retrieveEntity, queryEntity/).closest("details")).not.toHaveAttribute("open");
    const checks = fetchMock.mock.calls
      .map((call) => call[0] as Request)
      .filter((request) => request instanceof Request && request.url.endsWith("/access/check"));
    expect(checks).toHaveLength(2);
    expect(checks[0].credentials).toBe("same-origin");

    // The prohibited attribute cannot be asked for, and the reason travels with it. Since
    // T-1756 `Checkbox` carries `disabledReason` the way `Button` does: the reason is a
    // *description* beside the box rather than part of its name, and the box is `aria-disabled`
    // so a keyboard can still land on it and be told why (UI-44).
    const location = screen.getByRole("checkbox", { name: "location" });
    expect(location).toHaveAttribute("aria-disabled", "true");
    expect(location).toHaveAccessibleDescription(en.access.panel.attrProhibited);
    expect(screen.getByRole("checkbox", { name: "name" })).toBeEnabled();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "availableBikeNumber" })).toBeEnabled());
  });

  /// T-1142, EP-55: a document covers several types at once, and a prohibition takes back what
  /// a permission gave. What the panel greys out is per type, never the union of everything.
  it("reads one type's denials without the other type's grant leaking into them", () => {
    const t = (key: string) => key;
    const slots = [
      { name: "speed", kind: "Property" as const },
      { name: "plate", kind: "Property" as const },
    ];
    const document = {
      permissions: [
        { resource: { type: "Vehicle" }, attributes: ["speed"] },
        { resource: { type: "AirQualityObserved" }, attributes: ["pm10", "pm25"] },
      ],
    };

    expect(deniedAttributes(document, "Vehicle", slots, t)).toEqual({
      plate: "access.panel.attrDenied",
    });
    // The other type's grant names neither slot, so both are outside it.
    expect(deniedAttributes(document, "AirQualityObserved", slots, t)).toEqual({
      speed: "access.panel.attrDenied",
      plate: "access.panel.attrDenied",
    });
  });

  /// T-5585 (critic T-5522): a prohibition of a write leaves the read alone, and the cells
  /// offered for editing are the ones the gateway accepts: none while a write prohibition covers
  /// the type, because pdp/evaluator.rs refuses every write such a prohibition covers.
  it("keeps a write-only prohibition out of the reads and offers no edit the gateway refuses", () => {
    const t = (key: string) => key;
    const slots = ["name", "level", "status", "ownerEmail", "note"].map((name) => ({
      name,
      kind: "Property" as const,
    }));
    const reads = ["queryEntity", "retrieveEntity"];
    const editor = {
      permissions: [
        { resource: { type: "Sensor" }, actions: reads, attributes: ["name", "level", "status", "note"] },
        { resource: { type: "Sensor" }, actions: ["updateAttrs"], attributes: ["level", "note"] },
      ],
      prohibitions: [{ resource: { type: "Sensor" }, actions: ["updateAttrs"], attributes: ["status"] }],
    };
    const editorDenied = deniedAttributes(editor, "Sensor", slots, t);
    expect(editorDenied).toEqual({ ownerEmail: "access.panel.attrDenied" });
    expect(editableAttributes(editor, "Sensor", slots, editorDenied)).toEqual([]);

    // Without the prohibition the write grant's own list decides, and the read list does not widen it.
    const unprohibited = { permissions: editor.permissions };
    expect(editableAttributes(unprohibited, "Sensor", slots, editorDenied)).toEqual(["level", "note"]);

    // A write-only grant reads nothing: `note` stays hidden from a person granted only to set it.
    const writer = {
      permissions: [
        { resource: { type: "Sensor" }, actions: reads, attributes: ["name"] },
        { resource: { type: "Sensor" }, actions: ["updateAttrs"], attributes: ["note"] },
      ],
    };
    expect(Object.keys(deniedAttributes(writer, "Sensor", slots, t))).toEqual(["level", "status", "ownerEmail", "note"]);

    // A read prohibition still hides, and a prohibition naming no action covers every action.
    const hidden = {
      permissions: [{ resource: { type: "Sensor" }, actions: reads }],
      prohibitions: [{ resource: { type: "Sensor" }, actions: ["queryEntity"], attributes: ["ownerEmail"] }],
    };
    expect(deniedAttributes(hidden, "Sensor", slots, t)).toEqual({ ownerEmail: "access.panel.attrProhibited" });
    const everything = { ...unprohibited, prohibitions: [{ resource: { type: "Sensor" }, attributes: ["status"] }] };
    expect(deniedAttributes(everything, "Sensor", slots, t).status).toBe("access.panel.attrProhibited");
    expect(editableAttributes(everything, "Sensor", slots, {})).toEqual([]);

    // A person of another organization holds no grant: nothing is greyed and nothing is editable.
    expect(deniedAttributes({}, "Sensor", slots, t)).toEqual({});
    expect(editableAttributes({}, "Sensor", slots, {})).toEqual([]);
  });

  it("names a prohibited attribute as prohibited, even where a permission granted it", () => {
    const t = (key: string) => key;
    const slots = [
      { name: "pm10", kind: "Property" as const },
      { name: "pm25", kind: "Property" as const },
    ];
    const document = {
      permissions: [{ resource: { type: "AirQualityObserved" }, attributes: ["pm10", "pm25"] }],
      prohibitions: [{ resource: { type: "AirQualityObserved" }, attributes: ["pm25"] }],
    };

    expect(deniedAttributes(document, "AirQualityObserved", slots, t)).toEqual({
      pm25: "access.panel.attrProhibited",
    });
  });

  it("takes a grant over every type as covering this one, and a prohibition over every type too", () => {
    const t = (key: string) => key;
    const slots = [{ name: "speed", kind: "Property" as const }];
    expect(
      deniedAttributes({ permissions: [{ resource: { type: "*" }, attributes: ["speed"] }] }, "Vehicle", slots, t),
    ).toEqual({});
    expect(
      deniedAttributes(
        {
          permissions: [{ resource: { type: "*" }, attributes: "*" }],
          prohibitions: [{ resource: { type: "*" }, attributes: ["speed"] }],
        },
        "Vehicle",
        slots,
        t,
      ),
    ).toEqual({ speed: "access.panel.attrProhibited" });
  });

  /// A document that grants nothing for this type greys nothing out, because the panel says
  /// which attribute a grant leaves out and there is no grant to be outside of: the read
  /// itself answers empty, and the access document above the table is what says why (EP-55).
  it("greys nothing out when no permission covers the type at all", () => {
    const t = (key: string) => key;
    const slots = [{ name: "speed", kind: "Property" as const }];
    expect(deniedAttributes({ permissions: [] }, "Vehicle", slots, t)).toEqual({});
    expect(deniedAttributes({}, "Vehicle", slots, t)).toEqual({});
    expect(deniedAttributes({ permissions: [{ resource: { type: "Other" } }] }, "Vehicle", slots, t)).toEqual({});
  });

  it("denies what is outside the grant's attribute list and nothing under a wildcard grant", () => {
    const t = (key: string) => key;
    const slots = [
      { name: "a", kind: "Property" as const },
      { name: "b", kind: "Property" as const },
    ];
    expect(deniedAttributes({ permissions: [{ resource: { type: "T" }, attributes: ["a"] }] }, "T", slots, t)).toEqual({
      b: "access.panel.attrDenied",
    });
    expect(deniedAttributes({ permissions: [{ resource: { type: "T" }, attributes: "*" }] }, "T", slots, t)).toEqual({});
    expect(deniedAttributes({ permissions: [{ resource: { type: "Other" }, attributes: ["a"] }] }, "T", slots, t)).toEqual({});
    expect(deniedAttributes(undefined, "T", slots, t)).toEqual({});
  });
});

/// T-4264, T-4160 #18: every action the panel checks is a word in each language, never the
/// operation name, which the Slovak page used to show as "Smiete queryEntity".
describe("the checked actions in words", () => {
  it("names each checked action in every catalogue", () => {
    for (const catalogue of [en, sk, cs, de]) {
      for (const action of CHECKED_ACTIONS) {
        const word = (catalogue.access.panel.actions as Record<string, string>)[action];
        expect(word, action).toBeTruthy();
        expect(word).not.toBe(action);
      }
    }
  });
});
