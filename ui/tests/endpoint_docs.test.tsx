// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/endpoints/EndpointDocs.tsx.
/**
 * T-3265 (EP-99): an Endpoint's API documentation, read from the OpenAPI document the gateway
 * generates for the reader: each operation with its parameters and an example call, each type
 * with its attributes.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { EndpointDocs, operationsOf, typesOf } from "../src/pages/endpoints/EndpointDocs";

const SLUG = "k4y7pq2mzt6vhx3nbwrs5cjd8f";
/** The shape `openapi_doc::document` answers, cut to two operations and one type. */
const DOC = {
  openapi: "3.1.0",
  info: { title: "Air quality in Banská Bystrica", description: "Stations and their readings.", version: "1.4.0" },
  servers: [{ url: `/api/endpoint/${SLUG}` }],
  paths: {
    "/ngsi-ld/v1/entities": {
      get: {
        summary: "The entities of a type",
        parameters: [
          { name: "type", in: "query", required: false, description: "The entity type", schema: { type: "string", enum: ["AirQualityObserved"] } },
          { name: "q", in: "query", required: false, description: "NGSI-LD query language", schema: { type: "string" } },
        ],
      },
    },
    "/ngsi-ld/v1/entities/{entityId}": {
      get: { summary: "One entity by its id", parameters: [{ name: "entityId", in: "path", required: true, description: "The entity's URN", schema: { type: "string" } }] },
    },
  },
  components: {
    schemas: {
      AirQualityObserved: { type: "object", properties: { pm10: { type: "number", description: "Particles under 10 µm" }, id: { type: "string" } } },
    },
  },
};

function show(answer: Response, open = true) {
  const seen: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      seen.push(input as Request);
      return answer;
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nextProvider i18n={i18n}>
        <EndpointDocs slug={SLUG} open={open} />
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

describe("an endpoint's documentation (T-3265)", () => {
  it("reads every operation with an example of the first type, and every type's attributes", () => {
    const operations = operationsOf(DOC);
    expect(operations.map((o) => `${o.method} ${o.path} ${o.example}`)).toEqual([
      "GET /ngsi-ld/v1/entities /ngsi-ld/v1/entities?type=AirQualityObserved&limit=5",
      "GET /ngsi-ld/v1/entities/{entityId} /ngsi-ld/v1/entities/urn%3Angsi-ld%3AAirQualityObserved%3A001",
    ]);
    expect(operations[0].parameters[0]).toEqual({ name: "type", where: "query", required: false, description: "The entity type", values: ["AirQualityObserved"] });
    expect(typesOf(DOC)).toEqual([
      { name: "AirQualityObserved", attributes: [{ name: "pm10", type: "number", description: "Particles under 10 µm" }, { name: "id", type: "string", description: "" }] },
    ]);
    expect(operationsOf({})).toEqual([]);
    expect(operationsOf({ paths: { "/ngsi-ld/v1/entities": { get: {} } } })[0].example).toBe("/ngsi-ld/v1/entities?limit=5");
  });

  it("shows the document as the gateway generated it, with an example call per operation", async () => {
    const seen = show(new Response(JSON.stringify(DOC), { headers: { "Content-Type": "application/json" } }));
    expect(await screen.findByRole("heading", { level: 1, name: "Air quality in Banská Bystrica" })).toBeInTheDocument();
    expect(new URL(seen[0].url).pathname).toBe(`/api/endpoint/${SLUG}/openapi.json`);
    const list = screen.getByRole("region", { name: "GET /ngsi-ld/v1/entities" });
    expect(within(list).getByRole("cell", { name: /The entity type \(AirQualityObserved\)/ })).toBeInTheDocument();
    expect(within(list).getByText(new RegExp(`curl .*/api/endpoint/${SLUG}/ngsi-ld/v1/entities\\?type=AirQualityObserved&limit=5`))).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AirQualityObserved" })).toHaveTextContent("Particles under 10 µm");
  });

  it("says it cannot be read when the gateway refuses, revealing nothing", async () => {
    show(new Response("{}", { status: 404 }));
    expect(await screen.findByText(en.endpoints.docs.unavailable)).toBeInTheDocument();
  });
});
