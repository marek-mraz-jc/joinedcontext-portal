/**
 * T-1854: what a space holds, against the UI contract (UI-01, UI-15, UI-16, UI-48, SP-04).
 *
 * The page wrote `query.isPending ? "loading" : "there are none"` three times over, so a list
 * that came back 403, or never came back, said "this space has no endpoints" — the most
 * reassuring possible rendering of a failed read, and the one a person acts on by creating a
 * second endpoint they already have. It also hand-made its type chooser and painted eleven
 * strings with `text-surface-fg/70`, a token diluted by opacity rather than the muted token.
 */
import { render, screen } from "@testing-library/react";
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

function show(answers: Partial<Record<string, Answer>> = {}, hanging: string[] = []) {
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
    show({ endpoints: problem("your role does not permit reading endpoints") });
    expect(await screen.findByText("your role does not permit reading endpoints")).toBeInTheDocument();
    expect(screen.queryByText(en.spaces.inside.noEndpoints)).toBeNull();
  });

  it("offers to read the failed list again, and asks again when pressed", async () => {
    const { fetchMock, user } = show({ policies: problem("the policy store is not answering", 503) });
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

  it("chooses the entity type through a labelled, shared select", async () => {
    show();
    const select = await screen.findByLabelText(en.spaces.inside.dataType);
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveClass("focus-ring");
    expect([...select.querySelectorAll("option")].map((option) => option.value)).toEqual([
      "AirQualityObserved",
      "AirQualityStation",
    ]);
  });

  it("has no axe violation, loaded and with a section that failed", async () => {
    const loaded = show();
    await screen.findByLabelText(en.spaces.inside.dataType);
    await expectNoViolations(loaded.container);
    loaded.unmount();
    vi.unstubAllGlobals();

    const failed = show({ endpoints: problem("not yours") });
    await screen.findByText("not yours");
    await expectNoViolations(failed.container);
  });

  it("shows no raw translation key in any locale the organisation offers", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      await i18n.changeLanguage(locale);
      const { container, unmount } = show();
      await screen.findAllByRole("table");
      expectNoRawKeys(container);
      unmount();
      vi.unstubAllGlobals();
    }
    await i18n.changeLanguage("en");
  });
});
