/**
 * T-3110, ADR-N-042 §3.6: the API of one type of a space: the calls each Endpoint answers for it,
 * one tried with the person's session, the ServiceAccount way to a program's token, and the
 * webhooks (NGSI-LD subscriptions) that watch it, a new one started as a draft.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/TypeApi.tsx.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import type { Manifest } from "../src/api/manifest";
import { TypeApi, callsOf, webhooksOf } from "../src/pages/spaces/TypeApi";
import { expectNoViolations } from "./checks";
import { renderPage } from "./page_contract";

const V = "joinedcontext.com/v1alpha1";
const endpoint = (name: string, slug: string | undefined, spec: Record<string, unknown> = {}): Manifest =>
  ({ apiVersion: V, kind: "Endpoint", metadata: { name, namespace: "helsinki" }, spec: { contextSpaceRef: "bikes", ...(slug ? { slug } : {}), ...spec } }) as Manifest;
const subscription = (name: string, space: string, type: string, uri: string): Manifest =>
  ({
    apiVersion: V,
    kind: "Subscription",
    metadata: { name, namespace: "helsinki", labels: { "joinedcontext.com/space": space } },
    spec: { entities: [{ type }], notification: { endpoint: { uri } } },
  }) as Manifest;

describe("the calls of a type", () => {
  it("names the list, count, one entity and history of the type, and every representation served", () => {
    const calls = callsOf("abc", "Bike Station", ["ngsi-ld", "geojson", "csv"], undefined);
    expect(calls.map((call) => call.key)).toEqual(["list", "count", "one", "history", "geojson", "csv"]);
    expect(calls[0].url).toBe(`${window.location.origin}/api/endpoint/abc/ngsi-ld/v1/entities?type=Bike%20Station&limit=10`);
  });

  it("takes the webhooks of this space that watch this type and no other", () => {
    const hooks = webhooksOf(
      [
        subscription("a", "bikes", "BikeHireDockingStation", "https://a.example"),
        subscription("b", "other", "BikeHireDockingStation", "https://b.example"),
        subscription("c", "bikes", "Road", "https://c.example"),
      ],
      "bikes",
      "BikeHireDockingStation",
    );
    expect(hooks.map((hook) => hook.metadata.name)).toEqual(["a"]);
  });
});

describe("the API tab", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function show(endpoints = [endpoint("public-bikes", "abc"), endpoint("draft-ep", undefined)]) {
    const puts: { path: string; body: unknown }[] = [];
    renderPage(<TypeApi project="helsinki" space="bikes" type="BikeHireDockingStation" endpoints={endpoints} />, {
      path: "/projects/helsinki/spaces/bikes",
      answer: async (url, request) => {
        if (url.pathname.startsWith("/api/endpoint/abc/ngsi-ld/v1/entities")) {
          return new Response(JSON.stringify([{ id: "urn:ngsi-ld:BikeHireDockingStation:1", type: "BikeHireDockingStation" }]), {
            status: 200,
            headers: { "Content-Type": "application/ld+json" },
          });
        }
        if (url.pathname.endsWith("/subscriptions") && request.method === "GET") {
          return new Response(
            JSON.stringify({ items: [subscription("bikes-low", "bikes", "BikeHireDockingStation", "https://hooks.example/low")] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (request.method === "PUT" && url.pathname.includes("/drafts/")) {
          puts.push({ path: url.pathname, body: await request.json() });
          return new Response(JSON.stringify({ kind: "Subscription", name: "x", version: 1, manifest: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return undefined;
      },
    });
    return { puts };
  }

  it("shows each Endpoint's calls for the type, tries one with the session, and lists its webhooks", async () => {
    show();
    const api = await screen.findByTestId("view-api");
    // An Endpoint with no slug yet answers nothing, so it is not offered.
    expect(within(api).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Through public-bikes",
      en.spaces.api.tokens,
      en.spaces.api.webhooks,
    ]);
    expect(within(api).getByText(/entities\?type=BikeHireDockingStation&limit=10$/)).toBeInTheDocument();
    expect(await within(api).findByText("bikes-low")).toBeInTheDocument();
    expect(within(api).getByRole("link", { name: en.spaces.api.tokensLink })).toHaveAttribute(
      "href",
      "/projects/helsinki/settings/service-accounts",
    );
    await expectNoViolations(api);

    await userEvent.click(within(api).getByRole("button", { name: en.spaces.api.try }));
    expect(await within(api).findByRole("status")).toHaveTextContent("The endpoint answered 200");
    expect(within(api).getByTestId("api-tried")).toHaveTextContent("urn:ngsi-ld:BikeHireDockingStation:1");
  });

  it("starts a webhook on the type as a Subscription draft and opens it", async () => {
    const { puts } = show();
    await userEvent.click(await screen.findByRole("button", { name: en.spaces.api.newWebhook }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].path).toMatch(/^\/api\/v1\/projects\/helsinki\/drafts\/Subscription\/webhook-bikehiredockingstation-[a-z0-9]{1,4}$/);
    const manifest = (puts[0].body as { manifest: { spec: unknown; metadata: { labels: unknown } } }).manifest;
    expect(manifest.spec).toEqual({ entities: [{ type: "BikeHireDockingStation" }], notification: { endpoint: { uri: "", accept: "application/json" } } });
    expect(manifest.metadata.labels).toEqual({ "joinedcontext.com/space": "bikes" });
    await waitFor(() => expect(window.location.pathname).toBe("/projects/helsinki/subscriptions"));
    expect(window.location.search).toMatch(/^\?draft=webhook-bikehiredockingstation-/);
  });

  it("says no program can read a space no Endpoint serves", async () => {
    show([]);
    expect(await screen.findByText(en.spaces.api.noEndpoint)).toBeInTheDocument();
  });
});
