import type { Cell, Row } from "../ngsi";
import { cell } from "../ngsi";
import type { Schema } from "../write";
import type { AccessDocument } from "./access";
import type { Client, DataClient } from "./client";
import { createClient } from "./client";
import type { JcConfig, JcUser } from "./config";
import type { JcRequest, JcResponse, Transport } from "./transport";

export interface Fixture {
  entities?: Row[];
  schema?: Schema;
  access?: AccessDocument;
  functions?: Record<string, (body: unknown) => unknown | Promise<unknown>>;
  /** The temporal read's answer, as the broker's `temporalValues` bodies; those of the asked type are returned. */
  temporal?: { id: string; type: string; [attr: string]: unknown }[];
  refuse?: (request: JcRequest) => JcResponse | null;
}

export interface StubTransport extends Transport {
  calls: JcRequest[];
  rows(): Row[];
}

function deriveSchema(rows: Row[]): Schema {
  const defs: Schema = {};
  for (const row of rows) {
    if (!defs[row.type]) {
      defs[row.type] = { properties: {} };
    }
    const props = defs[row.type].properties!;
    for (const [key, val] of Object.entries(row)) {
      if (key === "id" || key === "type" || key === "@context") continue;
      if (!props[key]) {
        let type = "string";
        if (typeof val === "number") type = "number";
        else if (typeof val === "boolean") type = "boolean";
        else if (typeof val === "object" && val !== null) type = "object";
        props[key] = { type };
      }
    }
  }
  return defs;
}

function decodeAttrs(body: unknown): Record<string, Cell> {
  const decoded: Record<string, Cell> = {};
  if (typeof body === "object" && body !== null) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === "id" || k === "type") continue;
      if (typeof v === "object" && v !== null && ("type" in v) && "value" in v) {
        decoded[k] = (v as { value: Cell }).value;
      } else if (typeof v === "object" && v !== null && "object" in v) {
        // A Relationship in keyValues is its target, or its targets joined as a row shows them.
        decoded[k] = cell((v as { object: unknown }).object);
      } else if (typeof v === "object" && v !== null && "languageMap" in v) {
        // Kept in its keyValues shape, as a broker answers it; rows read one language of it.
        decoded[k] = { languageMap: (v as { languageMap: unknown }).languageMap } as unknown as Cell;
      } else {
        decoded[k] = v as Cell;
      }
    }
  }
  return decoded;
}

