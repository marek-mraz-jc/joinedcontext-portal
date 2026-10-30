import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import type { Manifest } from "../src/api/manifest";
import { endpointRows } from "../src/pages/endpoints/endpointRows";
import { MASK, manifestYaml } from "../src/components/grid/ManifestYamlDialog";
import { CallsCell } from "../src/routes/EndpointsPage";

const API = "joinedcontext.com/v1alpha1";

function endpoint(project: string, name: string): Manifest {
  return {
    apiVersion: API,
    kind: "Endpoint",
    metadata: { name, namespace: project },
    spec: { contextSpaceRef: "s", slug: `${name}aaaaaaaaaaaaaaaaaaaaaaaaaa` },
    status: { phase: "Live" },
  } as Manifest;
}

function reference(name: string, project: string, endpointName: string): Manifest {
  return {
    apiVersion: API,
    kind: "SharedSpaceReference",
    metadata: { name, namespace: "espoo" },
    spec: { endpointRef: { project, name: endpointName }, alias: name },
  } as Manifest;
}

describe("the one Endpoints grid (T-6169)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("lists own rows, then shared rows with their reference, then references nothing shares", () => {
    const rows = endpointRows(
      "espoo",
      [endpoint("espoo", "mine")],
      [
        { source: "helsinki", endpoint: endpoint("helsinki", "bikes") },
        { source: "helsinki", endpoint: endpoint("helsinki", "events") },
      ],
      [reference("helsinki-bikes", "helsinki", "bikes"), reference("gone", "vantaa", "air")],
    );
    expect(rows.map((row) => [row.key, row.own, row.source, row.reference?.metadata.name ?? null])).toEqual([
      ["espoo/mine", true, "espoo", null],
      ["helsinki/bikes", false, "helsinki", "helsinki-bikes"],
      ["helsinki/events", false, "helsinki", null],
      ["gone/gone", false, null, "gone"],
    ]);
    expect(rows[3]?.endpoint).toBeNull();
  });

  it("shows a manifest as YAML without its status and with secret-like values masked", () => {
    const text = manifestYaml({
      ...endpoint("espoo", "mine"),
      spec: {
        contextSpaceRef: "s",
        cachedTokenSecretRef: { name: "helsinki-token", key: "token" },
        auth: { password: "hunter2", apiKey: "k-123" },
      },
    } as Manifest);
    expect(text).toContain("kind: Endpoint");
    expect(text).toContain("name: helsinki-token");
    expect(text).not.toContain("status");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("k-123");
    expect(text).toContain(`password: "${MASK}"`);
  });

  it("says the 7-day calls with the surfaces they came through, and a dash while unknown", () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <CallsCell known calls={{ name: "mine", slug: "x", total: 1234, daily: [], totals: { "ngsi-ld": 1200, mcp: 34, ogc: 0 } }} />
      </I18nextProvider>,
    );
    const cell = screen.getByText(/^1,234/);
    expect(cell).toHaveAttribute("title", expect.stringMatching(/NGSI-LD 1,200 · MCP 34/));
    expect(cell).toHaveTextContent(/NGSI-LD 1,200, MCP 34/);
    expect(cell.title).not.toMatch(/OGC/);
    rerender(
      <I18nextProvider i18n={i18n}>
        <CallsCell known={false} calls={undefined} />
      </I18nextProvider>,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
