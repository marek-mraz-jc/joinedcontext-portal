import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { GrafanaPage, SavedVisualization, VisualizationForm, VisualizationPreview, notReachable } from "../src/pages/grafana/GrafanaPage";
import i18n from "../src/i18n";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: ReactNode }) => (
    <a href={to.replace(/\$(\w+)/g, (_, key: string) => params?.[key] ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

const options = {
  endpoints: [
    { name: "air", title: "Air quality", slug: "airslug", public: true, usable: true },
    { name: "ops", title: "Bike operations", slug: "opsslug", public: false, usable: false },
  ],
  types: ["AirQualityObserved"],
  attributes: [
    { name: "pm25", kinds: ["timeseries", "stat", "table"] },
    { name: "location", kinds: ["table", "map"] },
  ],
};

type Answer = { status?: number; body: unknown };
let answers: Record<string, Answer>;
let sent: { method: string; url: string; body?: unknown }[];

beforeEach(() => {
  sent = [];
  answers = {
    "GET /api/v1/projects/helsinki/grafana": {
      body: { ready: true, mayCreate: true, items: [] },
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string) => {
      const request = input instanceof Request ? input : new Request(new URL(input, "http://portal"));
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.clone().text();
      sent.push({ method: request.method, url: url.pathname + url.search, body: text ? JSON.parse(text) : undefined });
      const key = `${request.method} ${url.pathname}`;
      const rows: Answer | undefined = url.pathname.startsWith("/api/endpoint/") ? {
        body: [{
          id: "urn:ngsi-ld:A:one",
          type: "A",
          name: { type: "Property", value: "Kallio" },
          pm25: { type: "Property", value: 4.2, unitCode: "GQ", observedAt: "2026-11-05T09:30:00Z" },
        }],
      } : undefined;
      const answer = answers[key] ?? rows ?? (key.endsWith("/grafana/options") ? { body: options } : undefined);
      if (!answer) return new Response("{}", { status: 404 });
      if (answer.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function renderInClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const item = {
  id: "ab12",
  title: "PM2.5",
  endpoint: "air",
  endpointTitle: "Air quality",
  type: "AirQualityObserved",
  attribute: "pm25",
  kind: "timeseries" as const,
  createdAt: "2026-11-02T00:00:00Z",
  openUrl: "https://dev.example/grafana/d/pv-ab12?orgId=2",
};

async function fill() {
  const user = userEvent.setup();
  await screen.findByRole("option", { name: "Air quality" });
  await user.selectOptions(screen.getByLabelText("Endpoint"), "air");
  await waitFor(() => expect(screen.getByLabelText("Type")).toBeEnabled());
  await user.selectOptions(screen.getByLabelText("Type"), "AirQualityObserved");
  await waitFor(() => expect(screen.getByLabelText("Attribute")).toBeEnabled());
  return user;
}

async function saveFilled() {
  const user = await fill();
  await user.selectOptions(screen.getByLabelText("Attribute"), "pm25");
  await user.type(screen.getByLabelText("Name"), "x");
  await user.click(screen.getByRole("button", { name: /save to grafana/i }));
  return user;
}

describe("the Grafana page", () => {
  it("tells a person outside the project that they may not open it", async () => {
    answers["GET /api/v1/projects/helsinki/grafana"] = {
      status: 403,
      body: { status: 403, title: "Forbidden", detail: "you are not a member of helsinki" },
    };
    renderInClient(<GrafanaPage project="helsinki" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Grafana" })).toBeInTheDocument();
    expect(await screen.findByText("You may not open Grafana in this project")).toBeInTheDocument();
    expect(screen.getByText(/You are not a member of helsinki\./)).toHaveTextContent("A project owner or an organization administrator");
    expect(screen.queryByLabelText("Endpoint")).toBeNull();
    expect(screen.getByRole("link", { name: "Go to your projects" })).toHaveAttribute("href", "/");
  });

  it("says why when Grafana is not ready and offers no form", async () => {
    answers["GET /api/v1/projects/helsinki/grafana"] = {
      body: { ready: false, reason: "Grafana is not set up", mayCreate: true, items: [] },
    };
    renderInClient(<GrafanaPage project="helsinki" />);
    expect(await screen.findByText("Grafana is not set up.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the project" })).toHaveAttribute("href", "/projects/helsinki/home");
    expect(screen.queryByRole("button", { name: /save to grafana/i })).toBeNull();
  });

  it("shows a reader what is saved, without the form or a remove button", async () => {
    answers["GET /api/v1/projects/helsinki/grafana"] = {
      body: { ready: true, mayCreate: false, items: [item] },
    };
    renderInClient(<GrafanaPage project="helsinki" />);
    expect(await screen.findByRole("link", { name: "Open PM2.5 in Grafana" })).toHaveAttribute("href", item.openUrl);
    expect(screen.queryByLabelText("Endpoint")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove PM2.5" })).toBeNull();
  });

  it("tells what to do next on an empty list", async () => {
    renderInClient(<GrafanaPage project="helsinki" />);
    expect(await screen.findByText("Nothing saved yet")).toBeInTheDocument();
  });
});

describe("the form", () => {
  it("offers what the server offers, names what Grafana cannot read, and previews the choice", async () => {
    renderInClient(<VisualizationForm project="helsinki" />);
    await fill();
    expect(screen.getByRole("option", { name: "Air quality" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Air quality observed" })).toHaveValue("AirQualityObserved");
    expect(screen.getByRole("option", { name: "PM2.5" })).toHaveValue("pm25");
    expect(screen.queryByRole("option", { name: "Bike operations" })).toBeNull();
    expect(screen.getByText(/Not in Grafana yet: Bike operations/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Attribute"), "pm25");
    expect(await screen.findByText("Kallio")).toBeInTheDocument();
    expect(screen.getByText("4.2 µg/m³")).toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute("dateTime", "2026-11-05T09:30:00Z");
    const read = sent.find((call) => call.url.startsWith("/api/endpoint/airslug/"))?.url;
    expect(read).toContain("attrs=name%2Cpm25");
    expect(read).not.toContain("keyValues");
    expect(screen.queryByText(/The preview could not read these rows/)).toBeNull();
  });

  it("warns beside Save when the preview may not read the rows, and still lets the person save", async () => {
    answers["GET /api/endpoint/airslug/ngsi-ld/v1/entities"] = {
      status: 403,
      body: { status: 403, title: "Forbidden", detail: "not yours" },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    const user = await fill();
    await user.selectOptions(screen.getByLabelText("Attribute"), "pm25");
    await user.type(screen.getByLabelText("Name"), "x");
    expect(await screen.findByText("The preview could not read these rows; the dashboard may be empty for you.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save to grafana/i })).not.toHaveAttribute("aria-disabled", "true");
    expect(sent.filter((call) => call.url.startsWith("/api/endpoint/airslug/"))).toHaveLength(1);
  });

  it("adds a refused Endpoint to the line of Endpoints Grafana cannot read yet", async () => {
    answers["POST /api/v1/projects/helsinki/grafana"] = {
      status: 422,
      body: {
        status: 422,
        title: "Unprocessable",
        detail: "Grafana cannot read the private Endpoint Air quality yet",
        errors: [{ path: "endpoint", message: "Grafana cannot read the private Endpoint Air quality yet; ask your operator to add it to this project's Grafana, or choose another" }],
      },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    await saveFilled();
    expect(await screen.findByText(/Grafana cannot read the private Endpoint Air quality yet; .*choose another\./)).toBeInTheDocument();
    expect(screen.getByText(/Not in Grafana yet: Bike operations, Air quality/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Air quality (not in Grafana yet)" })).toBeInTheDocument();
    expect(await screen.findByText(/Grafana cannot read this Endpoint yet, so it would draw none of them/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /save to grafana/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(screen.getByLabelText("Name"), "y");
    expect(button).not.toHaveAttribute("aria-disabled", "true");
  });

  it("says beside a disabled Save what is missing", async () => {
    renderInClient(<VisualizationForm project="helsinki" />);
    await fill();
    expect(screen.getByRole("button", { name: /save to grafana/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Next, choose an attribute.").some((node) => !node.classList.contains("sr-only"))).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText("Attribute"), "pm25");
    expect(screen.getAllByText("Last, give it a name.").some((node) => !node.classList.contains("sr-only"))).toBe(true);
  });

  it("offers a retry beside Save when the preview failed for a reason other than a refusal", async () => {
    answers["GET /api/endpoint/airslug/ngsi-ld/v1/entities"] = {
      status: 503,
      body: { status: 503, title: "Unavailable", detail: "the broker is busy" },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    const user = await fill();
    await user.selectOptions(screen.getByLabelText("Attribute"), "pm25");
    await user.type(screen.getByLabelText("Name"), "x");
    expect(await screen.findByText("The preview could not be read just now; the dashboard itself may still draw.")).toBeInTheDocument();
    delete answers["GET /api/endpoint/airslug/ngsi-ld/v1/entities"];
    const [beside] = screen.getAllByRole("button", { name: "Try again" });
    await user.click(beside);
    await waitFor(() => expect(screen.queryByText(/could not be read just now/)).toBeNull());
  });

  it("keeps the kind to what the attribute can draw", async () => {
    renderInClient(<VisualizationForm project="helsinki" />);
    const user = await fill();
    await user.selectOptions(screen.getByLabelText("Attribute"), "location");
    expect(screen.getByLabelText("Visualization")).toHaveValue("table");
    expect(screen.queryByRole("option", { name: "Time series" })).toBeNull();
    expect(screen.getByRole("option", { name: "Map" })).toBeInTheDocument();
  });

  it("saves the choices and gives the link to open them", async () => {
    answers["POST /api/v1/projects/helsinki/grafana"] = { status: 201, body: item };
    renderInClient(<VisualizationForm project="helsinki" />);
    const user = await fill();
    await user.selectOptions(screen.getByLabelText("Attribute"), "pm25");
    expect(screen.getByRole("button", { name: /save to grafana/i })).toHaveAttribute("aria-disabled", "true");
    await user.type(screen.getByLabelText("Name"), "PM2.5");
    await user.click(screen.getByRole("button", { name: /save to grafana/i }));
    expect(await screen.findByRole("link", { name: "Open it" })).toHaveAttribute("href", item.openUrl);
    expect(screen.getByLabelText("Name")).toHaveValue("PM2.5");
    expect(screen.getByRole("button", { name: /save to grafana/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Saved. Change any choice to save another.").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Name"), " daily");
    expect(screen.getByRole("button", { name: /save to grafana/i })).not.toHaveAttribute("aria-disabled", "true");
    expect(sent.find((call) => call.method === "POST")?.body).toEqual({
      title: "PM2.5",
      endpoint: "air",
      type: "AirQualityObserved",
      attribute: "pm25",
      kind: "timeseries",
    });
  });

  it("marks the field the server refused and keeps what was typed", async () => {
    answers["POST /api/v1/projects/helsinki/grafana"] = {
      status: 422,
      body: { status: 422, title: "Unprocessable", detail: "a field is refused", errors: [{ path: "kind", message: "a stat cannot draw name; choose another kind" }] },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    const user = await saveFilled();
    expect((await screen.findAllByRole("alert")).some((node) => node.textContent?.includes("Not saved: check the marked field"))).toBe(true);
    expect(screen.getByLabelText("Visualization")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Visualization")).toHaveAccessibleDescription(/Time series cannot draw PM2\.5\. Choose another visualization/);
    expect(screen.queryByText(/timeseries/)).toBeNull();
    expect(screen.queryByText("a field is refused")).toBeNull();
    expect(screen.getByLabelText("Name")).toHaveValue("x");
    await user.type(screen.getByLabelText("Name"), "y");
    await waitFor(() => expect(screen.queryAllByRole("alert")).toEqual([]));
    expect(screen.getByLabelText("Visualization")).not.toHaveAttribute("aria-invalid", "true");
  });

  it("words an attribute refusal with the names the form shows", async () => {
    answers["POST /api/v1/projects/helsinki/grafana"] = {
      status: 422,
      body: { status: 422, title: "Unprocessable", detail: "a field is refused", errors: [{ path: "attribute", message: "AirQualityObserved has no attribute pm25; choose one from the list" }] },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    await saveFilled();
    expect(await screen.findByText("Nothing was saved; your other choices are kept.")).toBeInTheDocument();
    expect(screen.getByLabelText("Attribute")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Attribute")).toHaveAccessibleDescription(/Air quality observed no longer has PM2\.5\. Choose another attribute/);
    expect(screen.queryByText(/AirQualityObserved|pm25/)).toBeNull();
    expect(await screen.findByText("Rows written before the model dropped PM2.5. Grafana would not draw them.")).toBeInTheDocument();
  });

  it("says who can help when the person may not save", async () => {
    answers["POST /api/v1/projects/helsinki/grafana"] = {
      status: 403,
      body: { status: 403, title: "Forbidden", detail: "you may not propose dashboards in helsinki" },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    await saveFilled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not saved: you may not do this");
    expect(alert).toHaveTextContent("You may not propose dashboards in helsinki. Each visualization is a Grafana dashboard");
    expect(alert).toHaveTextContent("ask a project owner for a role");
    expect(screen.getByRole("button", { name: /save to grafana/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("gives the reason of a failed save and keeps the form", async () => {
    answers["POST /api/v1/projects/helsinki/grafana"] = {
      status: 503,
      body: { status: 503, title: "Unavailable", detail: "the saved visualizations could not be read or written" },
    };
    renderInClient(<VisualizationForm project="helsinki" />);
    await saveFilled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not saved");
    expect(alert).toHaveTextContent("could not be read or written");
    expect(screen.getByRole("button", { name: /save to grafana/i })).not.toHaveAttribute("aria-disabled", "true");
  });
});

describe("the preview", () => {
  it("waits with a skeleton that says what it reads", async () => {
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(() => undefined));
    renderInClient(<VisualizationPreview slug="w" type="T" attribute="x" />);
    expect(await screen.findByRole("status")).toHaveTextContent("Reading the first rows…");
  });

  it("says so when a person may not read the rows or there are none", async () => {
    const refused = new Response(JSON.stringify({ status: 403, title: "Forbidden", detail: "not yours" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
    vi.mocked(fetch).mockResolvedValueOnce(refused);
    const first = renderInClient(<VisualizationPreview slug="a" type="T" attribute="x" />);
    expect(await screen.findByText("You may not read these rows")).toBeInTheDocument();
    expect(screen.getByText(/Grafana would draw nothing for you either/)).toBeInTheDocument();
    first.unmount();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("[]", { status: 200 }));
    renderInClient(<VisualizationPreview slug="b" type="T" attribute="x" />);
    expect(await screen.findByText(/holds no rows/)).toBeInTheDocument();
  });

  it("gives the reason of a failed read and asks again on a press", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 503, title: "Unavailable", detail: "the broker is busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderInClient(<VisualizationPreview slug="e" type="AirQualityObserved" attribute="pm25" />);
    expect(await screen.findByText("The preview could not be read")).toBeInTheDocument();
    expect(screen.getByText("the broker is busy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Kallio")).toBeInTheDocument();
  });

  it("names a row in the reader's language, else in the one it has", async () => {
    const rows = [
      { id: "urn:x:1", type: "T", name: { type: "LanguageProperty", languageMap: { fi: "Kallio 2", en: "Kallio two" } }, x: { type: "Property", value: 1 } },
      { id: "urn:x:2", type: "T", name: { type: "LanguageProperty", languageMap: { fi: "Ilola" } }, x: { type: "Property", value: 2 } },
    ];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(rows), { status: 200 }));
    renderInClient(<VisualizationPreview slug="d" type="T" attribute="x" />);
    expect(await screen.findByText("Kallio two")).toBeInTheDocument();
    expect(screen.getByText("Ilola")).toBeInTheDocument();
  });

  it("shows a place by its coordinates, never as raw JSON", async () => {
    const rows = [{ id: "urn:x:7", type: "T", location: { type: "GeoProperty", value: { type: "Point", coordinates: [24.9, 60.1] } } }];
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(rows), { status: 200 }));
    renderInClient(<VisualizationPreview slug="c" type="T" attribute="location" />);
    expect(await screen.findByText("24.9, 60.1")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});

describe("what Grafana cannot read yet", () => {
  const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;
  it("names titled Endpoints and only counts the internal ones", () => {
    const closed = [
      { name: "ops", title: "Bike operations" },
      { name: "app-t6429-bike-live", title: "app-t6429-bike-live" },
      { name: "app-x", title: "app-x" },
    ];
    expect(notReachable(closed, t)).toBe("Not in Grafana yet: Bike operations, 2 others. Ask your operator to add them.");
    expect(notReachable(closed.slice(1, 2), t)).toBe("1 Endpoint is not in Grafana yet. Ask your operator to add them.");
    expect(notReachable(closed.slice(0, 1), t)).not.toContain("other");
  });
});

describe("a saved visualization", () => {
  it("asks once more before it is removed", async () => {
    answers[`DELETE /api/v1/projects/helsinki/grafana/${item.id}`] = { status: 204, body: null };
    renderInClient(
      <ul>
        <SavedVisualization project="helsinki" item={item} mayRemove />
      </ul>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove PM2.5" }));
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(sent.some((call) => call.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Remove PM2.5" }));
    await user.click(screen.getByRole("button", { name: "Remove from Grafana" }));
    await waitFor(() => expect(sent.some((call) => call.method === "DELETE")).toBe(true));
  });
});
