/**
 * Importing a file into one entity type of a space (T-3109, ADR-N-042 §3.6): the file is read in
 * the browser, its columns are mapped to the type's slots, every row is checked against what the
 * model says of each slot, and the valid rows are created in batches through the gateway with the
 * person's session, like any edit (§3.3). A batch create never overwrites an entity: an id that
 * exists comes back refused, in the report with every row the check or the gateway refused.
 *
 * Every format is read with what the browser has: CSV and JSON as text, XML with `DOMParser`, and
 * an XLSX workbook as the ZIP of XML it is, unpacked with `DecompressionStream`.
 */
import { classSlots, parseModel } from "../models/linkml";
import type { NgsiLdKind } from "../models/linkml";

/** A file read into rows of text, numbers and flags, keyed by its column names. */
export interface Table {
  columns: string[];
  rows: Record<string, string>[];
}

/** One slot of the type as the import needs it. */
export interface ImportSlot {
  name: string;
  range?: string;
  kind: NgsiLdKind;
  required: boolean;
  /** The permissible values, when the range is an enum of the model. */
  values?: string[];
  minimum?: number;
  maximum?: number;
}

/** What a column feeds: a slot by name, the entity's `id`, or nothing. */
export type Mapping = Record<string, string>;

/** The column that names the entity: a URN, or the local part the import completes. */
export const ID = "id";

/** How many entities one create through the gateway carries. */
export const BATCH = 100;

/** The most rows one import reads: a bigger file is a feed, a DataSource and a Pipeline. */
export const MAX_ROWS = 10_000;

/** The slots of one class of the space's model, with `required` from the class's own usage. */
export function importSlotsOf(source: string | undefined, type: string): ImportSlot[] {
  if (source === undefined || !type) return [];
  const model = parseModel(source);
  const klass = model.classes.find((c) => c.name === type);
  if (!klass) return [];
  return classSlots(model, klass)
    .filter((slot) => slot.name !== "id" && slot.name !== "type")
    .map((slot) => ({
      name: slot.name,
      range: slot.range,
      kind: slot.kind,
      required: slot.required === true,
      values: model.enums.find((e) => e.name === slot.range)?.permissible_values.map((v) => v.name),
      minimum: slot.minimum_value,
      maximum: slot.maximum_value,
    }));
}

// ---------------------------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------------------------

/** The file as rows, by its extension; an error names what could not be read. */
export async function readTable(file: File): Promise<Table> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".tsv") || name.endsWith(".txt")) return parseCsv(await file.text());
  if (name.endsWith(".json") || name.endsWith(".geojson")) return parseJson(await file.text());
  if (name.endsWith(".xml")) return parseXml(await file.text());
  if (name.endsWith(".xlsx")) return parseXlsx(new Uint8Array(await file.arrayBuffer()));
  throw new Error("read CSV, Excel (.xlsx), JSON or XML");
}

/** CSV by RFC 4180, its separator the one of `,`, `;` and tab the header line holds most of. */
export function parseCsv(text: string): Table {
  const body = text.replace(/^\uFEFF/, "");
  const header = body.split(/\r?\n/, 1)[0] ?? "";
  const separator = [",", ";", "\t"].reduce((best, sep) =>
    header.split(sep).length > header.split(best).length ? sep : best,
  );
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at];
    if (quoted) {
      if (char === '"' && body[at + 1] === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === separator) {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && body[at + 1] === "\n") at += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return fromRecords(records.filter((r) => r.some((cell) => cell.trim() !== "")));
}

/** A header record and the records under it, as a table; a column without a name is `column N`. */
function fromRecords(records: string[][]): Table {
  const [head, ...rest] = records;
  if (!head) return { columns: [], rows: [] };
  const columns = head.map((name, at) => name.trim() || `column ${at + 1}`);
  const rows = rest.slice(0, MAX_ROWS).map((record) =>
    Object.fromEntries(columns.map((column, at) => [column, (record[at] ?? "").trim()])),
  );
  return { columns, rows };
}

/**
 * JSON: an array of objects, an object holding one such array, or a GeoJSON FeatureCollection,
 * whose features give their properties and their geometry as `location`. A nested value is kept
 * as its JSON text.
 */
