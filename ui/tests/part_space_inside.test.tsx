/**
 * T-1854: what a space holds, against the UI contract (UI-01, UI-15, UI-16, UI-48, SP-04).
 *
 * The page wrote `query.isPending ? "loading" : "there are none"` three times over, so a list
 * that came back 403, or never came back, said "this space has no endpoints" — the most
 * reassuring possible rendering of a failed read, and the one a person acts on by creating a
 * second endpoint they already have. It also hand-made its type chooser and painted eleven
 * strings with `text-surface-fg/70`, a token diluted by opacity rather than the muted token.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRouter } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { SUPPORTED_LOCALES } from "../src/i18n";
import en from "../src/locales/en.json";
import { expectNoRawKeys, expectNoViolations } from "./checks";
import { SpaceInside } from "../src/pages/spaces/SpaceInside";

const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";

function list(items: unknown[]) {
  return { apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items };
}

const SPACE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ContextSpace",
  metadata: { name: "ovzdusie", namespace: "banskabystrica", title: { en: "Air quality" } },
  spec: { dataModelRef: "bb-air" },
  status: { phase: "Live" },
};

const MODELS = list([
  {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "DataModel",
    metadata: { name: "bb-air", namespace: "banskabystrica" },
    spec: { classes: ["AirQualityObserved", "AirQualityStation"] },
  },
]);

const ENDPOINTS = list([
  {
    apiVersion: "joinedcontext.com/v1alpha1",
    kind: "Endpoint",
    metadata: { name: "public-air", namespace: "banskabystrica" },
    spec: { contextSpaceRef: "ovzdusie", slug: SLUG, audience: "public", enabledRepresentations: ["ngsi-ld"] },
    status: { phase: "Live" },
  },
]);

type Answer = { status: number; body: unknown };

const OK: Record<string, Answer> = {
  space: { status: 200, body: SPACE },
  datamodels: { status: 200, body: MODELS },
  endpoints: { status: 200, body: ENDPOINTS },
  policies: { status: 200, body: list([]) },
};

/** A read that hangs, for the state between asking and knowing. */
function hangs(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

function show(answers: Partial<Record<string, Answer>> = {}, hanging: string[] = [], tab = "") {
  // The tab is in the address (T-4825); each render starts from its own.
  window.history.replaceState({}, "", tab ? `/?tab=${tab}` : "/");
  const given = { ...OK, ...answers };
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const path = url.pathname;
    const key = path.endsWith("/spaces/ovzdusie")
      ? "space"
      : path.endsWith("/datamodels")
        ? "datamodels"
        : path.endsWith("/endpoints")
          ? "endpoints"
          : path.endsWith("/policies")
            ? "policies"
            : path.endsWith("/usage")
              ? "usage"
              : "other";
    if (hanging.includes(key)) {
      return hangs();
    }
    const answer = given[key] ?? { status: 200, body: list([]) };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => <SpaceInside project="banskabystrica" name="ovzdusie" />,
  });
  const router = createRouter({ routeTree: rootRoute });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { fetchMock, container: view.container, user: userEvent.setup(), unmount: view.unmount };
}

const problem = (detail: string, status = 403): Answer => ({
  status,
  body: { title: "Forbidden", detail },
});

