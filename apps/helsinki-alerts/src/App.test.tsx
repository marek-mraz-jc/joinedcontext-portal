import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import type { AccessDocument, JcUser } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { ALERTS } from "./fixtures/alerts";
import { STEWARD, VIEWER } from "./fixtures/access";
import { SCHEMA } from "./fixtures/schema";

vi.mock("maplibre-gl", () => ({
  Map: class {
    on = vi.fn();
    remove = vi.fn();
  },
  setWorkerUrl: vi.fn(),
}));
vi.mock("@deck.gl/mapbox", () => ({ MapboxOverlay: class {} }));
vi.mock("@deck.gl/layers", () => ({ ScatterplotLayer: class {} }));
vi.mock("@deck.gl/aggregation-layers", () => ({ HexagonLayer: class {}, GridLayer: class {} }));

const PERSON: Record<string, JcUser> = {
  viewer: { id: "v1", name: "Demo Viewer", roles: ["viewer"] },
  steward: { id: "s1", name: "Demo Steward", roles: ["steward"] },
};

function app(access: AccessDocument, user: JcUser, entities = ALERTS) {
  const client = stubClient(
    {
      entities,
      schema: SCHEMA,
      access,
      functions: {
        summary: () => ({ total: entities.length, byCategory: { traffic: 4, event: 1 }, bySubCategory: { ROAD_WORK: 3 }, oldestOpen: null }),
      },
    },
    { appName: "helsinki-alerts", orgDomain: "hel.fi", space: "helsinki", user },
  );
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return client;
}

async function openAlert(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Alerts" }));
  const page = screen.getByRole("region", { name: "Alerts" });
  const table = await within(page).findByRole("table");
  fireEvent.click(await within(table).findByText(name));
  return page;
}

const writes = (client: ReturnType<typeof stubClient>) => client.transport.calls.filter((call) => call.method !== "GET" && !call.path.includes("/functions/"));

