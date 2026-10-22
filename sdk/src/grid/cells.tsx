/**
 * How a cell reads by what it holds (T-4827): a number in the reader's locale with its unit's
 * symbol, a date in local time, a point as its coordinates, a relationship as a chip naming its
 * target, a structured value as `key: value` pairs. Everything is rendered as text, never as markup
 * (DM-100): React escapes it, and no value reaches `innerHTML`.
 */
import type React from "react";
import type { RichCell } from "./model";
import { cellText } from "./model";
import { addressLine } from "../ngsi";
import { unitSymbol, unitTitle } from "../sdk/units";

/** What a column holds, for its header icon and its cells. */
export type ColumnKind = "text" | "number" | "boolean" | "datetime" | "geo" | "relationship" | "language" | "structured" | "list";

export interface CellLabels {
  yes: string;
  no: string;
  /** "points" after a geometry's vertex count: `Polygon, 12 points`. */
  points: string;
  /** Said before a relationship chip's target: "Open". */
  openTarget: string;
}

/** A stored timestamp or date: what NGSI-LD writes as an ISO 8601 string. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Pairs a structured value shows before it ends in "…": a cell is a summary, the row detail the whole. */
const MAX_PAIRS = 6;

/** The kind of one cell, read off its value. */
export function kindOfCell(cell: RichCell | RichCell[] | undefined): ColumnKind | undefined {
  const one = Array.isArray(cell) ? cell[0] : cell;
  if (!one) return undefined;
  switch (one.kind) {
    case "relationship":
      return "relationship";
    case "geo":
      return "geo";
    case "language":
      return "language";
    case "list":
      return "list";
    case "json":
      return "structured";
    default:
      if (typeof one.value === "number") return "number";
      if (typeof one.value === "boolean") return "boolean";
      if (typeof one.value === "string" && ISO_DATE.test(one.value)) return "datetime";
      if (typeof one.value === "object" && one.value !== null) return Array.isArray(one.value) ? "list" : "structured";
      return "text";
  }
}

/**
 * The kind of a column: the model's word first (a relationship end, a range), else the first cell
 * that holds something, else text.
 */
export function columnKind(
  cells: readonly (RichCell | RichCell[] | undefined)[],
  range?: string,
  relationship = false,
): ColumnKind {
  if (relationship) return "relationship";
  if (range === "integer" || range === "number") return "number";
  if (range === "boolean") return "boolean";
  if (range === "datetime" || range === "date") return "datetime";
  for (const cell of cells) {
    const kind = kindOfCell(cell);
    if (kind) return kind;
  }
  return "text";
}

/** An NGSI-LD URN as a person reads it: its type and the last part of its id, never the whole URN. */
export function targetName(urn: string): { type?: string; name: string } {
  const parts = urn.split(":");
  if (parts.length >= 4 && parts[0]?.toLowerCase() === "urn" && parts[1]?.toLowerCase() === "ngsi-ld") {
    // urn:ngsi-ld:{Type}:{nss}: the type is the third part, the name the nss's last segment.
    return { type: parts[2], name: parts.at(-1) || urn };
  }
  return { name: urn };
}

export function formatNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
  } catch {
    // An unknown locale tag: the digits as stored still read.
    return String(value);
  }
}

/** A stored date in the reader's locale; a timestamp in their own time zone, a bare date as written. */
export function formatDate(value: string, locale: string): string {
  const at = Date.parse(DATE_ONLY.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(at)) return value;
  try {
    return DATE_ONLY.test(value)
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at)
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
  } catch {
    return value;
  }
}

/** A plain value inside a structured one, formatted as its own cell would be. */
function scalarText(value: unknown, locale: string, labels: CellLabels): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return formatNumber(value, locale);
  if (typeof value === "boolean") return value ? labels.yes : labels.no;
  if (typeof value === "string") {
    if (ISO_DATE.test(value)) return formatDate(value, locale);
    if (/^urn:ngsi-ld:/i.test(value)) return targetName(value).name;
    return value;
  }
  if (Array.isArray(value)) return value.map((each) => scalarText(each, locale, labels)).join(", ");
  return "…";
}

/** `start: 1 Oct 2026 · end: 31 Oct 2026`: an object one level deep, nested values as their text. */
export function structuredText(value: unknown, locale: string, labels: CellLabels): string {
  if (typeof value !== "object" || value === null) return scalarText(value, locale, labels);
  if (Array.isArray(value)) return value.map((each) => structuredText(each, locale, labels)).join(", ");
  const record = value as Record<string, unknown>;
  // A PostalAddress reads as its line (T-3949).
  const address = addressLine(record);
  if (address) return address;
  const pairs = Object.entries(record).filter(([, each]) => each !== null && each !== undefined && each !== "");
  const shown = pairs.slice(0, MAX_PAIRS).map(([key, each]) => {
    const text =
      typeof each === "object" && each !== null && !Array.isArray(each)
        ? `(${Object.entries(each as Record<string, unknown>).map(([k, v]) => `${k}: ${scalarText(v, locale, labels)}`).join(", ")})`
        : scalarText(each, locale, labels);
    return `${key}: ${text}`;
  });
  return `${shown.join(" · ")}${pairs.length > MAX_PAIRS ? " · …" : ""}`;
}

/** Latitude first, as a person reads a place; GeoJSON stores longitude first. */
function pointText(coordinates: unknown, locale: string): string | undefined {
  if (!Array.isArray(coordinates) || typeof coordinates[0] !== "number" || typeof coordinates[1] !== "number") return undefined;
  const digits = (n: number) => {
    try {
      return new Intl.NumberFormat(locale, { minimumFractionDigits: 5, maximumFractionDigits: 5 }).format(n);
    } catch {
      return n.toFixed(5);
    }
  };
  return `${digits(coordinates[1])}, ${digits(coordinates[0])}`;
}

