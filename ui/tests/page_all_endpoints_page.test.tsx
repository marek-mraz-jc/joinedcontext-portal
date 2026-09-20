/**
 * T-1787: "All endpoints" against the page contract (UI-11, UI-15, UI-16, EP-08, EP-44, PF-60).
 *
 * `all_endpoints_view.test.tsx` walks to this page through the whole application and keeps what
 * the organization-level route answers. This one imports the page itself, which is the module
 * gate, and asserts the frame: the H1 and the tab, the four states, a table that reads the same
 * with no rows, one row and five hundred, the keyboard, four languages, axe, and — the reason
 * the survey flagged three lines — that every link on it is built by the Portal and checked
 * before it is a link.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { AllEndpointsPage } from "../src/routes/AllEndpointsPage";
import {
  expectHeadingOutline,
  expectNoAxeViolations,
  inEveryLocale,
  json,
  list,
  problem,
  renderPage,
  tabOrder,
} from "./page_contract";

function endpoint(index: number, overrides: Record<string, unknown> = {}) {
  const project = `city-${index % 7}`;
  return {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Endpoint",
    metadata: {
      name: `air-${index}`,
      namespace: project,
      labels: { "joinedcontext.com/space": "ovzdusie" },
      title: { en: `Air quality ${index}` },
    },
    spec: {
      contextSpaceRef: "ovzdusie",
      slug: `k7m2qz4tv6xh3n5jb2ryd3wcf${index}`,
      audience: "public",
      enabledRepresentations: ["ngsi-ld", "geojson"],
      ...overrides,
    },
    status: { phase: "Live" },
  };
}

interface World {
  rows?: number;
  fails?: { status: number; detail: string };
  pending?: boolean;
  items?: unknown[];
}

function renderAll(world: World = {}) {
  const { rows = 2, fails, pending = false, items } = world;
  return renderPage(<AllEndpointsPage />, {
    path: "/endpoints",
    answer: (url) => {
      if (!url.pathname.endsWith("/api/v1/endpoints")) return undefined;
      if (pending) return new Promise<Response>(() => undefined);
      if (fails) return problem(fails.status, fails.detail);
      return json(list(items ?? Array.from({ length: rows }, (_, index) => endpoint(index))));
    },
  });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.title = "";
});

describe("all endpoints", () => {
  // UI-15: the page names itself, and the tab says so too. It is outside a project, so the tab
  // carries no project name.
  it("has one H1 and names the page in the tab, with no project", async () => {
    const { container } = renderAll();
    expect(
      await screen.findByRole("heading", { level: 1, name: en.allEndpoints.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.allEndpoints.lead)).toBeInTheDocument();
    expectHeadingOutline(container);
    await waitFor(() => {
      expect(document.title).toBe(`${en.allEndpoints.title} · Helsinki Region Context`);
    });
  });

  it("says the table is loading rather than showing it empty", async () => {
    renderAll({ pending: true });
    const table = await screen.findByRole("table", { name: en.allEndpoints.title });
    // The wait is announced once, beside the table, and the table says it is busy.
    expect(screen.getByRole("status")).toHaveTextContent(en.app.loading);
    expect(table).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(en.allEndpoints.empty)).not.toBeInTheDocument();
  });

  it("says what lands here when nobody publishes an endpoint", async () => {
    const { container } = renderAll({ rows: 0 });
    expect(await screen.findByText(en.allEndpoints.empty)).toBeInTheDocument();
    expect(screen.getByText(en.allEndpoints.emptyHint)).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  // A list that failed is not "nobody publishes anything".
  it("shows the reason the list failed, with a retry", async () => {
    renderAll({ fails: { status: 503, detail: "The endpoint index is not answering." } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The endpoint index is not answering.",
    );
    expect(screen.getByRole("button", { name: en.app.error.retry })).toBeInTheDocument();
    expect(screen.queryByText(en.allEndpoints.empty)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: en.allEndpoints.title }),
    ).toBeInTheDocument();
  });

  // UI-44: a refusal is the API's own sentence.
  it("says a refusal in the API's own words", async () => {
    renderAll({ fails: { status: 403, detail: "You may read no project's endpoints." } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You may read no project's endpoints.",
    );
  });

  it.each([0, 1, 500])("draws %i endpoints without changing how the page reads", async (rows) => {
    const { container } = renderAll({ rows });
    const table = await screen.findByRole("table", { name: en.allEndpoints.title });
    await waitFor(() => {
      expect(table).not.toHaveAttribute("aria-busy");
    });
    expect(table.querySelectorAll("tbody tr")).toHaveLength(Math.max(rows, 1));
    expectHeadingOutline(container);
  });

  // EP-08, EP-44: one direct link per representation, plus the links every endpoint has.
  it("gives each endpoint one link per representation, on this origin", async () => {
    renderAll({ rows: 1 });
    const geojson = await screen.findByRole("link", { name: "geojson" });
    expect(geojson).toHaveAttribute(
      "href",
      `${window.location.origin}/api/endpoint/k7m2qz4tv6xh3n5jb2ryd3wcf0/file.geojson`,
    );
    expect(screen.getByRole("link", { name: en.endpoints.link.index })).toHaveAttribute(
      "href",
      `${window.location.origin}/api/endpoint/k7m2qz4tv6xh3n5jb2ryd3wcf0/`,
    );
    // A new tab never hands the opener over (PF-50).
    expect(geojson).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  // PF-50: a slug is a value out of a manifest. It is encoded, so it cannot climb out of the
  // endpoint's own path, and a representation with no path stays a badge rather than a link.
  it("cannot be walked out of the endpoint's own path by its slug", async () => {
    renderAll({ items: [endpoint(0, { slug: "../../admin" })] });
    const link = await screen.findByRole("link", { name: "geojson" });
    expect(link.getAttribute("href")).toBe(
      `${window.location.origin}/api/endpoint/..%2F..%2Fadmin/file.geojson`,
    );
    expect(link.getAttribute("href")).not.toContain("/admin/file.geojson");
  });

  it("shows a representation it has no address for as a word, not a link", async () => {
    renderAll({ items: [endpoint(0, { enabledRepresentations: ["parquet"] })] });
    expect(await screen.findByText("parquet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "parquet" })).not.toBeInTheDocument();
  });

  // UI-16: every link on the page is reached by keyboard, in the order the table is read, and
  // nothing takes focus on arrival.
  it("is reachable by keyboard in the order the table is read", async () => {
    const { container } = renderAll({ rows: 2 });
    await screen.findAllByRole("link", { name: "geojson" });
    expect(document.activeElement).toBe(document.body);
    const reached = await tabOrder(container, 60);
    const projects = screen.getAllByRole("link", { name: /^city-/ });
    expect(reached.indexOf(projects[0])).toBeGreaterThanOrEqual(0);
    expect(reached.indexOf(projects[0])).toBeLessThan(reached.indexOf(projects[1]));
  });

  it("says the same things in every language", async () => {
    await inEveryLocale(async (locale) => {
      cleanup();
      renderAll({ rows: 0 });
      expect(
        await screen.findByRole("heading", { level: 1, name: i18n.t("allEndpoints.title") }),
        `the title is missing in ${locale}`,
      ).toBeInTheDocument();
      expect(await screen.findByText(i18n.t("allEndpoints.emptyHint"))).toBeInTheDocument();
    });
  });

  // PF-50: a title out of a manifest is read as text.
  it("renders an endpoint title that arrived as markup as text", async () => {
    renderAll({ items: [endpoint(0, {})] });
    cleanup();
    renderPage(<AllEndpointsPage />, {
      path: "/endpoints",
      answer: (url) =>
        url.pathname.endsWith("/api/v1/endpoints")
          ? json(
              list([
                {
                  ...endpoint(0),
                  metadata: { ...endpoint(0).metadata, title: { en: "<img src=x onerror=alert(1)>" } },
                },
              ]),
            )
          : undefined,
    });
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("has no axe violations with the table full", async () => {
    const { container } = renderAll({ rows: 4 });
    await screen.findAllByRole("link", { name: "geojson" });
    await expectNoAxeViolations(container);
  });

  it("has no axe violations in the failed state", async () => {
    const { container } = renderAll({ fails: { status: 503, detail: "Not answering." } });
    await screen.findByRole("alert");
    await expectNoAxeViolations(container);
  });
});
