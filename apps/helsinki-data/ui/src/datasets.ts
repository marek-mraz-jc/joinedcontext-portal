/**
 * Helsinki's open data as grids (T-2788): one grid per type of the public space `helsinki`, the
 * columns the model gives it with the city's own labels, the name pinned as the row's primary
 * field, and every column filterable at the endpoint. An event's contact point is left out: it can
 * name a person.
 */
import { parseGridConfig } from "@joinedcontext/sdk";
import type { ResolvedGridConfig } from "@joinedcontext/sdk";

export const DATASETS = ["services", "permits", "events", "alerts", "zones", "districts", "water", "air", "weather"] as const;
export type Dataset = (typeof DATASETS)[number];

export const TYPE_OF: Record<Dataset, string> = {
  services: "PointOfInterest",
  permits: "PublicAreaPermit",
  events: "Event",
  alerts: "Alert",
  zones: "ParkingZone",
  districts: "CityDistrict",
  water: "WaterQualityObserved",
  air: "AirQualityObserved",
  weather: "WeatherObserved",
};

/** The columns of each grid, in the order a reader reads them, the primary field first. */
export const COLUMNS: Record<Dataset, string[]> = {
  services: ["name", "serviceCategory", "address", "openingHours", "url", "dateModified"],
  permits: ["name", "permitKind", "permitStatus", "permitNumber", "permitStart", "permitEnd", "address"],
  events: ["name", "startDate", "endDate", "eventStatus", "address"],
  alerts: ["name", "category", "subCategory", "address", "dateIssued", "validFrom", "validTo"],
  zones: ["name", "zoneKind", "zoneCode", "url"],
  districts: ["name", "districtCode", "divisionLevel"],
  water: ["name", "temperature", "dateObserved"],
  air: ["name", "dateObserved", "pm10", "pm25", "airQualityIndex"],
  weather: ["name", "dateObserved", "temperature", "roadSurfaceTemperature", "relativeHumidity", "windSpeed", "windDirection", "precipitation"],
};

/** The model's enums, by attribute: the columns that are picked rather than typed. */
export const ENUMS: Record<string, readonly string[]> = {
  serviceCategory: ["library", "healthStation", "swimmingHall", "beach", "school"],
  permitKind: ["excavation", "trafficArrangement", "event"],
  permitStatus: ["upcoming", "ongoing", "setup", "teardown"],
  zoneKind: ["fee", "resident"],
  divisionLevel: ["district", "subDistrict"],
};

export function gridConfig(slug: string, dataset: Dataset, labels: Record<string, string>): ResolvedGridConfig {
  const [primary] = COLUMNS[dataset];
  const parsed = parseGridConfig({
    source: { kind: "endpoint", slug },
    type: TYPE_OF[dataset],
    columns: COLUMNS[dataset].map((attr) => ({ attr, label: labels[attr] ?? attr, ...(attr === primary ? { pinned: true } : {}) })),
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
 * The endpoint's own download of a whole dataset (API/02 §3, §4): the same grant as the grid, so
 * the file holds nothing the grid would not show. CSV with human headers, GeoJSON as published.
 */
export function exportUrl(slug: string, dataset: Dataset, format: "csv" | "geojson"): string {
  const query = new URLSearchParams({ type: TYPE_OF[dataset] });
  if (format === "csv") query.set("humanHeaders", "true");
  return `/api/endpoint/${encodeURIComponent(slug)}/file.${format}?${query.toString()}`;
}