describe("what a space holds, against the UI contract", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says an endpoint list that failed is a failure, not an empty space", async () => {
    show({ endpoints: problem("your role does not permit reading endpoints") }, [], "endpoints");
    expect(await screen.findByText("your role does not permit reading endpoints")).toBeInTheDocument();
    expect(screen.queryByText(en.spaces.inside.noEndpoints)).toBeNull();
  });

  it("offers to read the failed list again, and asks again when pressed", async () => {
    const { fetchMock, user } = show({ policies: problem("the policy store is not answering", 503) }, [], "policies");
    await screen.findByText("the policy store is not answering");
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getAllByRole("button", { name: en.app.error.retry })[0]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("waits visibly while the space itself is on its way", async () => {
    show({}, ["space"]);
    expect(await screen.findByRole("status")).toHaveTextContent(en.app.loading);
  });

  it("says what the API said when the space cannot be read, with one thing to do", async () => {
    show({ space: problem("no grant for this space", 404) });
    expect(await screen.findByText("no grant for this space")).toBeInTheDocument();
    // A 404 answers the same the second time (T-2834): the heading, the purpose line and the
    // way back, no Retry.
    expect(screen.queryByRole("button", { name: en.app.error.retry })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.spaces.inside.back })).toBeInTheDocument();
  });

  it("offers Retry when the space's store is away, and asks again when pressed", async () => {
    const { fetchMock, user } = show({ space: problem("the store is away", 503) });
    expect(await screen.findByText("the store is away")).toBeInTheDocument();
    const before = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: en.app.error.retry }));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  // T-4825: Baserow's shape. The page lands on the rows, the types in a left list, and the
  // model, quality, retention, endpoints and policies are tabs kept in the address.
  it("lands on the rows with the types in a left list and the rest as tabs", async () => {
    const { user } = show();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.slice(0, 7).map((tab) => tab.textContent)).toEqual([
      en.spaces.inside.data,
      en.spaces.inside.model,
      en.spaces.quality.title,
      en.spaces.retention.title,
      en.endpoints.title,
      en.spaces.inside.policies,
      en.activity.panelTitle,
    ]);
    expect(screen.getByRole("tab", { name: en.spaces.inside.data })).toHaveAttribute("aria-selected", "true");
    const list = await screen.findByRole("navigation", { name: en.spaces.inside.types });
    const observed = within(list).getByRole("button", { name: "AirQualityObserved" });
    expect(observed).toHaveAttribute("aria-current", "true");
    expect(observed).toHaveClass("focus-ring");
    // The open type carries its saved views, "All rows" first and chosen.
    const views = within(list).getByRole("list", { name: en.spaces.inside.savedViews });
    expect(within(views).getByRole("button", { name: en.spaces.inside.allRows })).toHaveAttribute("aria-current", "true");
    // The model's types table is not on the landing page any more.
    expect(screen.queryByRole("table", { name: en.spaces.inside.types })).toBeNull();

    await user.click(within(list).getByRole("button", { name: "AirQualityStation" }));
    expect(new URLSearchParams(window.location.search).get("type")).toBe("AirQualityStation");
    expect(within(list).getByRole("button", { name: "AirQualityStation" })).toHaveAttribute("aria-current", "true");
  });

  it("opens the tab the address names, and a click puts the tab in the address", async () => {
    const { user } = show({}, [], "model");
    expect(await screen.findByRole("table", { name: en.spaces.inside.types })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: en.spaces.inside.types })).toBeNull();
    await user.click(screen.getByRole("tab", { name: en.spaces.retention.title }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("retention");
    expect(screen.getByRole("tab", { name: en.spaces.retention.title })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: en.spaces.inside.data }));
    expect(new URLSearchParams(window.location.search).get("tab")).toBeNull();
  });

  it("says the space's count is on its way, then the count, or why there is none (503), on the model tab", async () => {
    const counting = show({}, ["usage"], "model");
    expect(await screen.findByTestId("space-total")).toHaveTextContent(en.spaces.inside.counting);
    counting.unmount();
    vi.unstubAllGlobals();

    const counted = show({ usage: { status: 200, body: { entities: 532, broker: "main", observedAt: "2026-10-20T16:00:00Z" } } }, [], "model");
    expect(await screen.findByTestId("space-total")).toHaveTextContent("The space holds 532 entities.");
    counted.unmount();
    vi.unstubAllGlobals();

    show({ usage: { status: 503, body: { title: "Service Unavailable", status: 503, detail: "the broker took longer than 20 s to count the space; try again in a minute" } } }, [], "model");
    expect(await screen.findByTestId("space-total")).toHaveTextContent("the broker took longer than 20 s to count the space");
  });

  // T-4885: the rows count through the grid's own answer; the whole-tenant scan under them failed
  // on helsinki beside a grid that had its count ("100 of 121 loaded").
  it("counts the rows only through the grid: the data tab never asks for the whole space's scan", async () => {
    const { fetchMock } = show({ usage: { status: 503, body: { title: "Service Unavailable", status: 503, detail: "the broker took longer than 20 s to count the space" } } });
    await screen.findByRole("navigation", { name: en.spaces.inside.types });
    const asked = fetchMock.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));
    expect(asked.filter((url) => url.includes("/usage"))).toEqual([]);
    expect(screen.queryByTestId("space-total")).toBeNull();
    expect(document.body.textContent).not.toContain("The count is not available");
  });

  it("has no axe violation, loaded and with a section that failed", async () => {
    const loaded = show();
    await screen.findByRole("navigation", { name: en.spaces.inside.types });
    await expectNoViolations(loaded.container);
    loaded.unmount();
    vi.unstubAllGlobals();

    const failed = show({ endpoints: problem("not yours") }, [], "endpoints");
    await screen.findByText("not yours");
    await expectNoViolations(failed.container);
  });

  it("shows no raw translation key in any locale the organisation offers", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      await i18n.changeLanguage(locale);
      for (const tab of ["", "model"]) {
        const { container, unmount } = show({}, [], tab);
        if (tab) await screen.findByTestId("space-total");
        else await screen.findByRole("tab", { selected: true });
        expectNoRawKeys(container);
        unmount();
        vi.unstubAllGlobals();
      }
    }
    await i18n.changeLanguage("en");
  });
});
