/** The Žilina dashboard over what the public endpoint of `zilina-kpi` answers (T-3140). */
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "./App";
import { answer, INDICATORS } from "./fixtures/kpi";
import { LOCALES } from "./locales";

const s = LOCALES.sk;
const SLUG = "ricvfpfxtaxeyzf5c3b3es7ymc6unh3o";

function show(body: () => Response, withEndpoint = true) {
  vi.stubGlobal("fetch", vi.fn(async () => body()));
  const client = stubClient(undefined, {
    slug: withEndpoint ? SLUG : "",
    orgDomain: "zilina.sk",
    space: withEndpoint ? "zilina-kpi" : "elsewhere",
    transport: "origin",
    appName: "zilina-ukazovatele",
    language: "sk",
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Žilina dashboard", () => {
  it("shows the six indicators in their order, each with its value, unit and window", async () => {
    show(() => json(answer("KeyPerformanceIndicator")));
    const cards = await screen.findAllByRole("article");
    expect(cards.map((card) => within(card).getByRole("heading").textContent)).toEqual([
      s.label["obyvatelstvo-stav"],
      s.label["celkovy-prirastok"],
      s.label["priemerny-vek"],
      s.label["index-starnutia"],
      s.label.uchadzaci,
      s.label["navstevnici-rok"],
    ]);
    const population = screen.getByRole("article", { name: s.label["obyvatelstvo-stav"] });
    expect(population).toHaveTextContent(/79\s617 osôb/);
    expect(population).toHaveTextContent("2. štvrťrok 2026");
    expect(screen.getByRole("article", { name: s.label["celkovy-prirastok"] })).toHaveTextContent(/-384 osôb|−384 osôb/);
    expect(screen.getByRole("article", { name: s.label["navstevnici-rok"] })).toHaveTextContent("rok 2025");
    expect(screen.getByText(s.noThreshold)).toBeInTheDocument();
  });

  it("says not measured where the pipeline found no row, and drops what it cannot place", async () => {
    const rows = structuredClone(INDICATORS) as Array<Record<string, unknown>>;
    rows[0].currentValue = { type: "Property", value: "not measured" };
    rows.push({ ...rows[1], id: String(rows[1].id).replace(":zilina-kpi:", ":bbsk-kpi:") });
    show(() => json(rows));
    const cards = await screen.findAllByRole("article");
    expect(cards).toHaveLength(6);
    expect(screen.getByText(s.notMeasured)).toBeInTheDocument();
  });

  it("says why the endpoint refused, and that it has nothing to read without one", async () => {
    show(() => new Response(JSON.stringify({ title: "Forbidden", status: 403, detail: "no policy" }), {
      status: 403,
      headers: { "content-type": "application/problem+json" },
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no policy");
  });

  it("has nothing to read without an endpoint of the indicator space", () => {
    show(() => json([]), false);
    expect(screen.getByRole("status")).toHaveTextContent(s.noEndpoint);
  });

  it("names its source and has nothing axe finds", async () => {
    const { container } = show(() => json(answer("KeyPerformanceIndicator")));
    await screen.findAllByRole("article");
    expect(screen.getByText(s.attribution)).toBeInTheDocument();
    const found = await axe.run(container, { rules: { region: { enabled: false } } });
    expect(found.violations.map((v) => v.id)).toEqual([]);
  });
});
