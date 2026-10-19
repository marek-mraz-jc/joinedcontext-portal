import { readCsrfToken } from "../../../api/client";

/** Provenance audit fields attached to an instance (DM-111). */
export type Provenance = {
  channel?: string;
  actor?: string;
  operation?: string;
  reason?: string;
  requestId?: string;
  writtenAt?: string;
};

/** One recorded version of an attribute instance (ADR-N-054 §2.4). */
export type Version = {
  value: unknown;
  observedAt?: string;
  instanceId?: string;
  supersededAt?: string;
  provenance?: Provenance;
  unitCode?: string;
};

/** A measurement grouped by observation instant with its versions (DM-104). */
export type Measurement = {
  observedAt: string;
  current: Version;
  versions: Version[];
};

export const MAX_CSV_ROWS = 5000;
export const MAX_CSV_BYTES = 1_000_000;

export interface CsvRow {
  observedAt: string;
  value: unknown;
  line: number;
}

export interface CsvProblem {
  line: number;
  reason: string;
}

/** Error raised when an update reason fails validation (DM-113). */
export class ReasonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasonError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Enforces non-empty reason up to 500 characters (DM-113). */
export function validateReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new ReasonError("reason is required");
  }
  if (trimmed.length > 500) {
    throw new ReasonError("reason must be at most 500 characters");
  }
  return trimmed;
}

function endpointBase(slug: string): string {
  return `${window.location.origin}/api/endpoint/${encodeURIComponent(slug)}/ngsi-ld/v1`;
}

function writeHeaders(reason: string): HeadersInit {
  const validReason = validateReason(reason);
  const csrf = readCsrfToken();
  return {
    "Content-Type": "application/json",
    "JC-Reason": encodeURIComponent(validReason),
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  };
}

async function handleResponseError(response: Response): Promise<Error> {
  let detail: string | undefined;
  try {
    const json = (await response.json()) as { detail?: unknown; title?: unknown };
    if (typeof json?.detail === "string") {
      detail = json.detail;
    } else if (typeof json?.title === "string") {
      detail = json.title;
    }
  } catch {
    // Non-JSON response
  }
  return new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
}

/** The instances of one attribute: an array, a `values` list, or one instance. */
function instancesOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const values = (raw as { values?: unknown }).values;
  return Array.isArray(values) ? values : [raw];
}

function stringOf(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined;
}

/** One instance as a version, or undefined when it has no observedAt to group by. */
function versionOf(item: unknown): Version | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const raw = item as Record<string, unknown>;
  const observedAt = stringOf(raw.observedAt);
  if (!observedAt || observedAt.trim() === "") {
    return undefined;
  }
  return {
    value: raw.value,
    observedAt,
    instanceId: stringOf(raw.instanceId),
    supersededAt: stringOf(raw.supersededAt),
    provenance:
      typeof raw.provenance === "object" && raw.provenance !== null
        ? (raw.provenance as Provenance)
        : undefined,
    unitCode: stringOf(raw.unitCode),
  };
}

/** Oldest version first: by when it was written, else superseded ones before the live one. */
function versionOrder(a: Version, b: Version): number {
  const tA = Date.parse(a.provenance?.writtenAt ?? "");
  const tB = Date.parse(b.provenance?.writtenAt ?? "");
  if (!Number.isNaN(tA) && !Number.isNaN(tB)) {
    return tA - tB;
  }
  if (!a.supersededAt || !b.supersededAt) {
    return Number(!a.supersededAt) - Number(!b.supersededAt);
  }
  const sA = Date.parse(a.supersededAt);
  const sB = Date.parse(b.supersededAt);
  return Number.isNaN(sA) || Number.isNaN(sB) ? 0 : sA - sB;
}

/**
 * Extracts and groups temporal measurements from NGSI-LD response body (ADR-N-054 §2.1).
 */
