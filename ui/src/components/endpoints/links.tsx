import type { JSX } from "react";
import { clsx } from "clsx";
import { Icon, safeHref } from "../ui";

/**
 * Where each enabled representation answers under the endpoint's URL (EP-08, EP-44): the
 * same paths the gateway's DCAT index at `/api/endpoint/{slug}/` lists, so a steward can hand
 * out one link per shape without opening the index.
 */
export const REPRESENTATION_PATHS: Record<string, string> = {
  // A read names a type: a query with no selector is 400 BadRequestData (GW33, CIM 009
  // 5.7.2.4), and the endpoint's own type list is the conformant way in — every type it
  // serves, each one a query away. The grants decide which of them answer.
  "ngsi-ld": "/ngsi-ld/v1/types",
  mcp: "/mcp",
  geojson: "/file.geojson",
  csv: "/file.csv",
  xlsx: "/file.xlsx",
  zip: "/file.zip",
  "ogc-features": "/ogc/features",
  sta: "/sta/v1.1",
};

/**
 * What an Endpoint serves: the representations its manifest lists plus `mcp`, which every
 * Endpoint serves, public or internal, unless `spec.mcp` is `false` (EP-24). The gateway reads
 * the same rule, so a link shown here answers there; its Policy still decides every call.
 */
export function servedRepresentations(spec: { enabledRepresentations?: unknown; mcp?: unknown }): string[] {
  const listed = Array.isArray(spec.enabledRepresentations)
    ? spec.enabledRepresentations.filter((rep): rep is string => typeof rep === "string")
    : [];
  return spec.mcp === false || listed.includes("mcp") ? listed : [...listed, "mcp"];
}

/** The links every endpoint has whatever it enables: its index and the model it publishes. */
export const ENDPOINT_LINKS: Array<{ key: string; path: string }> = [
  { key: "index", path: "/" },
  { key: "linkml", path: "/schema/v1/linkml" },
  { key: "jsonSchema", path: "/schema/v1/json-schema" },
  { key: "access", path: "/access" },
];

/**
 * Where an endpoint answers. The slug comes out of a manifest, so it is encoded the same way
 * the catalogue encodes a name: a slug carrying `../`, `?` or `#` would otherwise build a link
 * to somewhere else on this origin, and `safeHref` would pass it because it is a real URL.
 */
export function endpointUrl(slug: string, path: string): string {
  return `${window.location.origin}/api/endpoint/${encodeURIComponent(slug)}${path}`;
}

/**
 * The MCP hub: one connector over every Endpoint the caller may read, the Endpoint named on each
 * call (EP-87, ADR-N-025). On this origin like every Endpoint URL the Portal shows.
 */
export function hubUrl(): string {
  return `${window.location.origin}/api/mcp`;
}

/** The open-data catalogue entry of an endpoint: the catalogue lives at `data.{host}`. */
export function catalogueUrl(endpointName: string): string {
  return `https://data.${window.location.host}/dataset/${encodeURIComponent(endpointName)}`;
}

const LINK_PRIMARY =
  "border-primary-200 bg-primary-soft font-medium text-primary-soft-fg hover:border-primary-400 hover:bg-primary-100";
const LINK_MUTED =
  "border-border text-fg-muted hover:border-border-strong hover:bg-surface-muted hover:text-fg";

/** A pill that opens one URL of an endpoint in a new tab; `muted` for the links every endpoint has. */
export function EndpointLink({
  href,
  children,
  muted = false,
}: {
  href: string;
  children: string;
  muted?: boolean;
}): JSX.Element {
  const safe = safeHref(href);
  if (!safe) {
    // A URL the Portal did not build: the words stay, the link is withheld (PF-50).
    return <span className="font-mono text-caption text-fg-muted">{children}</span>;
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noreferrer"
      title={safe}
      className={clsx(
        "focus-ring inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-caption",
        muted ? LINK_MUTED : LINK_PRIMARY,
      )}
    >
      {children}
      <Icon name="external" className="size-3" />
    </a>
  );
}
