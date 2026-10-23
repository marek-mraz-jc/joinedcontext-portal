/**
 * T-5296: the Endpoint page shows each calendar's webcal:// address as a QR code, so a phone
 * camera subscribes without typing it; the code's accessible name carries the address.
 */
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { I18nextProvider } from "react-i18next";
import { encode } from "uqr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import { QrCode } from "../src/components/endpoints/QrCode";
import { EndpointPage } from "../src/pages/endpoints/EndpointPage";

const PROJECT = "banskabystrica";
const NAME = "events";
const SLUG = "k7m2qz4tv6xh3n5jb2ryd3wcfa";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function darkModules(svg: Element): number {
  return (svg.querySelector("path")?.getAttribute("d")?.match(/M/g) ?? []).length;
}

describe("the QR code", () => {
  it("draws every dark module of the encoded address inside a four-module quiet zone", () => {
    const value = `webcal://api.dev.example/api/endpoint/${SLUG}/ical/v1/kalendar.ics`;
    render(<QrCode value={value} label={`QR ${value}`} />);
    const svg = screen.getByRole("img", { name: `QR ${value}` });
    const { data } = encode(value, { ecc: "M", border: 4 });
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${data.length} ${data.length}`);
    expect(darkModules(svg)).toBe(data.flat().filter(Boolean).length);
    // The quiet zone: the outer four rows and columns stay light.
    expect(data.slice(0, 4).flat().some(Boolean)).toBe(false);
    expect(data.map((row) => row.slice(0, 4)).flat().some(Boolean)).toBe(false);
  });

  it("encodes another address into other modules", () => {
    const { container } = render(
      <>
        <QrCode value="webcal://a.example/ical/v1/a.ics" label="a" />
        <QrCode value="webcal://a.example/ical/v1/b.ics" label="b" />
      </>,
    );
    const [a, b] = Array.from(container.querySelectorAll("path")).map((p) => p.getAttribute("d"));
    expect(a).not.toBe(b);
  });
});

describe("the Endpoint page's calendar subscription (T-5296)", () => {
  function show() {
    const endpoint = {
      apiVersion: "joinedcontext.com/v1alpha1",
      kind: "Endpoint",
      metadata: { name: NAME, namespace: PROJECT },
      spec: {
        contextSpaceRef: "podujatia",
        slug: SLUG,
        audience: "public",
        enabledRepresentations: ["ngsi-ld", "ical"],
        representations: { ical: [{ name: "kalendar", title: { en: "Events" }, sources: [{ type: "Event" }] }] },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
        const json = (body: unknown) =>
          Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (path.endsWith(`/endpoints/${NAME}`)) return json(endpoint);
        if (path.endsWith("/permissions/me")) return json({ project: PROJECT, bootstrap: false, grants: [] });
        return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({
      routeTree: createRootRoute({ component: () => <EndpointPage project={PROJECT} name={NAME} /> }),
    });
    render(
      <QueryClientProvider client={client}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </QueryClientProvider>,
    );
  }

  it("shows the webcal address as a QR code named by that address, with how to use it", async () => {
    show();
    const qr = await screen.findByRole("img", { name: /^QR code of the calendar subscription webcal:\/\// });
    const name = qr.getAttribute("aria-label") ?? "";
    expect(name).toMatch(new RegExp(`/api/endpoint/${SLUG}/ical/v1/kalendar\\.ics$`));
    // The address the code carries is the one printed beside it, which the copy button copies.
    const address = name.replace("QR code of the calendar subscription ", "");
    expect(screen.getByText(address)).toBeInTheDocument();
    expect(darkModules(qr)).toBe(encode(address, { ecc: "M", border: 4 }).data.flat().filter(Boolean).length);
    expect(within(qr.closest("figure") as HTMLElement).getByText(/Scan it with a phone camera/)).toBeInTheDocument();
  });
});
