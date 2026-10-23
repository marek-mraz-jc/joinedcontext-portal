/**
 * Where an entity grid reads and writes (UI-71, SDK-29): an interface, two built-in sources over
 * the SDK transport, and an in-memory one for tests and examples.
 *
 * A source holds no credential: the transport carries the person's session and CSRF header as
 * every other SDK call does, so an Endpoint's Policy decides every read and write (EP-55). A config
 * names a slug or a space, never a URL, so these two path shapes are the only ones a grid reaches.
 */
import type { Transport } from "../sdk/transport";
import { queryString } from "../sdk/query";
import type { GeoQuery } from "./geoarea";
import type { RichRow } from "./model";
import { toRichRow } from "./model";

export interface GridQuery {
  type: string;
  q?: string;
  attrs?: string[];
  idPattern?: string;
  scopeQ?: string;
  /** Exactly these entities, for a side-by-side read of one page (T-1435). */
  ids?: string[];
  /** The area drawn on the map, as a geo query the endpoint answers (UI-72). */
  area?: GeoQuery;
  /** The order of the whole answer, as CIM 009 4.23 writes it: `attr` or `attr;desc`. */
  orderBy?: string;
}

export interface GridPage {
  rows: RichRow[];
  /** Known only where the source can count; the grid then pages by whether a page came back full. */
  total?: number;
}

export interface HistoryPoint {
  at: string;
  value: unknown;
  /** When a later version replaced this one; only in a `versions` answer (DM-114). */
  supersededAt?: string;
  /** Who wrote this version, through what and why (ADR-N-054 §2.3); only in a `versions` answer. */
  provenance?: Provenance;
}

/** The provenance the broker keeps per version: the fields a person reads, as the broker sent them. */
export interface Provenance {
  channel?: string;
  actor?: string;
  operation?: string;
  reason?: string;
  writtenAt?: string;
}

export interface HistoryWindow {
  from?: string;
  to?: string;
  lastN?: number;
  /** Every version of each measurement (`versions=all`): the gateway answers 403 without `readVersions`. */
  versions?: boolean;
}

/** What a grid can do follows what its source offers: an absent capability switches its feature off. */
export interface EntitySource {
  /** The source orders the whole answer by `GridQuery.orderBy`; without it the grid sorts a page. */
  orders?: boolean;
  /** The Endpoint base (`/api/endpoint/{slug}`) whose OGC vector tiles draw the map past a count (T-5195). */
  tilesAt?: string;
  query(q: GridQuery, page: { offset: number; limit: number }): Promise<GridPage>;
  get(id: string): Promise<RichRow | null>;
  history?(id: string, attr: string, window: HistoryWindow): Promise<HistoryPoint[]>;
  /** `reason` is why the person writes, sent as `JC-Reason` (DM-113). */
  patch?(id: string, attrs: Record<string, unknown>, reason?: string): Promise<void>;
  remove?(id: string): Promise<void>;
}

export class SourceError extends Error {
  readonly status: number;
  /** The attribute the refusal is about, where the problem names one (`slot`, DM-70). */
  readonly slot?: string;
  constructor(status: number, message: string, slot?: string) {
    super(message);
    this.name = "SourceError";
    this.status = status;
    this.slot = slot;
  }
}

/**
 * `NGSILD-Results-Count`, when the answer carries one. An answer the gateway narrowed carries
 * none on purpose (R22): the count would say how many entities were withheld, so the grid pages
 * by whether a page came back full instead of showing a total it was not told.
 */
function resultsCount(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["ngsild-results-count"]?.trim();
  if (!raw) {
    return undefined;
  }
  const count = Number(raw);
  return Number.isInteger(count) && count >= 0 ? count : undefined;
}

/**
 * The URL a query of this many ids would carry, split so no query string grows past `maxChars`.
 * A gateway, a proxy and nginx all have a line length of their own; 4 000 characters is under
 * every default, and a page of 25 urns fits in one read (T-1435).
 */
