/**
 * The grid over an OData entity set (T-6644): the same `EntitySource` the NGSI-LD sources are, so a
 * module's own lists (the Portal's Endpoints, a dataroom's datasets, ekiben's streams) are drawn by
 * the one grid with its filters, sort, paging, count, editing and phone layout.
 *
 * The grid speaks NGSI-LD's `q` (its filter row and search box write it, `filters.ts`); this file
 * translates that `q` into `$filter` against the set's `$metadata`, so every literal is typed by
 * the property's declared type and written as OData data: a string between single quotes with
 * each quote doubled, a number only when it reads as one. Nothing a person typed reaches the URL
 * as expression text; what cannot be translated is refused before any request is sent.
 *
 * The person's session goes with every request through the transport (no credential here), and
 * the module decides: a write first asks the set's `$allowed` and shows its reason, then sends
 * `PATCH` with `If-Match`, so a row changed since it was read is refused, never overwritten.
 */
import type { Transport } from "../sdk/transport";
import { SourceError } from "./source";
import type { EntitySource, GridQuery } from "./source";
import type { GridColumn } from "./config";
import { toRichCell } from "./model";
import type { RichCell, RichRow } from "./model";

export interface ODataProperty {
  name: string;
  /** The EDM type as `$metadata` names it, e.g. `Edm.String`, `Edm.Int64`, `Edm.DateTimeOffset`. */
  type: string;
  nullable: boolean;
  /** `Core.Description`, where `$metadata` annotates the property with one. */
  description?: string;
}

/** One entity set as its `$metadata` declares it: what the grid reads columns and literal types from. */
export interface ODataSet {
  entitySet: string;
  entityType: string;
  key: string;
  properties: ODataProperty[];
}

/** The answer of `{set}/$allowed`: whether the call would be served, and why not. */
export interface ODataDecision {
  allowed: boolean;
  reason?: string;
  permission?: string;
}

export type ODataOperation = "read" | "export" | "create" | "update" | "delete";

/** An OData source: an `EntitySource` that also tells its set and asks `$allowed`. */
export interface ODataSource extends EntitySource {
  metadata(): Promise<ODataSet>;
  allowed(op: ODataOperation, id?: string): Promise<ODataDecision>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const NUMERIC = new Set(["Edm.Byte", "Edm.SByte", "Edm.Int16", "Edm.Int32", "Edm.Int64", "Edm.Decimal", "Edm.Double", "Edm.Single"]);
const TEMPORAL = new Set(["Edm.DateTimeOffset", "Edm.Date", "Edm.TimeOfDay"]);
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** The most rows one request asks for: the Portal's OData routes refuse a `$top` above it. */
const MAX_TOP = 1000;
/** The longest `$filter` the grid sends; odata-url refuses a query past 4 KiB. */
const MAX_FILTER = 3_000;

const bad = (message: string) => new SourceError(400, message);

function lastSegment(qualified: string): string {
  const at = qualified.lastIndexOf(".");
  return at < 0 ? qualified : qualified.slice(at + 1);
}

/** The set's entity type out of CSDL JSON (an object) or CSDL XML (a string). */
export function setFromCsdl(body: unknown, entitySet: string): ODataSet {
  const set = typeof body === "string" ? fromXml(body, entitySet) : fromJson(body, entitySet);
  if (!set) {
    throw new SourceError(502, `the $metadata of this list does not declare the entity set ${entitySet}`);
  }
  return set;
}

function fromJson(body: unknown, entitySet: string): ODataSet | null {
  if (typeof body !== "object" || body === null) return null;
  const schemas = Object.entries(body as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] => !entry[0].startsWith("$") && typeof entry[1] === "object" && entry[1] !== null,
  );
  let typeName: string | undefined;
  for (const [, schema] of schemas) {
    for (const member of Object.values(schema)) {
      const container = member as Record<string, unknown>;
      if (container?.$Kind !== "EntityContainer") continue;
      const declared = container[entitySet] as { $Collection?: boolean; $Type?: string } | undefined;
      if (declared?.$Collection && typeof declared.$Type === "string") typeName = declared.$Type;
    }
  }
  if (!typeName) return null;
  const type = schemas.map(([, schema]) => schema[lastSegment(typeName!)]).find((each) => (each as { $Kind?: string })?.$Kind === "EntityType") as
    | Record<string, unknown>
    | undefined;
  const key = (type?.$Key as unknown[] | undefined)?.[0];
  if (!type || typeof key !== "string") return null;
  const properties: ODataProperty[] = [];
  for (const [name, raw] of Object.entries(type)) {
    if (name.startsWith("$") || name.includes("@")) continue;
    const property = raw as Record<string, unknown>;
    if (property.$Kind === "NavigationProperty" || property.$Collection) continue;
    const description = type[`${name}@Core.Description`] ?? property["@Core.Description"];
    properties.push({
      name,
      type: typeof property.$Type === "string" ? property.$Type : "Edm.String",
      nullable: property.$Nullable === true,
      ...(typeof description === "string" ? { description } : {}),
    });
  }
  return { entitySet, entityType: lastSegment(typeName), key, properties };
}