export function stubTransport(fixture?: Fixture): StubTransport {
  let store: Row[] = (fixture?.entities ?? []).map((r) => ({ ...r }));
  const calls: JcRequest[] = [];

  const transport = async (request: JcRequest): Promise<JcResponse> => {
    calls.push(request);
    if (fixture?.refuse) {
      const refused = fixture.refuse(request);
      if (refused) return refused;
    }

    const { method, path, body } = request;

    if (method === "POST" && path.startsWith("/functions/")) {
      const name = path.slice("/functions/".length);
      const fn = fixture?.functions?.[name];
      if (fn) {
        const res = await fn(body);
        return { status: 200, body: res };
      }
      return {
        status: 404,
        body: { type: "about:blank", title: "Not Found", status: 404, detail: `Function ${name} not found` },
      };
    }

    const [pathname, qs] = path.split("?");
    const params = new URLSearchParams(qs ?? "");

    if (pathname.endsWith("/ngsi-ld/v1/entities") && method === "GET") {
      const type = params.get("type");
      let items = type ? store.filter((r) => r.type === type) : [...store];
      const idPattern = params.get("idPattern");
      if (idPattern) {
        const re = new RegExp(idPattern);
        items = items.filter((r) => re.test(r.id));
      }
      const offset = Number(params.get("offset")) || 0;
      const limit = Number(params.get("limit")) || 100;
      const attrsStr = params.get("attrs");
      if (attrsStr) {
        const keep = new Set(["id", "type", ...attrsStr.split(",")]);
        items = items.map((r) => {
          const projected: Row = { id: r.id, type: r.type };
          for (const k of Object.keys(r)) {
            if (keep.has(k)) projected[k] = r[k];
          }
          return projected;
        });
      }
      return { status: 200, body: items.slice(offset, offset + limit) };
    }

    if (pathname.endsWith("/ngsi-ld/v1/entities") && method === "POST") {
      const raw = (body ?? {}) as Record<string, unknown>;
      const newRow: Row = {
        id: String(raw.id ?? ""),
        type: String(raw.type ?? ""),
        ...decodeAttrs(body),
      };
      store.push(newRow);
      return { status: 201, body: null };
    }

    if (pathname.includes("/ngsi-ld/v1/entities/") && pathname.endsWith("/attrs") && method === "PATCH") {
      const prefix = "/ngsi-ld/v1/entities/";
      const idx = pathname.indexOf(prefix);
      const idPart = pathname.slice(idx + prefix.length, pathname.length - "/attrs".length);
      const id = decodeURIComponent(idPart);
      const existing = store.find((r) => r.id === id);
      if (!existing) {
        return { status: 404, body: { title: "Entity not found", status: 404 } };
      }
      Object.assign(existing, decodeAttrs(body));
      return { status: 204, body: null };
    }

    if (pathname.includes("/ngsi-ld/v1/entities/") && method === "GET") {
      const prefix = "/ngsi-ld/v1/entities/";
      const id = decodeURIComponent(pathname.slice(pathname.indexOf(prefix) + prefix.length));
      const existing = store.find((r) => r.id === id);
      if (!existing) {
        return { status: 404, body: { title: "Entity not found", status: 404 } };
      }
      return { status: 200, body: existing };
    }

    if (pathname.includes("/ngsi-ld/v1/entities/") && method === "DELETE") {
      const prefix = "/ngsi-ld/v1/entities/";
      const id = decodeURIComponent(pathname.slice(pathname.indexOf(prefix) + prefix.length));
      store = store.filter((r) => r.id !== id);
      return { status: 204, body: null };
    }

    if (pathname.endsWith("/ngsi-ld/v1/temporal/entities") && method === "GET") {
      const type = params.get("type");
      const ids = params.get("id")?.split(",");
      return {
        status: 200,
        body: (fixture?.temporal ?? []).filter((item) => (!type || item.type === type) && (!ids || ids.includes(item.id))),
      };
    }

    if (pathname.endsWith("/schema/index.json") && method === "GET") {
      return { status: 200, body: { models: [{ version: 1 }] } };
    }

    if (pathname.endsWith("/schema/v1/json-schema") && method === "GET") {
      const defs = fixture?.schema ?? deriveSchema(store);
      return { status: 200, body: { $defs: defs } };
    }

    if (pathname.endsWith("/access") && method === "GET") {
      const access: AccessDocument = fixture?.access ?? {
        permissions: [{ resource: { type: "*" }, actions: ["*"], attributes: "*" }],
        prohibitions: [],
      };
      return { status: 200, body: access };
    }

    return { status: 400, body: { title: "Bad Request", status: 400 } };
  };

  const stub = transport as StubTransport;
  stub.calls = calls;
  stub.rows = () => store;
  return stub;
}

export function stubClient(fixture?: Fixture, config?: Partial<JcConfig>): Client & { transport: StubTransport } {
  const fullConfig: JcConfig = {
    slug: "demo",
    orgDomain: "example.org",
    space: "demo",
    transport: "bridge",
    ...config,
  };
  const transport = stubTransport(fixture);
  const client = createClient(fullConfig, transport);
  return Object.assign(client, { transport });
}

export function fakeContext(
  fixture?: Fixture & { user?: JcUser | null },
): { jc: DataClient; log(...parts: unknown[]): void; logs: unknown[][] } {
  const transport = stubTransport(fixture);
  const fullConfig: JcConfig = {
    slug: "demo",
    orgDomain: "example.org",
    space: "demo",
    transport: "bridge",
    user: fixture?.user ?? null,
  };
  const client = createClient(fullConfig, transport);
  const logs: unknown[][] = [];
  return {
    jc: client,
    log: (...parts: unknown[]) => logs.push(parts),
    logs,
  };
}

/** What a control of the page is called in the record: its role and the name a person reads. */
const CONTROLS =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [role="slider"]';

function roleOf(element: Element): string {
  const role = element.getAttribute("role");
  if (role) return role;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") return type;
    if (type === "range") return "slider";
    if (type === "submit" || type === "button" || type === "reset") return "button";
    return "textbox";
  }
  return tag;
}

/**
 * The words a screen reader takes from `root`: its text without what is `aria-hidden`, and without
 * the control a label wraps (a list's options are not its name).
 */