function vertexCount(coordinates: unknown): number {
  if (!Array.isArray(coordinates)) return 0;
  if (typeof coordinates[0] === "number") return 1;
  return coordinates.reduce((sum: number, each) => sum + vertexCount(each), 0);
}

/** A geometry as text: a point's coordinates, any other shape its type and how many points draw it. */
export function geoText(value: unknown, locale: string, labels: CellLabels): string {
  const geometry = value as { type?: unknown; coordinates?: unknown } | null;
  if (!geometry || typeof geometry.type !== "string") return "";
  if (geometry.type === "Point") return pointText(geometry.coordinates, locale) ?? geometry.type;
  const count = vertexCount(geometry.coordinates);
  return count > 0 ? `${geometry.type}, ${formatNumber(count, locale)} ${labels.points}` : geometry.type;
}

/**
 * An http(s) address a cell may link to, else `undefined`. `URL` resolves the escapes and control
 * characters a hand-written check misses, so `java\tscript:` never passes (PF-50, as the Portal's
 * safeHref, without its relative paths: a cell's value is never a path on this host).
 */
export function webHref(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim())) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A cell that reads as a link: a web address as itself, or a `{name, url}` object (an Event's
 * `organizer`, T-5134) as its name linked to its url.
 */
export function cellLink(cell: RichCell | RichCell[] | undefined): { text: string; href: string } | undefined {
  if (cell === undefined || Array.isArray(cell) || cell.kind === "relationship") return undefined;
  const value = cell.value;
  const direct = webHref(value);
  if (direct) return { text: String(value).trim(), href: direct };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const href = webHref(record.url);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return href && name ? { text: name, href } : undefined;
}

/** One cell's text, as `CellView` shows it: what an export, a title or a test reads. */
export function cellDisplayText(cell: RichCell | RichCell[] | undefined, locale: string, labels: CellLabels): string {
  if (cell === undefined) return "";
  if (Array.isArray(cell)) return cell.map((one) => cellDisplayText(one, locale, labels)).filter(Boolean).join(" | ");
  switch (kindOfCell(cell)) {
    case "relationship": {
      const objects = Array.isArray(cell.object) ? cell.object : cell.object ? [cell.object] : [];
      return objects.map((urn) => targetName(urn).name).join(", ");
    }
    case "geo":
      return geoText(cell.value, locale, labels);
    case "number": {
      const symbol = unitSymbol(cell.unitCode);
      const text = formatNumber(cell.value as number, locale);
      return symbol ? `${text} ${symbol}` : text;
    }
    case "boolean":
      return cell.value ? labels.yes : labels.no;
    case "datetime":
      return formatDate(cell.value as string, locale);
    case "structured":
      return cellLink(cell)?.text ?? structuredText(cell.value, locale, labels);
    case "list":
      return structuredText(cell.value, locale, labels);
    default:
      return cellText(cell);
  }
}

/** The full value behind a summary, for the hover: the URN, the stored timestamp, the unit's name. */
function titleOf(cell: RichCell): string | undefined {
  if (cell.kind === "relationship") return Array.isArray(cell.object) ? cell.object.join(", ") : cell.object;
  if (cell.kind === "property" && cell.unitCode) return unitTitle(cell.unitCode);
  if (typeof cell.value === "string" && ISO_DATE.test(cell.value)) return cell.value;
  return undefined;
}

export interface CellViewProps {
  cell: RichCell | RichCell[] | undefined;
  locale: string;
  labels: CellLabels;
  /** Opens a relationship's target; without it a chip is a label, not a button. */
  onOpen?: (urn: string) => void;
}

/** One cell as the grid draws it in a reader's view. */
export function CellView({ cell, locale, labels, onOpen }: CellViewProps): React.JSX.Element {
  if (cell === undefined) return <></>;
  const all = Array.isArray(cell) ? cell : [cell];
  const relationships = all.filter((one) => one.kind === "relationship");
  if (relationships.length > 0 && relationships.length === all.length) {
    const urns = relationships.flatMap((one) => (Array.isArray(one.object) ? one.object : one.object ? [one.object] : []));
    return (
      <span className="jc-cell-chips">
        {urns.map((urn, at) => {
          const target = targetName(urn);
          const text = target.type ? `${target.type} · ${target.name}` : target.name;
          return onOpen ? (
            <button
              key={`${urn}-${at}`}
              type="button"
              className="jc-cell-chip"
              title={urn}
              aria-label={`${labels.openTarget}: ${text}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(urn);
              }}
            >
              {target.name}
            </button>
          ) : (
            <span key={`${urn}-${at}`} className="jc-cell-chip" title={urn}>
              {target.name}
            </span>
          );
        })}
      </span>
    );
  }
  const one = all[0];
  const text = cellDisplayText(cell, locale, labels);
  const kind = kindOfCell(cell);
  const link = cellLink(cell);
  if (link) {
    const safe = link.href;
    return (
      <a
        className="jc-cell jc-cell--link"
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        title={safe}
        onClick={(e) => e.stopPropagation()}
      >
        {link.text}
      </a>
    );
  }
  return (
    <span className={`jc-cell jc-cell--${kind ?? "text"}`} title={one && !Array.isArray(cell) ? titleOf(one) : undefined}>
      {text}
    </span>
  );
}
