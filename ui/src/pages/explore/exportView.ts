/**
 * Exporting what the explorer shows (T-3253, UI-33): every entity the view's filters match, with
 * its chosen columns, in the view's order, as a file a person keeps. Pure apart from `collect`,
 * which pages through the endpoint, so each format is tested without a page.
 */

export type ExportFormat = "csv-excel" | "csv" | "json" | "geojson";
export const EXPORT_FORMATS: ExportFormat[] = ["csv-excel", "csv", "json", "geojson"];

/** How many entities one export holds at most: past it, the person narrows the filter. */
export const MAX_EXPORT_ROWS = 100_000;
/** One page asked of the endpoint while exporting. */
export const EXPORT_PAGE = 500;

type Entity = Record<string, unknown>;

export interface ViewSort {
  attr: string;
  dir: "asc" | "desc";
}

/** The two NGSI-LD queries joined, as the grid joins its preset and its filter row (EP-07). */
export function andQ(...parts: (string | undefined)[]): string | undefined {
  const kept = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return kept.length === 0 ? undefined : kept.map((part) => (kept.length > 1 && part.includes("|") ? `(${part})` : part)).join(";");
}

/** An attribute's value as keyValues answers it, or the `value` of a normalized one. */
function plain(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("value" in record) return record.value;
    if ("object" in record) return record.object;
  }
  return value;
}

/** The entity's columns: the chosen ones, or every attribute the entities carry, id and type first. */
export function columnsOf(entities: Entity[], chosen: string[] | undefined): string[] {
  if (chosen && chosen.length > 0) return ["id", ...chosen.filter((attr) => attr !== "id" && attr !== "type")];
  const seen = new Set<string>();
  for (const entity of entities) for (const key of Object.keys(entity)) if (key !== "id" && key !== "type" && key !== "@context") seen.add(key);
  return ["id", "type", ...seen];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * One cell as text. `excel-sk` writes what Slovak Excel reads as numbers and dates: a decimal comma
 * and `dd.mm.yyyy hh:mm:ss` in the person's own time zone; `plain` keeps the API's own forms.
 */
export function cellText(value: unknown, style: "excel-sk" | "plain"): string {
  const v = plain(value);
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return style === "excel-sk" ? String(v).replace(".", ",") : String(v);
  if (typeof v === "boolean") return String(v);
  if (typeof v === "string") {
    if (style === "excel-sk" && ISO_DATE.test(v)) {
      const at = new Date(v);
      if (!Number.isNaN(at.getTime())) {
        const day = `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()}`;
        return v.length === 10 ? day : `${day} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
      }
    }
    return v;
  }
  return JSON.stringify(v);
}

/**
 * A CSV field. A text starting with `=`, `+`, `-`, `@`, a tab or a carriage return is what a
 * spreadsheet runs as a formula, so it is written with a leading apostrophe and stays text.
 */
function field(text: string, separator: string, numeric: boolean): string {
  const safe = !numeric && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /["\n\r]/.test(safe) || safe.includes(separator) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows as CSV: `excel-sk` with `;`, a byte-order mark and CRLF, so Slovak Excel opens it as is. */
export function toCsv(entities: Entity[], columns: string[], style: "excel-sk" | "plain"): string {
  const separator = style === "excel-sk" ? ";" : ",";
  const newline = style === "excel-sk" ? "\r\n" : "\n";
  const lines = [columns.map((column) => field(column, separator, false)).join(separator)];
  for (const entity of entities) {
    lines.push(
      columns
        .map((column) => {
          const value = plain(entity[column]);
          return field(cellText(value, style), separator, typeof value === "number");
        })
        .join(separator),
    );
  }
  return (style === "excel-sk" ? "﻿" : "") + lines.join(newline) + newline;
}

/** The first GeoJSON geometry an entity carries, the `location` attribute before any other. */
export function geometryOf(entity: Entity): { type: string; coordinates: unknown } | undefined {
  const candidates = ["location", ...Object.keys(entity).filter((key) => key !== "location")];
  for (const key of candidates) {
    const value = plain(entity[key]);
    if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string" && "coordinates" in value) {
      return value as { type: string; coordinates: unknown };
    }
  }
  return undefined;
}

/** The located entities as a GeoJSON FeatureCollection; `null` when none carries a geometry. */
export function toGeoJson(entities: Entity[], columns: string[]): string | null {
  const features = entities.flatMap((entity) => {
    const geometry = geometryOf(entity);
    if (!geometry) return [];
    const properties: Record<string, unknown> = {};
    for (const column of columns) {
      if (column === "id") continue;
      const value = plain(entity[column]);
      if (value !== undefined && value !== geometry) properties[column] = value;
    }
    return [{ type: "Feature", id: entity.id, geometry, properties }];
  });
  return features.length === 0 ? null : JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}

/** The entities in the view's order: numbers by value, everything else as text, empty last. */
export function sortEntities(entities: Entity[], sort: ViewSort | null | undefined): Entity[] {
  if (!sort) return entities;
  const factor = sort.dir === "asc" ? 1 : -1;
  return [...entities].sort((a, b) => {
    const left = plain(a[sort.attr]);
    const right = plain(b[sort.attr]);
    if (left === undefined || left === null) return right === undefined || right === null ? 0 : 1;
    if (right === undefined || right === null) return -1;
    if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
    return cellText(left, "plain").localeCompare(cellText(right, "plain"), undefined, { numeric: true }) * factor;
  });
}

/** The file of one format, its name and its type; `null` when the format has nothing to hold. */
export function exportFile(
  format: ExportFormat,
  entities: Entity[],
  columns: string[],
  base: string,
): { name: string; type: string; text: string } | null {
  switch (format) {
    case "csv-excel":
      return { name: `${base}.csv`, type: "text/csv;charset=utf-8", text: toCsv(entities, columns, "excel-sk") };
    case "csv":
      return { name: `${base}.csv`, type: "text/csv;charset=utf-8", text: toCsv(entities, columns, "plain") };
    case "json":
      return { name: `${base}.json`, type: "application/json", text: JSON.stringify(entities, null, 2) };
    case "geojson": {
      const text = toGeoJson(entities, columns);
      return text === null ? null : { name: `${base}.geojson`, type: "application/geo+json", text };
    }
  }
}

/**
 * Every entity the view matches, a page at a time, until the endpoint has no more or the export
 * is full. `progress` hears the count after each page; an aborted signal stops before the next.
 */
export async function collect(
  page: (offset: number, limit: number) => Promise<{ rows: Entity[]; count?: number }>,
  options: { signal?: AbortSignal; progress?: (done: number, total?: number) => void; max?: number; pageSize?: number } = {},
): Promise<{ entities: Entity[]; truncated: boolean; total?: number }> {
  const max = options.max ?? MAX_EXPORT_ROWS;
  const size = options.pageSize ?? EXPORT_PAGE;
  const entities: Entity[] = [];
  let total: number | undefined;
  for (;;) {
    if (options.signal?.aborted) throw new DOMException("the export was cancelled", "AbortError");
    const limit = Math.min(size, max - entities.length);
    const answer = await page(entities.length, limit);
    total = answer.count ?? total;
    entities.push(...answer.rows);
    options.progress?.(entities.length, total);
    if (answer.rows.length < limit) return { entities, truncated: false, total };
    if (entities.length >= max) return { entities, truncated: total === undefined || total > max, total };
  }
}
