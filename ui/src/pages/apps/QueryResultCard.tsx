import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "../../components/ui";

/**
 * What the assistant read from an endpoint through its data-plane MCP tools (AG-75): which
 * endpoint, which tool, the argument that matters, and the answer as a small table, a list of
 * fields or the text itself. The gateway wrote the answer and the model chose the call, so
 * every value is drawn as text, never as markup (AG-46).
 */

/** How many rows, attributes and characters the card draws; the step keeps the whole answer. */
export const MAX_ROWS = 10;
export const MAX_ATTRIBUTES = 5;
export const MAX_TEXT = 2000;

export type QueryView =
  | { kind: "table"; columns: string[]; rows: { id: string; cells: string[] }[]; total: number }
  | { kind: "fields"; fields: [string, string][] }
  | { kind: "text"; text: string };

export interface QueryResult {
  endpoint: string;
  tool: string;
  argument?: string;
  view: QueryView;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An attribute's value as text: a normalized Property or Relationship unwrapped, keyValues as is. */
function unwrap(value: unknown): unknown {
  if (isRecord(value)) {
    if ("value" in value) {
      return value.value;
    }
    if ("object" in value) {
      return value.object;
    }
  }
  return value;
}

const GEOMETRIES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

/** Every `[x, y]` position under a GeoJSON value, in any nesting. */
function positionsOf(value: unknown, into: [number, number][] = []): [number, number][] {
  if (Array.isArray(value)) {
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      into.push([value[0], value[1]]);
    } else {
      value.forEach((item) => positionsOf(item, into));
    }
  } else if (isRecord(value)) {
    positionsOf(value.coordinates, into);
    positionsOf(value.geometries, into);
  }
  return into;
}

const coordinate = (n: number): string => String(Math.round(n * 10_000) / 10_000);

/**
 * A GeoJSON geometry as the one line a person reads: its type and where it is, a point by its
 * position and anything wider by its bounding box. A road-work `MultiLineString` is hundreds of
 * coordinates; drawn as JSON it was thousands of digits in one cell (T-2460). The Portal may
 * already have folded it to `{ type, bbox, positions }`, which reads the same way.
 */
function geometryText(value: Record<string, unknown>): string | null {
  const kind = value.type;
  if (typeof kind !== "string" || !GEOMETRIES.has(kind)) {
    return null;
  }
  const given = Array.isArray(value.bbox) && value.bbox.length === 4 ? (value.bbox as unknown[]) : null;
  let box: number[] | null = given?.every((n) => typeof n === "number") ? (given as number[]) : null;
  if (box === null) {
    const positions = positionsOf(value);
    if (positions.length === 0) {
      return value.coordinates === undefined && value.geometries === undefined ? null : kind;
    }
    box = positions.reduce(
      ([w, s, e, n], [x, y]) => [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  }
  const [w, s, e, n] = box.map(coordinate);
  return w === e && s === n ? `${kind} [${w}, ${s}]` : `${kind} [${w}, ${s} … ${e}, ${n}]`;
}

export function textOf(value: unknown, language?: string): string {
  const plain = unwrap(value);
  const geometry = isRecord(plain) ? geometryText(plain) : null;
  if (geometry !== null) {
    return geometry;
  }
  if (plain === null || plain === undefined) {
    return "";
  }
  if (typeof plain === "string") {
    return plain;
  }
  if (typeof plain === "number" || typeof plain === "boolean") {
    return String(plain);
  }
  // A LanguageProperty in keyValues is `{ languageMap: { en: …, fi: … } }`; a person reads the
  // one in their language, not the map (T-2760).
  if (isRecord(plain) && isRecord(plain.languageMap)) {
    const map = plain.languageMap;
    const chosen = (language !== undefined ? map[language] : undefined) ?? map.en ?? Object.values(map)[0];
    return textOf(chosen, language);
  }
  if (Array.isArray(plain)) {
    return plain.map((item) => textOf(item, language)).join(", ");
  }
  if (isRecord(plain)) {
    return Object.entries(plain)
      .map(([key, inner]) => `${key}: ${textOf(inner, language)}`)
      .join("; ");
  }
  return String(plain);
}

/** The last segment of an NGSI-LD URN, which is what a person reads as the entity's name. */
export function localId(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1] || id;
}

const SKIPPED = new Set(["id", "type", "@context"]);

function entitiesOf(value: unknown): Record<string, unknown>[] | null {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.entities)
      ? value.entities
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : null;
  if (list === null || !list.every((item) => isRecord(item) && typeof item.id === "string")) {
    return null;
  }
  return list as Record<string, unknown>[];
}

/** The answer of an MCP `tools/call`: its structured content, or the JSON its text holds, or the text. */
function answerOf(output: unknown): unknown {
  if (!isRecord(output)) {
    return output;
  }
  if (output.structuredContent !== undefined) {
    return output.structuredContent;
  }
  const content = Array.isArray(output.content) ? output.content : [];
  const first = content.find((part) => isRecord(part) && typeof part.text === "string") as
    | { text: string }
    | undefined;
  if (first === undefined) {
    return output;
  }
  try {
    return JSON.parse(first.text) as unknown;
  } catch {
    return first.text;
  }
}