function spokenText(root: Element, skip?: Element): string {
  let text = "";
  const walk = (node: Node) => {
    if (node === skip) return;
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
    else if (!(node instanceof Element && node.getAttribute("aria-hidden") === "true")) node.childNodes.forEach(walk);
  };
  walk(root);
  return text;
}

function nameOf(element: Element): string {
  const doc = element.ownerDocument;
  const labelledBy = element.getAttribute("aria-labelledby");
  const fromIds = labelledBy
    ? labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" ")
    : "";
  const labels = (element as HTMLInputElement).labels;
  const fromLabel = labels && labels.length > 0 ? spokenText(labels[0], element) : "";
  // A field's content is its value or its options, never its name.
  const fromContent = element.matches("select, textarea, input") ? "" : spokenText(element);
  const name =
    element.getAttribute("aria-label") ||
    fromIds ||
    fromLabel ||
    fromContent ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    element.getAttribute("name") ||
    "";
  return name.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** One control in the record: `role: name`, the same for every render of it, its numbers as `#`. */
export function controlId(element: Element): string {
  // A count or a page number in a name ("Road work (5)") changes with the data; the control does not.
  return `${roleOf(element)}: ${nameOf(element).replace(/\d+(?:[\s\u00a0.,]\d+)*/g, "#")}`;
}

function usable(element: Element): boolean {
  // A control removed before the observer reported it was never on screen, and has no name left.
  // Inside an SDK component that marks itself `data-jc-sdk` (the grid), a control is the SDK suite's.
  return element.isConnected && element.closest("[data-jc-sdk]") === null && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true" && element.closest('[aria-hidden="true"]') === null;
}

/** An environment variable under vitest, `undefined` in a browser; no Node types needed. */
function envOf(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}

/**
 * Records which controls a test file rendered and which its tests clicked or typed into, for the
 * Apps' coverage gate (T-3373): a control no test exercises fails it. Call it once from the test
 * setup, `recordControls(afterAll)`; it writes one JSON file into `JC_CONTROLS_DIR` when that is set
 * and does nothing otherwise. A disabled or hidden control, one gone before it was reported, or one
 * inside an SDK component marked `data-jc-sdk` (its own suite tests it) is not counted.
 */
export function recordControls(afterAll: (done: () => Promise<void>) => void, dir: string | undefined = envOf("JC_CONTROLS_DIR")): void {
  if (!dir || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  const rendered = new Set<string>();
  const exercised = new Set<string>();
  const scan = (root: ParentNode) => {
    if (root instanceof Element && root.matches(CONTROLS) && usable(root)) rendered.add(controlId(root));
    for (const element of Array.from(root.querySelectorAll(CONTROLS))) {
      if (usable(element)) rendered.add(controlId(element));
    }
  };
  const take = (mutations: MutationRecord[]) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof Element) scan(node);
      }
      // A control's name can change after it is added (a count, a loaded label): only the control
      // the change is in is read again, so a long list costs one pass, not one per row.
      const node = mutation.target;
      const control = (node instanceof Element ? node : node.parentElement)?.closest(CONTROLS);
      if (control && usable(control)) rendered.add(controlId(control));
    }
  };
  const observer = new MutationObserver(take);
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  scan(document);
  const touched = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest(CONTROLS) : null;
    if (target) exercised.add(controlId(target));
  };
  for (const type of ["click", "input", "change", "keydown"]) document.addEventListener(type, touched, true);
  afterAll(async () => {
    // The observer reports in a later task: what is still queued, and what is on the page now.
    take(observer.takeRecords());
    observer.disconnect();
    scan(document);
    // Named through a variable, so neither the App's type check (no Node types, AP-82) nor its
    // bundle sees Node's modules: the record is only ever written under vitest.
    const fsName = "node:fs";
    const { mkdirSync, writeFileSync } = (await import(/* @vite-ignore */ fsName)) as {
      mkdirSync: (path: string, options: { recursive: boolean }) => void;
      writeFileSync: (path: string, data: string) => void;
    };
    mkdirSync(dir, { recursive: true });
    const file = `${dir.replace(/\/+$/, "")}/controls-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(file, JSON.stringify({ rendered: [...rendered].sort(), exercised: [...exercised].sort() }));
  });
}
