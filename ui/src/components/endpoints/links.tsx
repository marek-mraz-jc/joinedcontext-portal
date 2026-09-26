import type { JSX } from "react";
import { useQueries } from "@tanstack/react-query";
import { clsx } from "clsx";
import { api, queryKeys, unwrap } from "../../api/client";
import { asManifests, refName } from "../../api/manifest";
import type { Manifest } from "../../api/manifest";
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
 * What an Endpoint serves: the representations its manifest lists, then `ngsi-ld` and
 * `geojson`, which every Endpoint serves (EP-10, T-2939), and `mcp`, which every Endpoint
 * serves, public or internal, unless `spec.mcp` is `false` (EP-24). The gateway reads the same
 * rule, so a link shown here answers there; its Policy still decides every call.
 */
export function servedRepresentations(spec: { enabledRepresentations?: unknown; mcp?: unknown }): string[] {
  const listed = Array.isArray(spec.enabledRepresentations)
    ? spec.enabledRepresentations.filter((rep): rep is string => typeof rep === "string")
    : [];
  const always = spec.mcp === false ? ["ngsi-ld", "geojson"] : ["ngsi-ld", "geojson", "mcp"];
  return [...listed, ...always.filter((rep) => !listed.includes(rep))];
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
 * The origin an MCP client connects to: the platform host, which the gateway names as the
 * `resource` of every MCP URL (`JC_GATEWAY_PUBLIC_URL`, built from the same domain the branding
 * serves as `domain`). A client refuses resource metadata that names another URL than the one it
 * called (RFC 9728 §3.3), so the Portal's own host, right for a browser whose edge session is the
 * bearer, is wrong for a connector (T-3019). The page's origin when the installation names no
 * domain, or one that is not a bare host.
 */
export function mcpOrigin(domain: string | undefined): string {
  const host = domain?.trim().toLowerCase() ?? "";
  if (host) {
    try {
      const url = new URL(`https://${host}`);
      if (url.host === host && url.pathname === "/" && !url.username && !url.password) {
        return url.origin;
      }
    } catch {
      // Not a host: the page's own origin below.
    }
  }
  return window.location.origin;
}

/**
 * Where one representation of an endpoint answers: `mcp` on the platform host an MCP client
 * connects to, every other one on this origin, where the edge turns the session into the bearer.
 */
export function representationUrl(slug: string, representation: string, domain: string | undefined): string {
  const path = REPRESENTATION_PATHS[representation] ?? "/";
  return representation === "mcp"
    ? `${mcpOrigin(domain)}/api/endpoint/${encodeURIComponent(slug)}${path}`
    : endpointUrl(slug, path);
}

/**
 * The MCP hub: one connector over every Endpoint the caller may read, the Endpoint named on each
 * call (EP-87, ADR-N-025), on the platform host an MCP client connects to.
 */
export function hubUrl(domain: string | undefined): string {
  return `${mcpOrigin(domain)}/api/mcp`;
}

/**
 * A dataset's page on the site of a `CkanInstance`: `{spec.url}/dataset/{name}`, the address the
 * catalogue API builds too (EP-82). `undefined` for a base that is not an https URL: jc-core
 * refuses any other `spec.url`, and a link is never built from what it would refuse (T-3018).
 */
export function catalogueUrl(instanceUrl: string, dataset: string): string | undefined {
  let base: URL;
  try {
    base = new URL(instanceUrl);
  } catch {
    return undefined;
  }
  if (base.protocol !== "https:" || base.search || base.hash) {
    return undefined;
  }
  return `${base.href.replace(/\/+$/, "")}/dataset/${encodeURIComponent(dataset)}`;
}

/**
 * The catalogue page of each Endpoint that publishes one (EP-62, EP-82): the dataset its
 * `spec.publish.ckan` names (its own name when that names none) on the site of the `CkanInstance`
 * its `instanceRef` names in the Endpoint's `project`. `undefined` for an Endpoint that publishes
 * nowhere, while the project's catalogues load, and for a catalogue this person cannot read: the
 * link is the instance's own URL or none, never a host guessed from the Portal's (T-3018).
 */
export function useCatalogueLinks(
  projects: string[],
): (project: string, endpoint: Manifest) => string | undefined {
  const unique = [...new Set(projects.filter(Boolean))].sort();
  const lists = useQueries({
    queries: unique.map((project) => ({
      queryKey: queryKeys.list(project, "ckaninstances"),
      retry: false,
      queryFn: async () =>
        unwrap(
          await api.GET("/api/v1/projects/{project}/{plural}", {
            params: { path: { project, plural: "ckaninstances" } },
          }),
        ),
    })),
  });
  const sites = new Map<string, string>();
  unique.forEach((project, index) => {
    for (const instance of asManifests(lists[index]?.data?.items ?? [])) {
      const url = (instance.spec as { url?: unknown }).url;
      if (typeof url === "string") {
        sites.set(`${project}/${instance.metadata.name}`, url);
      }
    }
  });
  return catalogueLinkOf(sites);
}

/** What `useCatalogueLinks` answers, given the sites it resolved per `{project}/{instance}`. */
export function catalogueLinkOf(
  sites: Map<string, string>,
): (project: string, endpoint: Manifest) => string | undefined {
  return (project, endpoint) => {
    const publish = (endpoint.spec as { publish?: { ckan?: { instanceRef?: unknown; name?: unknown } } })
      .publish?.ckan;
    if (!publish) {
      return undefined;
    }
    const site = sites.get(`${project}/${refName(publish.instanceRef)}`);
    const dataset = typeof publish.name === "string" && publish.name ? publish.name : endpoint.metadata.name;
    return site ? catalogueUrl(site, dataset) : undefined;
  };
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