export function measurementsOf(body: unknown, attribute: string): Measurement[] {
  if (!body || typeof body !== "object" || typeof attribute !== "string") {
    return [];
  }
  const byObservedAt = new Map<string, Version[]>();
  for (const item of instancesOf((body as Record<string, unknown>)[attribute])) {
    const version = versionOf(item);
    if (version?.observedAt) {
      const list = byObservedAt.get(version.observedAt) ?? [];
      list.push(version);
      byObservedAt.set(version.observedAt, list);
    }
  }

  const measurements: Measurement[] = [];
  for (const [observedAt, versions] of byObservedAt.entries()) {
    versions.sort(versionOrder);
    const current = versions.filter((v) => !v.supersededAt).at(-1) ?? versions[versions.length - 1];
    measurements.push({ observedAt, current, versions });
  }

  measurements.sort((a, b) => {
    const tA = Date.parse(a.observedAt);
    const tB = Date.parse(b.observedAt);
    if (!Number.isNaN(tA) && !Number.isNaN(tB)) {
      return tB - tA;
    }
    return b.observedAt.localeCompare(a.observedAt);
  });

  return measurements;
}

/** Reads temporal history for an attribute with fallback when readVersions is withheld (DM-114). */
export async function readHistory(
  slug: string,
  entityId: string,
  attribute: string,
  options?: { before?: string },
): Promise<{ measurements: Measurement[]; versions: boolean }> {
  const base = endpointBase(slug);
  const beforeQuery = options?.before
    ? `&timerel=before&timeAt=${encodeURIComponent(options.before)}`
    : "";
  const urlWithVersions = `${base}/temporal/entities/${encodeURIComponent(entityId)}?attrs=${encodeURIComponent(attribute)}&lastN=9&versions=all${beforeQuery}`;

  const response = await globalThis.fetch(
    new Request(urlWithVersions, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }),
  );

  if (response.status === 403) {
    const urlWithoutVersions = `${base}/temporal/entities/${encodeURIComponent(entityId)}?attrs=${encodeURIComponent(attribute)}&lastN=9${beforeQuery}`;
    const fallbackResponse = await globalThis.fetch(
      new Request(urlWithoutVersions, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      }),
    );
    if (!fallbackResponse.ok) {
      throw await handleResponseError(fallbackResponse);
    }
    const body = await fallbackResponse.json();
    return { measurements: measurementsOf(body, attribute), versions: false };
  }

  if (!response.ok) {
    throw await handleResponseError(response);
  }

  const body = await response.json();
  return { measurements: measurementsOf(body, attribute), versions: true };
}

/** Updates the current attribute value of an entity (DM-113). */
export async function editCurrent(
  slug: string,
  entityId: string,
  attribute: string,
  value: unknown,
  reason: string,
): Promise<void> {
  const headers = writeHeaders(reason);
  const url = `${endpointBase(slug)}/entities/${encodeURIComponent(entityId)}/attrs`;
  const response = await globalThis.fetch(
    new Request(url, {
      method: "PATCH",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        [attribute]: {
          type: "Property",
          value,
          observedAt: new Date().toISOString(),
        },
      }),
    }),
  );
  if (!response.ok) {
    throw await handleResponseError(response);
  }
}

/** Adds an older value into history without altering current state (ADR-N-054 §2.1). */
export async function addOldValue(
  slug: string,
  entityId: string,
  attribute: string,
  value: unknown,
  observedAt: string,
  reason: string,
): Promise<void> {
  const headers = writeHeaders(reason);
  const url = `${endpointBase(slug)}/temporal/entities/${encodeURIComponent(entityId)}/attrs`;
  const response = await globalThis.fetch(
    new Request(url, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        [attribute]: [
          {
            type: "Property",
            value,
            observedAt,
          },
        ],
      }),
    }),
  );
  if (!response.ok) {
    throw await handleResponseError(response);
  }
}

/** Writes a corrected instance version into history (DM-115). */
export async function correct(
  slug: string,
  entityId: string,
  attribute: string,
  instanceId: string,
  value: unknown,
  observedAt: string,
  reason: string,
): Promise<void> {
  const headers = writeHeaders(reason);
  if (!instanceId) {
    throw new Error("the measurement names no instance to correct");
  }
  const url = `${endpointBase(slug)}/temporal/entities/${encodeURIComponent(entityId)}/attrs/${encodeURIComponent(attribute)}/${encodeURIComponent(instanceId)}`;
  const response = await globalThis.fetch(
    new Request(url, {
      method: "PATCH",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        [attribute]: {
          type: "Property",
          value,
          observedAt,
        },
      }),
    }),
  );
  if (!response.ok) {
    throw await handleResponseError(response);
  }
}