export function parseJson(text: string): Table {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("the file is not JSON");
  }
  let items: unknown[] | undefined;
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === "object") {
    const object = data as Record<string, unknown>;
    if (object.type === "FeatureCollection" && Array.isArray(object.features)) {
      items = object.features.map((feature) => {
        const f = (feature ?? {}) as { properties?: Record<string, unknown>; geometry?: unknown; id?: unknown };
        return { ...(f.id !== undefined ? { id: f.id } : {}), ...(f.properties ?? {}), location: f.geometry };
      });
    } else {
      items = Object.values(object).find(Array.isArray);
    }
  }
  if (!items) throw new Error("the JSON holds no list of records");
  const objects = items.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  const columns = [...new Set(objects.flatMap((item) => Object.keys(item)))];
  const rows = objects.slice(0, MAX_ROWS).map((item) =>
    Object.fromEntries(columns.map((column) => [column, textOf(item[column])])),
  );
  return { columns, rows };
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

/** XML: the root's repeated children are the records, each child or attribute of one a field. */
export function parseXml(text: string): Table {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) throw new Error("the file is not well-formed XML");
  const root = document.documentElement;
  const children = Array.from(root.children);
  // The records are the most frequent element name under the root (a `<rows><row/>…</rows>`).
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.tagName, (counts.get(child.tagName) ?? 0) + 1);
  const recordName = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const records = children.filter((child) => child.tagName === recordName);
  const objects = records.map((record) => {
    const fields: Record<string, string> = {};
    for (const attribute of Array.from(record.attributes)) fields[attribute.name] = attribute.value.trim();
    for (const field of Array.from(record.children)) fields[field.tagName] = (field.textContent ?? "").trim();
    return fields;
  });
  const columns = [...new Set(objects.flatMap((item) => Object.keys(item)))];
  return {
    columns,
    rows: objects.slice(0, MAX_ROWS).map((item) => Object.fromEntries(columns.map((c) => [c, item[c] ?? ""]))),
  };
}

