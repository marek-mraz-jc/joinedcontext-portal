/**
 * The region's public registers as grids (T-2784): one grid per type of `bbsk-registre`, the
 * columns the model gives it with the region's own labels, the name pinned as the row's primary
 * field, and every column filterable at the endpoint.
 */
import { parseGridConfig } from "@joinedcontext/sdk";
import type { ResolvedGridConfig } from "@joinedcontext/sdk";

export const DATASETS = ["hospitals", "social", "bridges", "organizations", "areas"] as const;
export type Dataset = (typeof DATASETS)[number];

export const TYPE_OF: Record<Dataset, string> = {
  hospitals: "Hospital",
  social: "SocialService",
  bridges: "Bridge",
  organizations: "PublicOrganization",
  areas: "AdministrativeArea",
};

/** The columns of each grid, in the order a reader reads them, the primary field first. */
export const COLUMNS: Record<Dataset, string[]> = {
  hospitals: ["name", "hospitalKind", "operatorName", "medicalSpecialties", "address", "legalId"],
  social: ["name", "serviceKind", "serviceForm", "targetGroup", "capacity", "providerKind", "districtName", "address", "url"],
  bridges: ["name", "bridgeCode", "roadClass", "roadNumber", "yearBuilt", "spanCount", "bridgedLength", "structureMaterial", "heritageStatus", "managerName", "districtName"],
  organizations: ["name", "alternateName", "organizationCategory", "address", "legalId"],
  areas: ["name", "areaCode", "divisionLevel", "surfaceArea"],
};

/** The model's enums, by attribute: the columns that are picked rather than typed. */
export const ENUMS: Record<string, readonly string[]> = {
  hospitalKind: ["general", "specialised"],
  serviceForm: ["field", "outpatient", "residentialYearRound", "residentialWeekly", "remote"],
  providerKind: ["municipality", "municipalityFounded", "regionFounded"],
  roadClass: ["motorway", "firstClass", "secondClass", "thirdClass", "local", "service"],
  heritageStatus: ["notListed", "cultural", "culturalAndTechnical"],
  organizationCategory: ["school", "socialCare", "culture", "office"],
  divisionLevel: ["district", "municipality"],
};

export function gridConfig(slug: string, dataset: Dataset, labels: Record<string, string>): ResolvedGridConfig {
  const parsed = parseGridConfig({
    source: { kind: "endpoint", slug },
    type: TYPE_OF[dataset],
    columns: COLUMNS[dataset].map((attr) => ({ attr, label: labels[attr] ?? attr, ...(attr === "name" ? { pinned: true } : {}) })),
    // Every column is one the endpoint answers a `q` about, so a filter is the endpoint's own.
    filters: { allowed: [...COLUMNS[dataset]] },
    pageSize: 25,
    mode: "view",
  });
  if (!parsed.config) {
    throw new Error(`grid ${dataset}: ${parsed.findings.map((f) => f.message).join("; ")}`);
  }
  return parsed.config;
}

/**
 * The endpoint's own download of a whole register (API/02 §3, §4): the same grant as the grid, so
 * the file holds nothing the grid would not show. CSV with human headers, GeoJSON as published.
 */
export function exportUrl(slug: string, dataset: Dataset, format: "csv" | "geojson"): string {
  const query = new URLSearchParams({ type: TYPE_OF[dataset] });
  if (format === "csv") query.set("humanHeaders", "true");
  return `/api/endpoint/${encodeURIComponent(slug)}/file.${format}?${query.toString()}`;
}