export function idChunks(ids: string[], maxChars = 3_500): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const id of ids) {
    const cost = encodeURIComponent(id).length + 3;
    if (current.length > 0 && length + cost > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(id);
    length += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** The attribute a problem document names as the one refused, where it names one. */
function slotOf(body: unknown): string | undefined {
  const slot = typeof body === "object" && body !== null ? (body as { slot?: unknown }).slot : undefined;
  return typeof slot === "string" && slot !== "" ? slot : undefined;
}

/** The problem document's own sentence, or `fallback`. */
function detailOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const problem = body as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === "string" && problem.detail) return problem.detail;
    if (typeof problem.title === "string" && problem.title) return problem.title;
  }
  return fallback;
}

function entitiesQuery(q: GridQuery, offset: number, limit: number): string {
  // id and type come with every entity; asking for them as attributes is a 400.
  const attrs = (q.attrs ?? []).filter((attr) => attr !== "id" && attr !== "type");
  return queryString({
    type: q.type,
    options: "sysAttrs",
    // How many entities the query matches, for the footer: the broker counts, the grid never does
    // (a page cannot be counted into a total).
    count: "true",
    limit: String(limit),
    offset: offset > 0 ? String(offset) : undefined,
    q: q.q || undefined,
    attrs: attrs.length > 0 ? attrs.join(",") : undefined,
    idPattern: q.idPattern || undefined,
    scopeQ: q.scopeQ || undefined,
    id: q.ids && q.ids.length > 0 ? q.ids.join(",") : undefined,
    // The four of a geo query travel together or not at all: `georel` without `coordinates` is a
    // 400, and `coordinates` without `georel` is silently ignored, which reads as an empty area.
    georel: q.area?.georel,
    geometry: q.area?.geometry,
    coordinates: q.area?.coordinates,
    geoproperty: q.area?.geoproperty,
    orderBy: q.orderBy || undefined,
  });
}

function historyQuery(attr: string, window: HistoryWindow): string {
  const { from, to, lastN, versions } = window;
  return queryString({
    attrs: attr,
    versions: versions ? "all" : undefined,
    timerel: from && to ? "between" : from ? "after" : to ? "before" : undefined,
    timeAt: from ?? to,
    endTimeAt: from && to ? to : undefined,
    lastN: lastN !== undefined ? String(lastN) : undefined,
  });
}

/** The text fields of a version's provenance; anything else the broker adds is not shown. */
function provenanceOf(raw: unknown): Provenance | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const kept: Provenance = {};
  for (const key of ["channel", "actor", "operation", "reason", "writtenAt"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string") kept[key] = value;
  }
  return kept;
}

/** The instances of one attribute in a temporal answer: `[{value, observedAt}]`, or `{values: [[v, t]]}`. */
export function historyOf(body: unknown, attr: string): HistoryPoint[] {
  const attribute = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[attr] : undefined;
  if (Array.isArray(attribute)) {
    return attribute.flatMap((instance) => {
      const { observedAt: at, value, supersededAt, provenance } = (instance ?? {}) as Record<string, unknown>;
      if (typeof at !== "string") return [];
      const point: HistoryPoint = { at, value };
      if (typeof supersededAt === "string") point.supersededAt = supersededAt;
      const kept = provenanceOf(provenance);
      if (kept) point.provenance = kept;
      return [point];
    });
  }
  const values = (attribute as { values?: unknown } | undefined)?.values;
  if (Array.isArray(values)) {
    return values.flatMap((pair) =>
      Array.isArray(pair) && typeof pair[1] === "string" ? [{ at: pair[1], value: pair[0] }] : [],
    );
  }
  return [];
}

/**
 * One NGSI-LD API under `base`. `hidden` is what a 404 becomes on a query, a history read or a
 * write: a Context Space surface says the same whether the space is missing or not granted.
 */
