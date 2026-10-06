/**
 * T-3108, API/01 §33: a type of a space published as a public link — a public Endpoint narrowed to
 * the type and the attributes left ticked, proposed with its Policy as one Change — and the page at
 * `/v/{slug}` that reads that Endpoint anonymously.
 */
// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/spaces/PublicView.tsx.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n";
import en from "../src/locales/en.json";
import { PublicViewPage, SharePanel, publicName, publishRequest } from "../src/pages/spaces/PublicView";
import { expectNoViolations } from "./checks";
import { renderPage } from "./page_contract";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 300 ? "application/json" : "application/problem+json" },
  });

describe("what is published", () => {
  it("names the Endpoint after the space and the type, within 63 characters", () => {
    expect(publicName("bikes", "BikeHireDockingStation")).toBe("bikes-bikehiredockingstation-public");
    expect(publicName("x".repeat(70), "T").length).toBeLessThanOrEqual(63);
  });

  it("asks for this type alone, public, and hides every attribute not left ticked", () => {
    expect(publishRequest("bikes", "bikes-public", "Station", ["name", "free", "note"], ["name", "free"])).toEqual({
      contextSpace: "bikes",
      name: "bikes-public",
      audience: "public",
      entityTypes: ["Station"],
      hiddenAttributes: ["note"],
    });
  });
});

describe("publishing a type", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("proposes the rendered Endpoint with its Policy as one Change and gives the link", async () => {
    const sent: { path: string; body: unknown; dryRun: boolean }[] = [];
    renderPage(<SharePanel project="helsinki" space="bikes" type="Station" attributes={["name", "free", "note"]} />, {
      path: "/projects/helsinki/spaces/bikes",
      answer: async (url, request) => {
        if (request.method !== "POST") return undefined;
        const body = (await request.json()) as unknown;
        sent.push({ path: url.pathname, body, dryRun: url.searchParams.get("dryRun") === "All" });
        if (url.pathname.endsWith("/assistant/propose-endpoint")) {
          return json({
            lane: "red",
            slug: "k7m2qz4tv6xh3n5jb2ryd3wcfa",
            endpoint: { apiVersion: "joinedcontext.com/v1alpha1", kind: "Endpoint", metadata: { name: "bikes-station-public" }, spec: {} },
            policies: [{ apiVersion: "joinedcontext.com/v1alpha1", kind: "Policy", metadata: { name: "bikes-station-public-public" }, spec: {} }],
          });
        }
        return url.searchParams.get("dryRun") === "All"
          ? json({ valid: true })
          : json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "Change", metadata: { name: "chg-0000aa01", namespace: "helsinki" }, status: { lane: "red", phase: "PendingApproval" } }, 202);
      },
    });
    const panel = await screen.findByTestId("view-share");
    await userEvent.click(within(panel).getByText(en.spaces.share.title));
    await userEvent.click(within(panel).getByRole("checkbox", { name: "note" }));
    await expectNoViolations(panel);
    await userEvent.click(within(panel).getByRole("button", { name: en.spaces.share.publish }));

    await waitFor(() => expect(sent.filter((s) => s.path.endsWith("/import") && !s.dryRun)).toHaveLength(1));
    expect(sent[0].body).toEqual({
      contextSpace: "bikes",
      name: "bikes-station-public",
      audience: "public",
      entityTypes: ["Station"],
      hiddenAttributes: ["note"],
    });
    const imported = sent.find((s) => s.path.endsWith("/import") && !s.dryRun)?.body as { manifests: { kind: string }[] };
    expect(imported.manifests.map((m) => m.kind)).toEqual(["Policy", "Endpoint"]);
    expect(await within(panel).findByTestId("share-link")).toHaveTextContent(
      `${window.location.origin}/v/k7m2qz4tv6xh3n5jb2ryd3wcfa`,
    );
  });

  it("keeps the proposal closed with the reason while the name is no name", async () => {
    renderPage(<SharePanel project="helsinki" space="bikes" type="Station" attributes={["name"]} />, {
      path: "/projects/helsinki/spaces/bikes",
      answer: async () => undefined,
    });
    const panel = await screen.findByTestId("view-share");
    await userEvent.click(within(panel).getByText(en.spaces.share.title));
    const name = within(panel).getByLabelText(new RegExp(`^${en.spaces.share.name}`));
    await userEvent.clear(name);
    await userEvent.type(name, "Not A Name");
    expect(within(panel).getByRole("button", { name: en.spaces.share.publish })).toHaveAttribute("aria-disabled", "true");
    expect(name).toHaveAttribute("aria-invalid", "true");
  });
});

describe("the public link", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the Endpoint anonymously and shows its type's entities read-only", async () => {
    const reads: Request[] = [];
    renderPage(<PublicViewPage slug="abc" />, {
      path: "/v/abc",
      answer: async (url, request) => {
        if (!url.pathname.startsWith("/api/endpoint/abc/")) return undefined;
        reads.push(request);
        if (url.pathname.endsWith("/types")) return json({ typeList: ["Station"] });
        return json([
          { id: "urn:ngsi-ld:Station:1", type: "Station", name: "Kamppi", free: 4 },
          { id: "urn:ngsi-ld:Station:2", type: "Station", name: "Töölö" },
        ]);
      },
    });
    const table = await screen.findByRole("table", { name: "Station" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([en.entityGrid.id, "name", "free"]);
    expect(within(table).getByText("Kamppi")).toBeInTheDocument();
    expect(screen.getByText("2 entities.")).toBeInTheDocument();
    expect(reads.every((request) => request.credentials === "omit")).toBe(true);
    expect(new URL(reads[1].url).searchParams.get("options")).toBe("keyValues");
    await expectNoViolations(screen.getByTestId("public-view"));
  });

  it("says the view is not published when the Endpoint is gone", async () => {
    renderPage(<PublicViewPage slug="gone" />, {
      path: "/v/gone",
      answer: async (url) => (url.pathname.startsWith("/api/endpoint/gone/") ? json({ title: "Not Found" }, 404) : undefined),
    });
    expect(await screen.findByText(en.spaces.share.notPublished)).toBeInTheDocument();
  });
});
