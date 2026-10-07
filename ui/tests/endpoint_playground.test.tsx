// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/endpoints/Playground.tsx.
/**
 * T-3264: an Endpoint's playground. The person sends the reads their grants allow, with each
 * parameter a field, reads the answer pretty-printed, and copies the same call as curl, Python
 * or JavaScript; a closed endpoint's code names a token and never carries one.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { allowedOperations, Playground, requestOf, snippetsOf } from "../src/pages/endpoints/Playground";

const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";
const empty = { type: "", q: "", limit: "", id: "" };

function show(grants: unknown, open = false, types = ["WeatherObserved", "Event"]) {
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL((input as Request).url);
      seen.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/access")) {
        return grants === null
          ? new Response("{}", { status: 403 })
          : new Response(JSON.stringify(grants), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([{ id: "urn:ngsi-ld:WeatherObserved:1", type: "WeatherObserved" }]), {
        headers: { "Content-Type": "application/ld+json" },
      });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <Playground slug={SLUG} types={types} open={open} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return seen;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the call a playground sends (T-3264)", () => {
  it("encodes every value, bounds the count, and waits for what it needs", () => {
    expect(requestOf("list", { ...empty, type: "Weather Observed", q: 'status=="a&b"', limit: "500" })).toBe(
      "/ngsi-ld/v1/entities?type=Weather+Observed&q=status%3D%3D%22a%26b%22&limit=100",
    );
    expect(requestOf("list", { ...empty, type: "Event", limit: "x" })).toBe("/ngsi-ld/v1/entities?type=Event&limit=10");
    expect(requestOf("count", { ...empty, type: "Event" })).toBe("/ngsi-ld/v1/entities?type=Event&count=true&limit=0");
    expect(requestOf("one", { ...empty, id: "urn:ngsi-ld:Event:a/b" })).toBe("/ngsi-ld/v1/entities/urn%3Angsi-ld%3AEvent%3Aa%2Fb");
    expect(requestOf("types", empty)).toBe("/ngsi-ld/v1/types");
    expect(requestOf("list", empty)).toBeUndefined();
    expect(requestOf("one", { ...empty, id: "  " })).toBeUndefined();
  });

  it("writes the call as code, naming a token only where the endpoint is closed", () => {
    const url = "https://dev.example/api/endpoint/x/ngsi-ld/v1/types";
    const closed = snippetsOf(url, false);
    expect(closed.curl).toContain('-H "Authorization: Bearer $TOKEN"');
    expect(closed.python).toContain('os.environ["TOKEN"]');
    expect(closed.javascript).toContain("process.env.TOKEN");
    const open = snippetsOf(url, true);
    for (const code of Object.values(open)) {
      expect(code).toContain(url);
      expect(code).not.toMatch(/TOKEN|Authorization/);
    }
    expect(snippetsOf("https://x/'; rm -rf /", true).python).toContain(JSON.stringify("https://x/'; rm -rf /"));
  });

  it("offers only the reads the grants allow", () => {
    expect(allowedOperations({ permissions: [{ actions: ["queryEntity"] }] })).toEqual(["list", "count", "types"]);
    expect(allowedOperations({ permissions: [{ actions: ["retrieveEntity"] }] })).toEqual(["one"]);
    expect(allowedOperations({ permissions: [] })).toEqual([]);
    expect(allowedOperations(undefined)).toEqual([]);
  });
});

describe("the playground on an endpoint's page (T-3264)", () => {
  it("sends the chosen read with the person's session and shows the answer pretty-printed", async () => {
    const seen = show({ permissions: [{ resource: { type: "*" }, actions: ["queryEntity", "retrieveEntity"] }] });
    const operation = await screen.findByLabelText(en.endpoints.playground.operation);
    expect([...operation.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      en.endpoints.playground.operations.list,
      en.endpoints.playground.operations.count,
      en.endpoints.playground.operations.one,
      en.endpoints.playground.operations.types,
    ]);
    await userEvent.selectOptions(screen.getByLabelText(en.endpoints.playground.type), "Event");
    await userEvent.type(screen.getByLabelText(en.endpoints.playground.q), "a>1");
    await userEvent.click(screen.getByRole("button", { name: en.endpoints.playground.send }));
    await waitFor(() => expect(seen.at(-1)).toBe(`/api/endpoint/${SLUG}/ngsi-ld/v1/entities?type=Event&q=a%3E1&limit=10`));
    expect(await screen.findByText(/"id": "urn:ngsi-ld:WeatherObserved:1"/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The endpoint answered 200.");
    // The same call as code, curl first, Python and JavaScript a tab away.
    const code = screen.getByRole("tablist", { name: en.endpoints.playground.code });
    await userEvent.click(within(code).getByRole("tab", { name: "Python" }));
    expect(screen.getByText(/import os, requests/)).toBeInTheDocument();
  });

  it("asks for the id before it sends one entity, and offers nothing to a person who may call nothing", async () => {
    show({ permissions: [{ actions: ["retrieveEntity"] }] });
    const send = await screen.findByRole("button", { name: en.endpoints.playground.send });
    expect(send).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(screen.getByLabelText(en.endpoints.playground.id), "urn:ngsi-ld:Event:1");
    expect(send).not.toHaveAttribute("aria-disabled", "true");
  });

  it("starts on the types where the endpoint names none, so the first Send needs no field", async () => {
    show({ permissions: [{ actions: ["queryEntity"] }] }, true, []);
    const operation = await screen.findByLabelText(en.endpoints.playground.operation);
    expect(operation).toHaveValue("types");
    expect(screen.getByRole("button", { name: en.endpoints.playground.send })).not.toHaveAttribute("aria-disabled", "true");
  });

  it("says so when the grants are refused", async () => {
    show(null);
    expect(await screen.findByText(en.endpoints.playground.nothing)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.endpoints.playground.send })).toBeNull();
  });
});