/** `language` picks a `languageMap`'s value in the reader's language (T-2769). */
export function viewOf(output: unknown, language?: string): QueryView {
  const answer = answerOf(output);
  const entities = entitiesOf(answer);
  if (entities !== null) {
    const columns: string[] = [];
    for (const entity of entities) {
      for (const key of Object.keys(entity)) {
        if (!SKIPPED.has(key) && !columns.includes(key) && columns.length < MAX_ATTRIBUTES) {
          columns.push(key);
        }
      }
    }
    return {
      kind: "table",
      columns,
      rows: entities.slice(0, MAX_ROWS).map((entity) => ({
        id: localId(entity.id as string),
        cells: columns.map((column) => textOf(entity[column], language)),
      })),
      // A page of a longer set says the set's size, not the page's, when the answer carries it.
      total:
        isRecord(answer) && typeof answer.total === "number" && answer.total > entities.length
          ? answer.total
          : entities.length,
    };
  }
  if (isRecord(answer)) {
    return {
      kind: "fields",
      fields: Object.entries(answer)
        .filter(([key]) => key !== "@context")
        .map(([key, value]) => [key, textOf(value, language)]),
    };
  }
  const text = typeof answer === "string" ? answer : JSON.stringify(answer ?? "");
  return { kind: "text", text: text.slice(0, MAX_TEXT) };
}

/** The card of a `query_endpoint` step, or none when the payload is not one. */
export function queryResultOf(payload: Record<string, unknown>, language?: string): QueryResult | null {
  if (payload.tool !== "query_endpoint" || !isRecord(payload.input)) {
    return null;
  }
  if (payload.status === "failed" || payload.error !== undefined || payload.output === undefined) {
    return null;
  }
  const input = payload.input;
  const endpoint = typeof input.endpoint === "string" ? input.endpoint : "";
  const tool = typeof input.name === "string" ? input.name : "";
  const args = isRecord(input.arguments) ? input.arguments : {};
  const key = ["type", "id", "q"].find((name) => typeof args[name] === "string" && args[name] !== "");
  return {
    endpoint,
    tool,
    argument: key === undefined ? undefined : `${key}: ${String(args[key])}`,
    view: viewOf(payload.output, language),
  };
}

export function QueryResultCard({ result }: { result: QueryResult }): JSX.Element {
  return (
    <div
      data-testid="query-result"
      className="rounded-lg border border-border bg-surface p-2 text-xs"
    >
      <p className="flex flex-wrap items-baseline gap-x-2 font-medium">
        <span>
          {result.endpoint} · {result.tool}
        </span>
        {result.argument !== undefined ? (
          <span className="font-mono text-fg-muted">{result.argument}</span>
        ) : null}
      </p>
      <QueryAnswer view={result.view} />
    </div>
  );
}

/** An answer as a small table of entities, a list of fields or the text itself. */
export function QueryAnswer({ view }: { view: QueryView }): JSX.Element {
  const { t } = useTranslation();
  return view.kind === "table" ? (
    <>
      {/* The shared Table, not a hand-made one: the header scope, the caption a screen reader
          reads, and the sideways scroll a keyboard can drive all come from one place (UI-01,
          UI-27). `max-h-48` keeps a ten-row answer inside the conversation instead of pushing
          the thread down. */}
      <Table
        caption={t("assistant.query.caption")}
        zebra={false}
        maxHeight="max-h-48"
        className="mt-1 text-caption"
      >
        <TableHead>
          <TableHeaderCell className="px-2 py-1">{t("assistant.query.id")}</TableHeaderCell>
          {view.columns.map((column) => (
            <TableHeaderCell key={column} className="px-2 py-1">
              {column}
            </TableHeaderCell>
          ))}
        </TableHead>
        <TableBody>
          {view.rows.map((row, index) => (
            <TableRow key={`${row.id}-${index}`}>
              <TableCell className="px-2 py-1 font-mono">{row.id}</TableCell>
              {row.cells.map((cell, cellIndex) => (
                <TableCell key={view.columns[cellIndex]} className="px-2 py-1" title={cell}>
                  {/* A table cell takes no max-width, so the fold is on a block inside it: a
                      4 000-character value used to widen its column to 4 000 characters and
                      push every other column off the card (T-2460). */}
                  <span className="block max-w-48 truncate">{cell}</span>
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-1 text-fg-muted">
        {view.total > view.rows.length
          ? t("assistant.query.someRows", { shown: view.rows.length, total: view.total })
          : t("assistant.query.rows", { count: view.total })}
      </p>
    </>
  ) : view.kind === "fields" ? (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
      {view.fields.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-mono text-fg-muted">{key}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{view.text}</pre>
  );
}