/** Parses datetime-local string in reader's zone into UTC ISO string, or undefined if invalid or future. */
export function instantOf(local: string): string | undefined {
  if (!local || typeof local !== "string") {
    return undefined;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    local.trim(),
  );
  if (!match) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = match[6] ? Number(match[6]) : 0;
  const millis = match[7] ? Number(match[7].padEnd(3, "0")) : 0;

  const date = new Date(year, month - 1, day, hours, minutes, seconds, millis);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }
  if (date.getTime() > Date.now()) {
    return undefined;
  }
  return date.toISOString();
}

/** Converts raw input text into typed value based on sample value. */
export function valueOf(text: string, sample: unknown): unknown {
  if (typeof sample === "number") {
    const trimmed = text.trim();
    if (trimmed === "") return undefined;
    const num = Number(trimmed);
    return Number.isNaN(num) || !Number.isFinite(num) ? undefined : num;
  }
  if (typeof sample === "boolean") {
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return undefined;
  }
  if (typeof sample === "object" && sample !== null) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (sample === undefined) {
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return text;
  }
  return text;
}

type CsvRecord = { fields: string[]; line: number };

/** Splits RFC 4180 text into records, each with the line it starts on; quoted fields keep newlines. */
function csvRecords(content: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let start = 1;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inQuotes && char === '"' && content[i + 1] === '"') {
      field += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (inQuotes || (char !== "," && char !== "\r" && char !== "\n")) {
      field += char;
      if (char === "\n") line++;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else {
      // A record ends at CR, LF or CRLF.
      if (char === "\r" && content[i + 1] === "\n") i++;
      record.push(field);
      records.push({ fields: record, line: start });
      field = "";
      record = [];
      line++;
      start = line;
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push({ fields: record, line: start });
  }
  return records;
}

/** One data record as a row, or the reason it is not one. */
function csvRow(
  record: CsvRecord,
  observedAtIdx: number,
  valueIdx: number,
  sample: unknown,
): CsvRow | CsvProblem {
  const parsedTime = Date.parse((record.fields[observedAtIdx] ?? "").trim());
  if (Number.isNaN(parsedTime)) {
    return { line: record.line, reason: "invalid observedAt instant" };
  }
  if (parsedTime > Date.now()) {
    return { line: record.line, reason: "observedAt in the future" };
  }
  const value = valueOf(record.fields[valueIdx] ?? "", sample);
  if (value === undefined) {
    return { line: record.line, reason: "invalid value" };
  }
  return { observedAt: new Date(parsedTime).toISOString(), value, line: record.line };
}

/** Parses RFC 4180 CSV containing observedAt and value columns (DM-81). */
export function parseCsv(
  text: string,
  sample?: unknown,
): { rows: CsvRow[]; problems: CsvProblem[] } {
  if (!text || typeof text !== "string") {
    return { rows: [], problems: [{ line: 1, reason: "empty input" }] };
  }

  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (new TextEncoder().encode(content).length > MAX_CSV_BYTES) {
    return {
      rows: [],
      problems: [{ line: 1, reason: `exceeds maximum of ${MAX_CSV_BYTES} bytes` }],
    };
  }

  const records = csvRecords(content).filter((rec) => rec.fields.some((f) => f.trim() !== ""));
  const header = records[0];
  if (!header) {
    return { rows: [], problems: [{ line: 1, reason: "missing header row" }] };
  }
  const headerFields = header.fields.map((f) => f.trim().toLowerCase());
  const observedAtIdx = headerFields.indexOf("observedat");
  const valueIdx = headerFields.indexOf("value");
  if (observedAtIdx === -1 || valueIdx === -1) {
    return {
      rows: [],
      problems: [{ line: header.line, reason: "header must include observedAt and value" }],
    };
  }

  const data = records.slice(1);
  if (data.length > MAX_CSV_ROWS) {
    return {
      rows: [],
      problems: [{ line: 1, reason: `exceeds maximum of ${MAX_CSV_ROWS} rows` }],
    };
  }

  const rows: CsvRow[] = [];
  const problems: CsvProblem[] = [];
  for (const record of data) {
    const parsed = csvRow(record, observedAtIdx, valueIdx, sample);
    if ("reason" in parsed) {
      problems.push(parsed);
    } else {
      rows.push(parsed);
    }
  }
  return { rows, problems };
}

function canonicalJson(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((val as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** What an import sends and skips: `unchecked` rows lie before the history read and go as new. */
export interface ImportPlan {
  added: CsvRow[];
  duplicates: CsvRow[];
  corrections: { row: CsvRow; instanceId: string }[];
  unchecked: CsvRow[];
}

/**
 * Plans additions, duplicates and corrections for CSV import against history (ADR-N-054 §2.1).
 * Only rows inside the history read can be compared: unless `complete`, a row older than its
 * oldest measurement is `unchecked` and sent as new, and the broker keeps one row for an
 * identical value at that instant and records another value as a correction (DM-109, DM-115).
 */
export function planImport(rows: CsvRow[], measurements: Measurement[], complete = false): ImportPlan {
  const byInstant = new Map<string, CsvRow>();
  for (const row of rows) {
    byInstant.set(row.observedAt, row);
  }
  const effectiveRows = Array.from(byInstant.values());

  const measurementByInstant = new Map<string, Measurement>();
  for (const m of measurements) {
    const parsed = Date.parse(m.observedAt);
    const key = Number.isNaN(parsed) ? m.observedAt : new Date(parsed).toISOString();
    measurementByInstant.set(key, m);
  }

  const added: CsvRow[] = [];
  const duplicates: CsvRow[] = [];
  const corrections: { row: CsvRow; instanceId: string }[] = [];
  const unchecked: CsvRow[] = [];
  const oldest = Math.min(...measurements.map((m) => Date.parse(m.observedAt)).filter((t) => !Number.isNaN(t)));

  for (const row of effectiveRows) {
    const existing = measurementByInstant.get(row.observedAt);
    if (!existing && !complete && Date.parse(row.observedAt) < oldest) {
      unchecked.push(row);
    } else if (!existing || !existing.current.instanceId) {
      added.push(row);
    } else {
      const isDuplicate = canonicalJson(row.value) === canonicalJson(existing.current.value);
      if (isDuplicate) {
        duplicates.push(row);
      } else {
        corrections.push({ row, instanceId: existing.current.instanceId });
      }
    }
  }

  return { added, duplicates, corrections, unchecked };
}

/** Executes an import plan sending added rows in chunks of 100 and corrections sequentially (DM-81). */
export async function runImport(
  slug: string,
  entityId: string,
  attribute: string,
  plan: ImportPlan,
  reason: string,
  onProgress?: (progress: { sent: number; total: number }) => void,
): Promise<{ sent: number; failed?: { line: number; message: string } }> {
  validateReason(reason);
  const fresh = [...plan.added, ...plan.unchecked];
  const total = fresh.length + plan.corrections.length;
  let sent = 0;

  const chunkSize = 100;
  for (let i = 0; i < fresh.length; i += chunkSize) {
    const chunk = fresh.slice(i, i + chunkSize);
    try {
      const headers = writeHeaders(reason);
      const url = `${endpointBase(slug)}/temporal/entities/${encodeURIComponent(entityId)}/attrs`;
      const response = await globalThis.fetch(
        new Request(url, {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({
            [attribute]: chunk.map((r) => ({
              type: "Property",
              value: r.value,
              observedAt: r.observedAt,
            })),
          }),
        }),
      );
      if (!response.ok) {
        throw await handleResponseError(response);
      }
      sent += chunk.length;
      onProgress?.({ sent, total });
    } catch (err) {
      return {
        sent,
        failed: {
          line: chunk[0].line,
          message: err instanceof Error ? err.message : "import failed",
        },
      };
    }
  }

  for (const correction of plan.corrections) {
    try {
      await correct(
        slug,
        entityId,
        attribute,
        correction.instanceId,
        correction.row.value,
        correction.row.observedAt,
        reason,
      );
      sent += 1;
      onProgress?.({ sent, total });
    } catch (err) {
      return {
        sent,
        failed: {
          line: correction.row.line,
          message: err instanceof Error ? err.message : "correction failed",
        },
      };
    }
  }

  return { sent };
}