function fromXml(text: string, entitySet: string): ODataSet | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const all = (parent: Document | Element, name: string) => Array.from(parent.getElementsByTagNameNS("*", name));
  const declared = all(doc, "EntitySet").find((each) => each.getAttribute("Name") === entitySet);
  const typeName = declared?.getAttribute("EntityType");
  if (!typeName) return null;
  const type = all(doc, "EntityType").find((each) => each.getAttribute("Name") === lastSegment(typeName));
  const key = type && all(type, "PropertyRef")[0]?.getAttribute("Name");
  if (!type || !key) return null;
  const describe = (element: Element) =>
    Array.from(element.children).find((child) => child.localName === "Annotation" && lastSegment(child.getAttribute("Term") ?? "") === "Description" && /Core/.test(child.getAttribute("Term") ?? ""))?.getAttribute("String") ?? undefined;
  const properties = Array.from(type.children)
    .filter((child) => child.localName === "Property" && !/^Collection\(/.test(child.getAttribute("Type") ?? ""))
    .map((child) => {
      const description = describe(child);
      return {
        name: child.getAttribute("Name") ?? "",
        type: child.getAttribute("Type") ?? "Edm.String",
        // CSDL XML: a property is nullable unless it says Nullable="false".
        nullable: child.getAttribute("Nullable") !== "false",
        ...(description ? { description } : {}),
      };
    })
    .filter((property) => property.name !== "");
  return { entitySet, entityType: lastSegment(typeName), key, properties };
}

/**
 * The grid columns of a set, each column's format from its EDM type. The key is left out: the
 * grid draws a row's id in its own pinned column, which is where the key goes.
 */
export function columnsOf(set: ODataSet): GridColumn[] {
  const format = (type: string): GridColumn["format"] => (NUMERIC.has(type) ? "number" : TEMPORAL.has(type) ? "date" : "text");
  return set.properties.filter((p) => p.name !== set.key).map((p) => ({ attr: p.name, format: format(p.type) }));
}

/** A value as an OData literal of the property's type: refused when it cannot be one. */
export function literalOf(raw: string, property: ODataProperty): string {
  const type = property.type;
  if (type === "Edm.String") return `'${raw.replace(/'/g, "''")}'`;
  if (NUMERIC.has(type)) {
    if (!NUMBER.test(raw)) throw bad(`${property.name} holds numbers; "${raw}" is not one`);
    return raw;
  }
  if (type === "Edm.Boolean") {
    if (raw !== "true" && raw !== "false") throw bad(`${property.name} is true or false; "${raw}" is neither`);
    return raw;
  }
  if (type === "Edm.DateTimeOffset") {
    // A date alone means its first instant in UTC, as the date picker of the filter row writes it.
    if (DATE.test(raw)) return `${raw}T00:00:00Z`;
    if (!DATE_TIME.test(raw)) throw bad(`${property.name} holds a date and time, e.g. 2026-11-07T08:00:00Z; "${raw}" is not one`);
    return raw;
  }
  if (type === "Edm.Date") {
    if (!DATE.test(raw)) throw bad(`${property.name} holds a date, e.g. 2026-11-07; "${raw}" is not one`);
    return raw;
  }
  if (type === "Edm.TimeOfDay") {
    if (!TIME.test(raw)) throw bad(`${property.name} holds a time, e.g. 08:30; "${raw}" is not one`);
    return raw;
  }
  if (type === "Edm.Guid") {
    if (!GUID.test(raw)) throw bad(`${property.name} holds a GUID; "${raw}" is not one`);
    return raw;
  }
  throw bad(`this list cannot filter ${property.name} (${type})`);
}