describe("helsinki-alerts", () => {
  beforeEach(() => {
    window.location.hash = "";
  });

  // AP-40, SDK-01: the overview counts the rows and shows the summary function's answer.
  it("opens on the overview with the count and the server summary, read through the app's endpoint", async () => {
    const client = app(VIEWER, PERSON.viewer);
    const overview = await screen.findByRole("region", { name: "Overview" });
    const tile = within(overview).getByText("Alerts").closest(".jc-tile") as HTMLElement;
    await waitFor(() => expect(within(tile).getByText("5")).toBeInTheDocument());
    expect(await within(overview).findByText("traffic: 4")).toBeInTheDocument();
    expect(within(overview).queryByText(/Alerts stewards added/)).not.toBeInTheDocument();
    // AP-04: every call went to the app's own endpoint.
    expect(client.transport.calls.every((call) => call.path.includes("/api/endpoint/") || call.path.startsWith("/functions/"))).toBe(true);
  });

  // AP-07: category and subCategory filter the table (the model has no severity).
  it("filters the alerts by category and subCategory", async () => {
    app(VIEWER, PERSON.viewer);
    fireEvent.click(await screen.findByRole("button", { name: "Alerts" }));
    const page = screen.getByRole("region", { name: "Alerts" });
    const table = await within(page).findByRole("table");
    expect(await within(table).findByText("Accident on Itäväylä")).toBeInTheDocument();

    fireEvent.change(within(page).getByRole("combobox", { name: "Subcategory" }), { target: { value: "TRAFFIC_ANNOUNCEMENT" } });
    await waitFor(() => expect(within(table).queryByText("Mannerheimintie resurfacing")).not.toBeInTheDocument());
    expect(within(table).getByText("Accident on Itäväylä")).toBeInTheDocument();
  });

  // AP-09, AP-96: a viewer gets no New, Edit or Delete; the gateway would refuse them anyway.
  it("offers a viewer no form, no edit and no delete", async () => {
    const client = app(VIEWER, PERSON.viewer);
    const page = await openAlert("Kauppatori, Helsinki");
    expect(within(page).getByRole("heading", { level: 2, name: /steward-market-day|Kauppatori/ })).toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "New alert" })).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(page).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(writes(client)).toEqual([]);
  });

  // AP-62: the steward's correction is one PATCH carrying the changed attribute and nothing else.
  it("lets a steward correct an alert with one PATCH of the changed attribute", async () => {
    const client = app(STEWARD, PERSON.steward);
    const page = await openAlert("Mannerheimintie resurfacing");
    expect(within(page).queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    fireEvent.click(within(page).getByRole("button", { name: "Edit" }));
    const form = within(page).getByRole("form", { name: "Edit Alert" });
    // Every writable field and none of the read-only ones.
    expect(within(form).getAllByRole("textbox").length + within(form).queryAllByRole("combobox").length).toBeGreaterThan(0);
    expect(within(form).queryByLabelText("source")).not.toBeInTheDocument();
    // T-2628: name is edited language by language, the stored Finnish one included.
    expect(await within(form).findByLabelText("name (fi)")).toHaveValue("Mannerheimintien päällystys");
    expect(within(page).getByText(/source: where Fintraffic published it/)).toBeInTheDocument();

    fireEvent.change(within(form).getByLabelText("address"), { target: { value: "Mannerheimintie 14, Helsinki" } });
    // Save stays disabled until the endpoint's access document says the steward may write.
    await waitFor(() => expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes(client)).toHaveLength(1));
    const [patch] = writes(client);
    expect(patch.method).toBe("PATCH");
    expect(patch.path).toContain(encodeURIComponent("urn:ngsi-ld:Alert:hel.fi:helsinki:GUID50001"));
    expect(patch.body).toEqual({ address: { type: "Property", value: "Mannerheimintie 14, Helsinki" } });
  });

  // SDK-07, T-2628: correcting the English name keeps the Finnish one, in the same one PATCH.
  it("lets a steward correct one language of the name and keeps the others", async () => {
    const client = app(STEWARD, PERSON.steward);
    const page = await openAlert("Mannerheimintie resurfacing");
    fireEvent.click(within(page).getByRole("button", { name: "Edit" }));
    const form = within(page).getByRole("form", { name: "Edit Alert" });
    fireEvent.change(await within(form).findByLabelText("name (en)"), { target: { value: "Mannerheimintie repaving" } });
    await waitFor(() => expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes(client)).toHaveLength(1));
    expect(writes(client)[0].body).toEqual({
      name: { type: "LanguageProperty", languageMap: { fi: "Mannerheimintien päällystys", en: "Mannerheimintie repaving" } },
    });
  });

  // AP-09: a new alert carries no source, which is what lets the steward remove it later.
  it("lets a steward add an alert with one POST that carries no source", async () => {
    const client = app(STEWARD, PERSON.steward);
    fireEvent.click(await screen.findByRole("button", { name: "Alerts" }));
    const page = screen.getByRole("region", { name: "Alerts" });
    fireEvent.click(await within(page).findByRole("button", { name: "New alert" }));
    const form = within(page).getByRole("form", { name: "New alert" });
    fireEvent.change(within(form).getByLabelText("Local id"), { target: { value: "steward-closure" } });
    fireEvent.change(within(form).getByLabelText("address"), { target: { value: "Senaatintori, Helsinki" } });
    fireEvent.change(within(form).getByLabelText("category"), { target: { value: "event" } });
    // Save stays disabled until the endpoint's access document says the steward may write.
    await waitFor(() => expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes(client)).toHaveLength(1));
    const [post] = writes(client);
    expect(post.method).toBe("POST");
    const body = post.body as Record<string, unknown>;
    expect(body.id).toBe("urn:ngsi-ld:Alert:hel.fi:helsinki:steward-closure");
    expect(body).not.toHaveProperty("source");
    expect(Object.keys(body).sort()).toEqual(["address", "category", "id", "type"]);
  });

  // AP-09: Delete is offered on an alert a steward added, never on Fintraffic's.
  it("lets a steward delete an alert a steward added, after confirming", async () => {
    const client = app(STEWARD, PERSON.steward);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const page = await openAlert("Kauppatori, Helsinki");
    fireEvent.click(within(page).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(writes(client)).toHaveLength(1));
    expect(confirm).toHaveBeenCalledOnce();
    expect(writes(client)[0].method).toBe("DELETE");
    expect(writes(client)[0].path).toContain(encodeURIComponent("urn:ngsi-ld:Alert:hel.fi:helsinki:steward-market-day"));
    confirm.mockRestore();
  });

  it("sends nothing when the steward cancels the delete", async () => {
    const client = app(STEWARD, PERSON.steward);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const page = await openAlert("Kauppatori, Helsinki");
    fireEvent.click(within(page).getByRole("button", { name: "Delete" }));
    expect(writes(client)).toEqual([]);
    confirm.mockRestore();
  });

  it("says so when there is no alert at all", async () => {
    app(VIEWER, PERSON.viewer, []);
    fireEvent.click(await screen.findByRole("button", { name: "Alerts" }));
    const page = screen.getByRole("region", { name: "Alerts" });
    expect(await within(page).findByText("No alert matches.")).toBeInTheDocument();
  });
});