function ngsiSource(base: string, transport: Transport, language: string, hidden?: string, tilesAt?: string): EntitySource {
  const refuse = (status: number, body: unknown, fallback: string): never => {
    if (status === 404 && hidden) throw new SourceError(404, hidden);
    throw new SourceError(status, detailOf(body, fallback), slotOf(body));
  };
  const ok = (status: number) => status >= 200 && status < 300;
  const entity = (id: string) => `${base}/entities/${encodeURIComponent(id)}`;

  return {
    orders: true,
    tilesAt,
    async query(q, page) {
      const { status, body, headers } = await transport({
        method: "GET",
        path: `${base}/entities?${entitiesQuery(q, page.offset, page.limit)}`,
      });
      if (!ok(status)) refuse(status, body, "the read was refused");
      if (!Array.isArray(body)) throw new SourceError(status, "the answer is not a list of entities");
      return {
        rows: body.map((item) => toRichRow(item as Record<string, unknown>, language)),
        total: resultsCount(headers),
      };
    },
    async get(id) {
      const { status, body } = await transport({ method: "GET", path: `${entity(id)}?options=sysAttrs` });
      if (status === 404) return null;
      if (!ok(status)) refuse(status, body, "the read was refused");
      return toRichRow(body as Record<string, unknown>, language);
    },
    async history(id, attr, window) {
      const { status, body } = await transport({
        method: "GET",
        path: `${base}/temporal/entities/${encodeURIComponent(id)}?${historyQuery(attr, window)}`,
      });
      // An Endpoint answers 404 both for an entity with no instances and for one its grants do not
      // reach, and both are "nothing recorded here" (EP-07, T-2972); a space's 404 still says it
      // grants nothing, as its query does.
      if (status === 404 && !hidden) return [];
      if (!ok(status)) refuse(status, body, "the history was refused");
      return historyOf(body, attr);
    },
    async patch(id, attrs, reason) {
      const { status, body } = await transport({ method: "PATCH", path: `${entity(id)}/attrs`, body: attrs, reason });
      if (!ok(status)) refuse(status, body, "the write was refused");
    },
    async remove(id) {
      const { status, body } = await transport({ method: "DELETE", path: entity(id) });
      if (!ok(status)) refuse(status, body, "the removal was refused");
    },
  };
}

/** What one Endpoint answers, by its slug (EP-55). */
export function endpointSource(slug: string, transport: Transport, language = "en"): EntitySource {
  const endpoint = `/api/endpoint/${encodeURIComponent(slug)}`;
  return ngsiSource(`${endpoint}/ngsi-ld/v1`, transport, language, undefined, endpoint);
}

/** A whole Context Space surface, by its segment (SP-06); a 404 never says whether the space exists. */
export function spaceSource(space: string, transport: Transport, language = "en"): EntitySource {
  return ngsiSource(`/cs/${encodeURIComponent(space)}/ngsi-ld/v1`, transport, language, "no grant on this space");
}

/** Entities in memory, for tests and examples: type and idPattern filter, paging, a total. */
export function fixtureSource(entities: Record<string, unknown>[], language = "en"): EntitySource {
  const rows = entities.map((entity) => toRichRow(entity, language));
  return {
    orders: true,
    async query(q, page) {
      const pattern = q.idPattern ? new RegExp(q.idPattern) : null;
      const matching = rows.filter(
        (row) =>
          row.type === q.type &&
          (!pattern || pattern.test(row.id)) &&
          (!q.ids || q.ids.includes(row.id)),
      );
      const ordered = q.orderBy ? orderRows(matching, q.orderBy) : matching;
      return { rows: ordered.slice(page.offset, page.offset + page.limit), total: matching.length };
    },
    async get(id) {
      return rows.find((row) => row.id === id) ?? null;
    },
  };
}

/**
 * `rows` in the order `orderBy` names (`attr` or `attr;desc`, one key), as the broker orders them
 * (CIM 009 4.23.1): numbers by value, other values by their text, an entity without the attribute
 * after every one that has it, either way.
 */
export function orderRows(rows: RichRow[], orderBy: string): RichRow[] {
  const [attr, dir] = orderBy.split(";");
  const factor = dir === "desc" ? -1 : 1;
  const valueOf = (row: RichRow): unknown => {
    if (attr === "id") return row.id;
    const cell = row.cells[attr];
    const one = Array.isArray(cell) ? cell[0] : cell;
    return one?.kind === "relationship" ? one.object : one?.value;
  };
  return [...rows].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    const missingX = x === undefined || x === null;
    const missingY = y === undefined || y === null;
    if (missingX || missingY) return Number(missingX) - Number(missingY);
    if (typeof x === "number" && typeof y === "number") return factor * (x - y);
    return factor * String(x).localeCompare(String(y));
  });
}

/** The built-in source a config names. */
export function sourceFor(
  config: { kind: "endpoint"; slug: string } | { kind: "space"; space: string },
  transport: Transport,
  language?: string,
): EntitySource {
  return config.kind === "endpoint"
    ? endpointSource(config.slug, transport, language)
    : spaceSource(config.space, transport, language);
}