/** The entries of a ZIP archive by name, read from its central directory (stored or deflated). */
async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record is within the last 64 KiB plus its own 22 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("the workbook is not a ZIP archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, Uint8Array>();
  const names = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("the workbook's directory is damaged");
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + compressed);
    if (method === 0) entries.set(name, data);
    else if (method === 8) entries.set(name, await inflate(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const body = new Response(new Uint8Array(data)).body;
  if (!body) throw new Error("the workbook cannot be unpacked here");
  return new Uint8Array(await new Response(body.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
}

/** A column's letters as its index: `A` is 0, `AA` is 26. */
function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

/** The first sheet of an XLSX workbook, its first row the header; shared and inline strings read. */
export async function parseXlsx(bytes: Uint8Array): Promise<Table> {
  const entries = await unzip(bytes);
  const xml = (name: string) => {
    const entry = entries.get(name);
    return entry ? new DOMParser().parseFromString(new TextDecoder().decode(entry), "application/xml") : undefined;
  };
  const shared = Array.from(xml("xl/sharedStrings.xml")?.getElementsByTagName("si") ?? []).map(
    (si) => Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""),
  );
  const sheetName = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()[0];
  const sheet = sheetName ? xml(sheetName) : undefined;
  if (!sheet) throw new Error("the workbook has no sheet");
  const records = Array.from(sheet.getElementsByTagName("row")).map((row) => {
    const record: string[] = [];
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const type = cell.getAttribute("t");
      const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
      const text =
        type === "s"
          ? (shared[Number(value)] ?? "")
          : type === "inlineStr"
            ? Array.from(cell.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("")
            : type === "b"
              ? value === "1"
                ? "true"
                : "false"
              : value;
      record[columnIndex(cell.getAttribute("r") ?? "")] = text;
    }
    return Array.from(record, (cell) => cell ?? "");
  });
  return fromRecords(records.filter((r) => r.some((cell) => cell.trim() !== "")));
}

// ---------------------------------------------------------------------------------------------
// Mapping columns to slots
// ---------------------------------------------------------------------------------------------

const SYNONYMS: Record<string, string[]> = {
  // Smart Data Models' common names for what files call otherwise.
  name: ["title", "label", "nazov", "nimi", "nazev"],
  description: ["desc", "popis", "kuvaus", "notes"],
  address: ["street", "adresa", "osoite"],
  dateObserved: ["date", "timestamp", "datum", "observedat"],
  location: ["geometry", "geom", "coordinates", "position", "point"],
};

/** A name without case, separators or diacritics, so `Date observed` meets `dateObserved`. */
function normalized(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The slot each column most likely feeds: the same name up to case, separators and diacritics, or
 * a Smart Data Models synonym of it; a column named `id` or `urn` names the entity. Each slot is
 * suggested once.
 */
export function suggestMapping(columns: string[], slots: ImportSlot[]): Mapping {
  const mapping: Mapping = {};
  const taken = new Set<string>();
  for (const column of columns) {
    const key = normalized(column);
    let target = "";
    if (key === "id" || key === "urn" || key === "entityid") target = ID;
    else {
      const slot =
        slots.find((s) => normalized(s.name) === key) ??
        slots.find((s) => (SYNONYMS[s.name] ?? []).some((synonym) => normalized(synonym) === key));
      target = slot?.name ?? "";
    }
    if (target && !taken.has(target)) {
      mapping[column] = target;
      taken.add(target);
    } else {
      mapping[column] = "";
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------------------------
// Rows into entities, each checked
// ---------------------------------------------------------------------------------------------

/** Where the rows go: the type, and what completes a local id into the space's URN. */
export interface Target {
  type: string;
  orgDomain: string;
  space: string;
}

/** One row the import will not create, numbered as the file numbers it (the header is row 1). */
export interface Rejected {
  row: number;
  id?: string;
  reason: string;
}

const LOCAL_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const URN = /^urn:ngsi-ld:[A-Za-z][A-Za-z0-9_-]*:[^\s:]+:[^\s:]+:[^\s]+$/;

/** The entity a row names: a URN of this type and space as it is, a local id completed. */
function idOf(value: string, target: Target, fallback: string): string | Error {
  const text = value.trim();
  if (!text) return `urn:ngsi-ld:${target.type}:${target.orgDomain}:${target.space}:${fallback}`;
  if (text.startsWith("urn:")) {
    if (!URN.test(text)) return new Error(`\`${text}\` is not an NGSI-LD URN`);
    const [, , type, domain, space] = text.split(":");
    if (type !== target.type || domain !== target.orgDomain || space !== target.space) {
      return new Error(`\`${text}\` names another type, organization or space than this one`);
    }
    return text;
  }
  if (!LOCAL_ID.test(text)) return new Error(`\`${text}\` cannot be the last part of an id`);
  return `urn:ngsi-ld:${target.type}:${target.orgDomain}:${target.space}:${text}`;
}

const INTEGER = new Set(["integer"]);
const NUMBER = new Set(["float", "double", "decimal", "number"]);
const DATE = new Set(["date", "datetime", "time"]);

/** One value as its slot's range takes it, or why it cannot be. */
function valueOf(text: string, slot: ImportSlot): unknown | Error {
  if (slot.kind === "JsonProperty" || slot.kind === "ListProperty") {
    try {
      const value: unknown = JSON.parse(text);
      if (slot.kind === "ListProperty" && !Array.isArray(value)) throw new Error("not a list");
      return value;
    } catch {
      return slot.kind === "ListProperty"
        ? text.split(/\s*[;|]\s*/).filter((item) => item !== "")
        : new Error(`${slot.name}: \`${text}\` is not JSON`);
    }
  }
  if (slot.kind === "LanguageProperty") {
    // A map of languages as JSON, or one text in no particular language (NGSI-LD `@none`).
    try {
      const map: unknown = JSON.parse(text);
      if (map && typeof map === "object" && !Array.isArray(map) && Object.values(map).every((v) => typeof v === "string")) {
        return map;
      }
    } catch {
      // Plain text below.
    }
    return { "@none": text };
  }
  if (slot.kind === "GeoProperty") {
    try {
      const geometry = JSON.parse(text) as { type?: unknown; coordinates?: unknown };
      if (typeof geometry.type === "string" && Array.isArray(geometry.coordinates)) return geometry;
    } catch {
      // A pair below.
    }
    const pair = text.split(/[,;\s]+/).map(Number);
    if (pair.length === 2 && pair.every(Number.isFinite)) return { type: "Point", coordinates: pair };
    return new Error(`${slot.name}: \`${text}\` is neither GeoJSON nor "longitude, latitude"`);
  }
  const range = slot.range ?? "string";
  if (slot.values) {
    if (!slot.values.includes(text)) return new Error(`${slot.name}: \`${text}\` is not one of ${slot.values.join(", ")}`);
    return text;
  }
  if (INTEGER.has(range) || NUMBER.has(range)) {
    const number = Number(text.replace(/\s/g, "").replace(/,(?=\d+$)/, "."));
    if (!Number.isFinite(number) || (INTEGER.has(range) && !Number.isInteger(number))) {
      return new Error(`${slot.name}: \`${text}\` is not ${INTEGER.has(range) ? "a whole number" : "a number"}`);
    }
    if (slot.minimum !== undefined && number < slot.minimum) return new Error(`${slot.name}: ${number} is below ${slot.minimum}`);
    if (slot.maximum !== undefined && number > slot.maximum) return new Error(`${slot.name}: ${number} is above ${slot.maximum}`);
    return number;
  }
  if (range === "boolean") {
    const key = text.toLowerCase();
    if (["true", "1", "yes", "ano", "kyllä", "ja"].includes(key)) return true;
    if (["false", "0", "no", "nie", "ne", "ei", "nein"].includes(key)) return false;
    return new Error(`${slot.name}: \`${text}\` is not yes or no`);
  }
  if (DATE.has(range)) {
    if (Number.isNaN(Date.parse(text))) return new Error(`${slot.name}: \`${text}\` is not a date`);
    return range === "date" ? text.slice(0, 10) : new Date(text).toISOString();
  }
  return text;
}

/**
 * Every row as an NGSI-LD entity of the target type, or the reasons it is not one: an id that
 * names another type or space, a required slot left empty, a value outside its slot's range or
 * enum. A row with no id column gets a fresh local id.
 */
export function toEntities(
  table: Table,
  mapping: Mapping,
  slots: ImportSlot[],
  target: Target,
  freshId: () => string = () => crypto.randomUUID(),
): { entities: { row: number; entity: Record<string, unknown> }[]; rejected: Rejected[] } {
  const entities: { row: number; entity: Record<string, unknown> }[] = [];
  const rejected: Rejected[] = [];
  const idColumn = Object.keys(mapping).find((column) => mapping[column] === ID);
  const bySlot = new Map(slots.map((slot) => [slot.name, slot]));
  const seen = new Set<string>();
  table.rows.forEach((record, at) => {
    const row = at + 2;
    const id = idOf(idColumn ? (record[idColumn] ?? "") : "", target, freshId());
    if (id instanceof Error) {
      rejected.push({ row, reason: id.message });
      return;
    }
    if (seen.has(id)) {
      rejected.push({ row, id, reason: "the file names this id twice" });
      return;
    }
    const entity: Record<string, unknown> = { id, type: target.type };
    const problems: string[] = [];
    for (const [column, slotName] of Object.entries(mapping)) {
      const slot = bySlot.get(slotName);
      const text = (record[column] ?? "").trim();
      if (!slot || text === "") continue;
      const value = valueOf(text, slot);
      if (value instanceof Error) {
        problems.push(value.message);
      } else if (slot.kind === "Relationship") {
        entity[slot.name] = { type: "Relationship", object: value };
      } else if (slot.kind === "GeoProperty") {
        entity[slot.name] = { type: "GeoProperty", value };
      } else if (slot.kind === "LanguageProperty") {
        entity[slot.name] = { type: "LanguageProperty", languageMap: value };
      } else if (slot.kind === "JsonProperty") {
        entity[slot.name] = { type: "JsonProperty", json: value };
      } else if (slot.kind === "VocabProperty") {
        entity[slot.name] = { type: "VocabProperty", vocab: value };
      } else if (slot.kind === "ListProperty") {
        entity[slot.name] = { type: "ListProperty", valueList: value };
      } else {
        entity[slot.name] = { type: "Property", value };
      }
    }
    for (const slot of slots) {
      if (slot.required && entity[slot.name] === undefined) problems.push(`${slot.name} is required`);
    }
    if (problems.length > 0) {
      rejected.push({ row, id, reason: problems.join("; ") });
      return;
    }
    seen.add(id);
    entities.push({ row, entity });
  });
  return { entities, rejected };
}

// ---------------------------------------------------------------------------------------------
// Writing through the gateway
// ---------------------------------------------------------------------------------------------

/** The request the import makes, the shape of the SDK's origin transport. */
export type Send = (request: { method: "POST"; path: string; body?: unknown }) => Promise<{ status: number; body?: unknown }>;

/** What the gateway's problem says, or the status when it says nothing. */
function said(body: unknown, status: number): string {
  const problem = (body ?? {}) as { detail?: unknown; title?: unknown };
  return String(problem.detail ?? problem.title ?? `HTTP ${status}`);
}

/**
 * Creates the entities in batches through the space surface with the person's session. A batch
 * the gateway answers 201 is created whole; a 207 names which ids failed and why (NGSI-LD batch
 * result); any other answer refuses the batch whole with the gateway's words. `onProgress` is
 * told how many have been sent.
 */
export async function createInBatches(
  send: Send,
  space: string,
  entities: { row: number; entity: Record<string, unknown> }[],
  onProgress: (sent: number) => void = () => {},
): Promise<{ created: number; rejected: Rejected[] }> {
  let created = 0;
  const rejected: Rejected[] = [];
  const path = `/cs/${encodeURIComponent(space)}/ngsi-ld/v1/entityOperations/create`;
  for (let at = 0; at < entities.length; at += BATCH) {
    const batch = entities.slice(at, at + BATCH);
    let answer: { status: number; body?: unknown };
    try {
      answer = await send({ method: "POST", path, body: batch.map((item) => item.entity) });
    } catch (error) {
      answer = { status: 0, body: { detail: error instanceof Error ? error.message : String(error) } };
    }
    const rowOf = new Map(batch.map((item) => [String(item.entity.id), item.row]));
    if (answer.status === 201 || answer.status === 204) {
      created += batch.length;
    } else if (answer.status === 207) {
      const result = (answer.body ?? {}) as { success?: unknown[]; errors?: { entityId?: unknown; error?: unknown }[] };
      const failed = new Set<string>();
      for (const error of result.errors ?? []) {
        const id = String(error.entityId ?? "");
        failed.add(id);
        rejected.push({ row: rowOf.get(id) ?? 0, id, reason: said(error.error, 207) });
      }
      created += batch.filter((item) => !failed.has(String(item.entity.id))).length;
    } else {
      const reason = said(answer.body, answer.status);
      for (const item of batch) rejected.push({ row: item.row, id: String(item.entity.id), reason });
    }
    onProgress(Math.min(at + BATCH, entities.length));
  }
  return { created, rejected };
}

/** The rejected rows as CSV, for the person to fix and import again. */
export function rejectedCsv(rejected: Rejected[]): string {
  const quote = (text: string) => (/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  return ["row,id,reason", ...rejected.map((r) => [String(r.row), r.id ?? "", r.reason].map(quote).join(","))].join("\r\n");
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

/** The file representations an export offers, in the order the menu lists them. */
export const EXPORTS = ["csv", "xlsx", "json"] as const;

/**
 * Where an Endpoint's file of the view is: its `file.{format}` narrowed to the type, the view's
 * query and the type's fields, read by the gateway with the person's session at the edge.
 */
export function exportUrl(slug: string, format: (typeof EXPORTS)[number], type: string, q: string | undefined, attrs: string[]): string {
  const params = new URLSearchParams({ type });
  if (q) params.set("q", q);
  if (attrs.length > 0) params.set("attrs", attrs.join(","));
  return `/api/endpoint/${encodeURIComponent(slug)}/file.${format}?${params.toString()}`;
}