// --- NGSI-LD `q` as the grid writes it, read into a tree ------------------------------------------

type Value = { text: string; quoted: boolean };
type Node =
  | { op: "and" | "or"; parts: Node[] }
  | { op: "exists" | "missing"; path: string }
  | { op: "compare"; path: string; cmp: string; values: Value[]; range?: [Value, Value] };

const COMPARATORS = ["==", "!=", ">=", "<=", "~=", "!~=", ">", "<"];

class QReader {
  private at = 0;
  constructor(private readonly text: string) {}

  read(): Node {
    const node = this.or();
    if (this.at < this.text.length) throw bad(`the filter cannot be read at "${this.text.slice(this.at, this.at + 20)}"`);
    return node;
  }

  private peek(): string {
    return this.text[this.at] ?? "";
  }

  private or(): Node {
    const parts = [this.and()];
    while (this.peek() === "|") {
      this.at++;
      parts.push(this.and());
    }
    return parts.length === 1 ? parts[0] : { op: "or", parts };
  }

  private and(): Node {
    const parts = [this.unary()];
    while (this.peek() === ";") {
      this.at++;
      parts.push(this.unary());
    }
    return parts.length === 1 ? parts[0] : { op: "and", parts };
  }

  private unary(): Node {
    if (this.peek() === "(") {
      this.at++;
      const inner = this.or();
      if (this.peek() !== ")") throw bad("a parenthesis of the filter is not closed");
      this.at++;
      return inner;
    }
    if (this.peek() === "!" && this.text[this.at + 1] !== "~") {
      this.at++;
      return { op: "missing", path: this.path() };
    }
    const path = this.path();
    const cmp = COMPARATORS.find((each) => this.text.startsWith(each, this.at));
    if (!cmp) return { op: "exists", path };
    this.at += cmp.length;
    const first = this.value();
    if (this.text.startsWith("..", this.at)) {
      this.at += 2;
      return { op: "compare", path, cmp, values: [], range: [first, this.value()] };
    }
    const values = [first];
    while (this.peek() === ",") {
      this.at++;
      values.push(this.value());
    }
    return { op: "compare", path, cmp, values };
  }

  private path(): string {
    const match = /^[A-Za-z_][A-Za-z0-9_]*(\[[A-Za-z0-9_*]+\])*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(this.text.slice(this.at));
    if (!match) throw bad(`the filter names no column at "${this.text.slice(this.at, this.at + 20)}"`);
    this.at += match[0].length;
    return match[0];
  }

  private value(): Value {
    if (this.peek() === '"') {
      // Kept as written: a literal escapes `\\` and `"`, a pattern only `"` (filters.ts), so the
      // escapes are undone by the operator that reads the value.
      const start = ++this.at;
      while (this.at < this.text.length && this.peek() !== '"') {
        this.at += this.peek() === "\\" ? 2 : 1;
      }
      if (this.peek() !== '"') throw bad("a quoted value of the filter is not closed");
      return { text: this.text.slice(start, this.at++), quoted: true };
    }
    const match = /^[^;|(),"]+?(?=\.\.|[;|(),]|$)/.exec(this.text.slice(this.at));
    if (!match) throw bad("a value of the filter is missing");
    this.at += match[0].length;
    return { text: match[0].trim(), quoted: false };
  }
}

/** The text a grid pattern stands for, when it is plain text with anchors; null for a real expression. */
function plainPattern(pattern: string): { text: string; start: boolean; end: boolean } | null {
  let rest = pattern.startsWith("(?i)") ? pattern.slice(4) : pattern;
  const start = rest.startsWith("^");
  if (start) rest = rest.slice(1);
  const end = rest.endsWith("$") && !rest.endsWith("\\$");
  if (end) rest = rest.slice(0, -1);
  let text = "";
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === "\\") {
      const next = rest[i + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
      text += next;
      i++;
    } else if (/[.*+?^${}()|[\]]/.test(c)) {
      return null;
    } else {
      text += c;
    }
  }
  return { text, start, end };
}

function propertyOf(set: ODataSet, path: string): { name: string; property: ODataProperty } {
  if (path.includes(".")) throw bad(`this list keeps no metadata per value: ${path} cannot be filtered`);
  if (path.includes("[*]")) throw bad(`${path.replace("[*]", "")} holds no languages here`);
  const [top, ...members] = path.replace(/\]/g, "").split("[");
  const name = top === "id" ? set.key : top;
  const property = set.properties.find((p) => p.name === name);
  if (!property) throw bad(`this list has no column ${top}`);
  if (members.length > 0) {
    // A member of a complex value: its type is not in the set's own list, so it compares as text.
    return { name: [name, ...members].join("/"), property: { name: members.join("/"), type: "Edm.String", nullable: true } };
  }
  return { name, property };
}

function compareText(set: ODataSet, node: Extract<Node, { op: "compare" }>): string {
  const { name, property } = propertyOf(set, node.path);
  const lit = (v: Value) => literalOf(v.quoted ? v.text.replace(/\\(["\\])/g, "$1") : v.text, property);
  if (node.range) return `(${name} ge ${lit(node.range[0])} and ${name} le ${lit(node.range[1])})`;
  if (node.cmp === "~=" || node.cmp === "!~=") {
    const plain = node.values.length === 1 ? plainPattern(node.values[0].text.replace(/\\"/g, '"')) : null;
    if (!plain) throw bad("this list takes plain text in a filter, not a regular expression");
    const text = literalOf(plain.text, { ...property, type: "Edm.String" });
    const found =
      plain.start && plain.end ? `${name} eq ${text}` : plain.start ? `startswith(${name},${text})` : plain.end ? `endswith(${name},${text})` : `contains(${name},${text})`;
    return node.cmp === "~=" ? found : `not (${found})`;
  }
  if (node.values.length > 1) {
    if (node.cmp !== "==" && node.cmp !== "!=") throw bad(`${node.cmp} compares with one value`);
    const list = `${name} in (${node.values.map(lit).join(",")})`;
    return node.cmp === "==" ? list : `not (${list})`;
  }
  const op = { "==": "eq", "!=": "ne", ">": "gt", ">=": "ge", "<": "lt", "<=": "le" }[node.cmp];
  return `${name} ${op} ${lit(node.values[0])}`;
}

function nodeText(set: ODataSet, node: Node): string {
  switch (node.op) {
    case "and":
    case "or":
      return node.parts.map((part) => `(${nodeText(set, part)})`).join(` ${node.op} `);
    case "missing":
      return `${propertyOf(set, node.path).name} eq null`;
    case "exists":
      return `${propertyOf(set, node.path).name} ne null`;
    case "compare":
      return compareText(set, node);
  }
}

/**
 * The grid's question (`q`, `idPattern`, `ids`) as one `$filter`, or undefined when it asks for
 * nothing. Refused with a 400 `SourceError` the grid shows when a part has no OData form.
 */
export function filterOf(set: ODataSet, q: Pick<GridQuery, "q" | "idPattern" | "ids">): string | undefined {
  const key = set.properties.find((p) => p.name === set.key) ?? { name: set.key, type: "Edm.String", nullable: false };
  const parts: string[] = [];
  if (q.q?.trim()) parts.push(nodeText(set, new QReader(q.q.trim()).read()));
  if (q.idPattern) {
    // The id column's filter: an anchored id, the id's beginning (after an optional URN prefix the
    // grid adds for NGSI-LD ids), or a part of it.
    const pattern = q.idPattern.replace("^(urn:ngsi-ld:[^:]+:)?", "^");
    const plain = plainPattern(pattern);
    if (!plain) throw bad("this list takes plain text in the id filter, not a regular expression");
    const text = literalOf(plain.text, { ...key, type: "Edm.String" });
    parts.push(plain.start && plain.end ? `${set.key} eq ${literalOf(plain.text, key)}` : plain.start ? `startswith(${set.key},${text})` : `contains(${set.key},${text})`);
  }
  if (q.ids && q.ids.length > 0) parts.push(`${set.key} in (${q.ids.map((id) => literalOf(id, key)).join(",")})`);
  const filter = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : parts.map((part) => `(${part})`).join(" and ");
  if (filter && filter.length > MAX_FILTER) throw bad("the filter is too long for this list; remove a condition");
  return filter;
}

/** `attr;desc,other` (CIM 009 4.23, what the grid asks) as `$orderby`. */
export function orderByOf(set: ODataSet, orderBy: string | undefined): string | undefined {
  if (!orderBy) return undefined;
  const keys = orderBy.split(",").map((part) => {
    const [attr, dir] = part.split(";");
    const name = attr === "id" ? set.key : attr;
    if (!set.properties.some((p) => p.name === name)) throw bad(`this list cannot be sorted by ${attr}`);
    return dir === "desc" ? `${name} desc` : name;
  });
  return keys.join(",");
}

/** The query string of one page: each option's value percent-encoded, names as OData spells them. */
export function queryOf(set: ODataSet, q: GridQuery, page: { offset: number; limit: number; count?: boolean }): string {
  const known = new Set(set.properties.map((p) => p.name));
  const select = q.attrs?.filter((attr) => known.has(attr) && attr !== set.key);
  const options: [string, string | undefined][] = [
    ["$filter", filterOf(set, q)],
    ["$select", select && select.length > 0 ? [set.key, ...select].join(",") : undefined],
    ["$orderby", orderByOf(set, q.orderBy)],
    ["$top", String(page.limit)],
    ["$skip", page.offset > 0 ? String(page.offset) : undefined],
    ["$count", page.count === false ? undefined : "true"],
  ];
  return options
    .filter((option): option is [string, string] => option[1] !== undefined)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");
}

/** The sentence of an OData error body (`{error: {message}}`) or a problem document, or `fallback`. */
function messageOf(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message) return error.message;
    const problem = body as { detail?: unknown; title?: unknown };
    if (typeof problem.detail === "string" && problem.detail) return problem.detail;
    if (typeof problem.title === "string" && problem.title) return problem.title;
  }
  return fallback;
}

/** An NGSI-LD attribute fragment (`{type, value}` or `{type, object}`) as the plain value OData writes. */
function plainValue(fragment: unknown): unknown {
  if (typeof fragment !== "object" || fragment === null || Array.isArray(fragment)) return fragment;
  const attr = fragment as Record<string, unknown>;
  if ("value" in attr) return attr.value;
  if ("object" in attr) return attr.object;
  return fragment;
}

/**
 * The grid's source over the entity set `entitySet` of the OData service at `url` (a path on the
 * page's own origin, e.g. `/api/v1/projects/helsinki/odata`).
 */
export function odataSource(url: string, entitySet: string, transport: Transport, language = "en"): ODataSource {
  const root = url.replace(/\/+$/, "");
  const setPath = `${root}/${entitySet}`;
  const etags = new Map<string, string>();
  let setEtag: string | undefined;
  let metadata: Promise<ODataSet> | undefined;

  const load = (): Promise<ODataSet> => {
    // CSDL XML: every OData version serves it, while odata-axum answers CSDL JSON only to a 4.01
    // request, which the transport's `Accept: application/json` alone is not.
    metadata ??= (async () => {
      const { status, body } = await transport({ method: "GET", path: `${root}/$metadata?$format=application/xml` });
      if (status < 200 || status >= 300) {
        metadata = undefined;
        throw new SourceError(status, messageOf(body, "the description of this list was not read"));
      }
      return setFromCsdl(body, entitySet);
    })();
    return metadata;
  };
  const keyPath = (set: ODataSet, id: string) => {
    const key = set.properties.find((p) => p.name === set.key) ?? { name: set.key, type: "Edm.String", nullable: false };
    return `${setPath}(${encodeURIComponent(literalOf(id, key))})`;
  };
  const rowOf = (set: ODataSet, raw: Record<string, unknown>): RichRow => {
    const id = String(raw[set.key] ?? "");
    const tag = raw["@odata.etag"];
    if (typeof tag === "string") etags.set(id, tag);
    const cells: Record<string, RichCell | RichCell[]> = {};
    for (const property of set.properties) {
      const value = raw[property.name];
      if (property.name === set.key || value === null || value === undefined) continue;
      const cell = toRichCell({ type: "Property", value }, language);
      if (cell) cells[property.name] = cell;
    }
    return { id, type: set.entityType, cells, raw };
  };
  const refuse = (status: number, body: unknown, fallback: string): never => {
    if (status === 412) throw new SourceError(412, "this row changed since it was read; reload the list and edit it again");
    if (status === 405) throw new SourceError(405, messageOf(body, "this list is read only"));
    throw new SourceError(status, messageOf(body, fallback));
  };

  const allowed = async (op: ODataOperation, id?: string): Promise<ODataDecision> => {
    const query = `op=${op}${id === undefined ? "" : `&key=${encodeURIComponent(id)}`}`;
    const { status, body } = await transport({ method: "GET", path: `${setPath}/$allowed?${query}` });
    if (status < 200 || status >= 300) refuse(status, body, "whether you may do this was not answered");
    const answer = body as { allowed?: unknown; reason?: unknown; permission?: unknown };
    return {
      allowed: answer?.allowed === true,
      ...(typeof answer?.reason === "string" && answer.reason ? { reason: answer.reason } : {}),
      ...(typeof answer?.permission === "string" ? { permission: answer.permission } : {}),
    };
  };
  // A write is asked about first, so the person reads the module's reason rather than a bare 403.
  const mayWrite = async (op: "update" | "delete", id: string): Promise<void> => {
    const decision = await allowed(op, id);
    if (!decision.allowed) {
      throw new SourceError(403, decision.reason ?? (op === "update" ? "you may not change this row" : "you may not remove this row"));
    }
  };
  const ifMatch = (id: string) => etags.get(id) ?? setEtag;

  return {
    orders: true,
    metadata: load,
    allowed,
    async query(q, page) {
      const set = await load();
      const one = async (offset: number, limit: number, count: boolean) => {
        const { status, body, headers } = await transport({ method: "GET", path: `${setPath}?${queryOf(set, q, { offset, limit, count })}` });
        if (status < 200 || status >= 300) refuse(status, body, "the read was refused");
        const answer = body as { value?: unknown; "@odata.count"?: unknown; "@odata.nextLink"?: unknown };
        if (!Array.isArray(answer?.value)) throw new SourceError(status, "the answer is not a list of rows");
        setEtag = headers?.etag ?? setEtag;
        const total = answer["@odata.count"];
        return {
          rows: answer.value.map((raw) => rowOf(set, raw as Record<string, unknown>)),
          total: typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : undefined,
          more: typeof answer["@odata.nextLink"] === "string",
        };
      };
      // A module answers at most MAX_TOP rows a request (the Portal refuses more, odata-axum pages
      // at its own size with a next link): a bigger page is read in turns, each from where the
      // last one ended, until the page is full or the set says it holds no more.
      const first = await one(page.offset, Math.min(page.limit, MAX_TOP), page.count ?? true);
      const rows = [...first.rows];
      let last = first;
      while (rows.length < page.limit && last.rows.length > 0 && (last.more || last.rows.length === Math.min(page.limit, MAX_TOP))) {
        last = await one(page.offset + rows.length, Math.min(MAX_TOP, page.limit - rows.length), false);
        rows.push(...last.rows);
      }
      return { rows, total: first.total };
    },
    async get(id) {
      const set = await load();
      const { status, body, headers } = await transport({ method: "GET", path: keyPath(set, id) });
      if (status === 404) return null;
      if (status < 200 || status >= 300) refuse(status, body, "the read was refused");
      if (headers?.etag) etags.set(id, headers.etag);
      return rowOf(set, body as Record<string, unknown>);
    },
    async patch(id, attrs) {
      const set = await load();
      await mayWrite("update", id);
      const body = Object.fromEntries(Object.entries(attrs).map(([name, fragment]) => [name, plainValue(fragment)]));
      const answer = await transport({ method: "PATCH", path: keyPath(set, id), body, ifMatch: ifMatch(id) });
      if (answer.status < 200 || answer.status >= 300) refuse(answer.status, answer.body, "the change was refused");
      if (answer.headers?.etag) etags.set(id, answer.headers.etag);
    },
    async remove(id) {
      const set = await load();
      await mayWrite("delete", id);
      const answer = await transport({ method: "DELETE", path: keyPath(set, id), ifMatch: ifMatch(id) });
      if (answer.status < 200 || answer.status >= 300) refuse(answer.status, answer.body, "the removal was refused");
      etags.delete(id);
    },
  };
}

/** Whether `url` is a path on the page's own origin the grid may read an OData service from. */
export function isServicePath(url: string): boolean {
  // No `%`: a browser reads `%2e%2e` as `..` when it resolves the path.
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(url) && !url.startsWith("//") && !url.split("/").some((part) => part === ".." || part === ".");
}

export function isEntitySetName(name: string): boolean {
  return IDENTIFIER.test(name);
}
