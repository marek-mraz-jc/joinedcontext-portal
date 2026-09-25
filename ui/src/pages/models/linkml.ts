/**
 * The LinkML document the editor edits, and the rules it is judged by.
 *
 * The YAML text is the single source of truth: the structured view reads a projection of it
 * and writes back through the YAML document, so a comment or a hand-made ordering survives a
 * click in the tree, and the two views cannot drift (DM-13). Nothing here reaches the network;
 * the authoritative artifacts come from Model Tools (DM-18).
 */
import { parseDocument, type Document } from "yaml";

/** The NGSI-LD kinds a slot may declare (DM-05), in the annotation Model Tools reads. */
export const NGSI_LD_KINDS = [
  "Property",
  "GeoProperty",
  "Relationship",
  "LanguageProperty",
  "ListProperty",
  "JsonProperty",
  "VocabProperty",
] as const;

export type NgsiLdKind = (typeof NGSI_LD_KINDS)[number];

/** A slot without the annotation is a plain Property: the common case stays unwritten. */
export const DEFAULT_KIND: NgsiLdKind = "Property";

/**
 * Namespaces an organisation must never mint its own terms under (DM-04, DM-16). Reusing an
 * upstream IRI is how a model says it means the same thing as a standard; minting a new term
 * under someone else's namespace is squatting. The list is Model Tools' own, so the editor
 * refuses exactly what generation would refuse.
 */
export const RESERVED_NAMESPACES = [
  "https://smartdatamodels.org/",
  "https://raw.githubusercontent.com/smart-data-models/",
  "https://github.com/smart-data-models/",
  "https://uri.etsi.org/",
  "http://uri.etsi.org/",
  "https://www.w3.org/",
  "http://www.w3.org/",
  "https://w3id.org/linkml/",
] as const;

/** A slot carrying this annotation cites an upstream term, so a reserved IRI is a citation. */
export const UPSTREAM_ANNOTATION = "upstream_source";

/**
 * UN/CEFACT common codes for the units a municipal model actually measures in (DM-06).
 *
 * The full CEFACT recommendation 20 is thousands of codes; this is the working set the unit
 * picker offers, and any other code can still be typed. `ucum` is what LinkML's `unit.ucum_code`
 * takes, `code` is the CEFACT common code that travels in `exact_mappings`, and `qudt` and
 * `quantityKind` are the anchor beside it (DM-59): the IRI a federated reader dereferences, and
 * the dimension that lets two organisations' measurements be aligned rather than two opaque
 * codes compared.
 *
 * This is the crosswalk, and it is here because here is where a person picks a unit; the model
 * records the choice and every generator reads the model. Model Tools keeps the same table for
 * the one path with no person in it — inferring a model from a sample —
 * (`tools/model-tools/src/infer_schema.py`, `UNIT_UCUM` and `UNIT_QUDT`, in the other
 * repository). Nothing can compare the two from inside one checkout, so a code added here
 * belongs there in the same change. Both were read out of QUDT's own vocabulary by
 * `qudt:ucumCode`, never written from memory: `ug/m3` is `MassDensity` to QUDT, not the
 * `MassConcentration` a person would guess.
 */
export const UNIT_CODES = [
  { code: "GQ", ucum: "ug/m3", label: "microgram per cubic metre", qudt: "MicroGM-PER-M3", quantityKind: "MassDensity" },
  { code: "M1", ucum: "mg/L", label: "milligram per litre", qudt: "MilliGM-PER-L", quantityKind: "MassConcentration" },
  { code: "CEL", ucum: "Cel", label: "degree Celsius", qudt: "DEG_C", quantityKind: "Temperature" },
  { code: "P1", ucum: "%", label: "percent", qudt: "PERCENT", quantityKind: "DimensionlessRatio" },
  { code: "MTR", ucum: "m", label: "metre", qudt: "M", quantityKind: "Length" },
  { code: "KMT", ucum: "km", label: "kilometre", qudt: "KiloM", quantityKind: "Length" },
  { code: "MTS", ucum: "m/s", label: "metre per second", qudt: "M-PER-SEC", quantityKind: "Speed" },
  { code: "KMH", ucum: "km/h", label: "kilometre per hour", qudt: "KiloM-PER-HR", quantityKind: "LinearVelocity" },
  { code: "SEC", ucum: "s", label: "second", qudt: "SEC", quantityKind: "Time" },
  { code: "HUR", ucum: "h", label: "hour", qudt: "HR", quantityKind: "Time" },
  { code: "KGM", ucum: "kg", label: "kilogram", qudt: "KiloGM", quantityKind: "Mass" },
  { code: "TNE", ucum: "t", label: "tonne", qudt: "TONNE", quantityKind: "Mass" },
  { code: "LTR", ucum: "L", label: "litre", qudt: "L", quantityKind: "Volume" },
  { code: "MTQ", ucum: "m3", label: "cubic metre", qudt: "M3", quantityKind: "Volume" },
  { code: "KWH", ucum: "kW.h", label: "kilowatt hour", qudt: "KiloW-HR", quantityKind: "Energy" },
  { code: "WTT", ucum: "W", label: "watt", qudt: "W", quantityKind: "Power" },
  { code: "A24", ucum: "cd/m2", label: "candela per square metre", qudt: "CD-PER-M2", quantityKind: "Luminance" },
  { code: "2N", ucum: "dB", label: "decibel", qudt: "DeciB", quantityKind: "SoundPressureLevel" },
  { code: "HPA", ucum: "hPa", label: "hectopascal", qudt: "HectoPA", quantityKind: "ForcePerArea" },
  { code: "C62", ucum: "1", label: "one (dimensionless)", qudt: "NUM", quantityKind: "Dimensionless" },
] as const;

/** The LinkML ranges the editor offers, and how a dashboard may use each of them (DM-20). */
export const RANGES = [
  "string",
  "integer",
  "float",
  "double",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "uri",
  "uriorcurie",
] as const;

export interface LinkmlUnit {
  ucum_code?: string;
  symbol?: string;
  /** The UN/CEFACT code NGSI-LD puts on the wire, and the QUDT unit beside it (DM-06, DM-59). */
  exact_mappings?: string[];
  /** The dimension, `qudt:hasQuantityKind`: what makes two units comparable at all (DM-59). */
  has_quantity_kind?: string;
}

export interface LinkmlSlot {
  name: string;
  range?: string;
  required?: boolean;
  multivalued?: boolean;
  deprecated?: boolean;
  description?: string;
  title?: Record<string, string>;
  slot_uri?: string;
  unit?: LinkmlUnit;
  kind: NgsiLdKind;
  /** Where an upstream term came from, when this slot cites one (DM-08, DM-16). */
  upstream?: string;
  pattern?: string;
  minimum_value?: number;
  maximum_value?: number;
  /** The profiles this slot belongs to, as LinkML `subsets`: which of them a projection takes. */
  subsets?: string[];
  /** The other end of a relationship, as LinkML `inverse` (DM-64). */
  inverse?: string;
  /** Whether the target is written inside the entity; a relationship never is (DM-64). */
  inlined?: boolean;
  /** The delete rule a relationship's source end carries, as written (DM-66). */
  on_delete?: string;
}

export interface LinkmlClass {
  name: string;
  class_uri?: string;
  description?: string;
  title?: Record<string, string>;
  slots: string[];
  /** The class this one specialises, as LinkML `is_a` (DM-13). */
  is_a?: string;
  /** The classes this one mixes in, as LinkML `mixins`. */
  mixins?: string[];
  /**
   * The slots the class declares inline, as LinkML `attributes`: a Smart Data Model writes most
   * of its fields this way. Kept apart from `slots`, which is the list operations write back.
   */
  attributes?: LinkmlSlot[];
  /** How the class narrows a slot it uses, as LinkML `slot_usage`. */
  slot_usage?: Record<string, SlotUsage>;
  /** The import the class came from, when it is not the model's own. */
  from?: string;
}

/** What a class may narrow of a slot it uses (LinkML `slot_usage`); only what it names. */
export type SlotUsage = Partial<Pick<LinkmlSlot, "range" | "required" | "multivalued" | "description">>;

export interface LinkmlEnumValue {
  name: string;
  meaning?: string;
  description?: string;
  /** What a person reads for the value, per language (UI-86); LinkML's `title`. */
  title?: Record<string, string>;
}

export interface LinkmlEnum {
  name: string;
  permissible_values: LinkmlEnumValue[];
  /** The import the enum came from, when it is not the model's own. */
  from?: string;
}

/** The projection the structured view renders. Never the thing that is saved. */
export interface LinkmlModel {
  id?: string;
  name?: string;
  title?: Record<string, string>;
  prefixes: Record<string, string>;
  default_prefix?: string;
  classes: LinkmlClass[];
  slots: LinkmlSlot[];
  enums: LinkmlEnum[];
  /** The schemas this model imports, as LinkML `imports`. */
  imports?: string[];
}

export interface Diagnostic {
  /** 1-based, so it can be shown next to the line the editor numbers (DM-14). */
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
  /** What the message is about, so the structured view can point at the same thing. */
  path?: string;
  /** The relationship rule it breaks, the identifier the server and Model Tools use (DM-68). */
  rule?: RelationshipRule;
}

export const EMPTY_MODEL: LinkmlModel = {
  prefixes: {},
  classes: [],
  slots: [],
  enums: [],
};

/** A new model, as the editor starts one (DM-13). */
export function blankSource(organizationDomain: string, name: string): string {
  const prefix = organizationDomain.split(".")[0] || "org";
  return [
    `id: https://${organizationDomain}/models/${name}`,
    `name: ${name}`,
    "prefixes:",
    `  ${prefix}: https://${organizationDomain}/terms/`,
    "  linkml: https://w3id.org/linkml/",
    `default_prefix: ${prefix}`,
    "imports:",
    "  - linkml:types",
    "  - ngsi-ld-core",
    "classes: {}",
    "slots: {}",
    "enums: {}",
    "",
  ].join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function languageMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const [locale, phrase] of Object.entries(value as Record<string, unknown>)) {
    if (typeof phrase === "string") {
      map[locale] = phrase;
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

function slotOf(name: string, raw: Record<string, unknown>): LinkmlSlot {
  const annotated = record(raw.annotations);
  const kind = text(annotated.ngsi_ld_kind);
  const unit = record(raw.unit);
  const mappings = Array.isArray(unit.exact_mappings)
    ? (unit.exact_mappings as unknown[]).filter((m): m is string => typeof m === "string")
    : undefined;
  return {
    name,
    range: text(raw.range),
    required: raw.required === true,
    multivalued: raw.multivalued === true,
    deprecated: raw.deprecated === true,
    description: text(raw.description),
    title: languageMap(raw.title),
    slot_uri: text(raw.slot_uri),
    unit:
      Object.keys(unit).length > 0
        ? {
            ucum_code: text(unit.ucum_code),
            symbol: text(unit.symbol),
            ...(mappings && mappings.length > 0 ? { exact_mappings: mappings } : {}),
            has_quantity_kind: text(unit.has_quantity_kind),
          }
        : undefined,
    kind: (NGSI_LD_KINDS as readonly string[]).includes(kind ?? "")
      ? (kind as NgsiLdKind)
      : DEFAULT_KIND,
    upstream: text(annotated[UPSTREAM_ANNOTATION]),
    pattern: text(raw.pattern),
    minimum_value: typeof raw.minimum_value === "number" ? raw.minimum_value : undefined,
    subsets: names(raw.subsets),
    maximum_value: typeof raw.maximum_value === "number" ? raw.maximum_value : undefined,
    inverse: text(raw.inverse),
    inlined: typeof raw.inlined === "boolean" ? raw.inlined : undefined,
    on_delete: text(annotated.on_delete),
  };
}

/** A list of names as the metamodel writes them: a YAML sequence of strings, or nothing. */
function names(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const found = (value as unknown[]).filter((one): one is string => typeof one === "string");
  return found.length > 0 ? found : undefined;
}

/** What a `slot_usage` entry narrows: only the fields it writes, so the rest stay the slot's. */
function usageOf(raw: Record<string, unknown>): SlotUsage {
  const usage: SlotUsage = {};
  if (text(raw.range)) usage.range = text(raw.range);
  if (typeof raw.required === "boolean") usage.required = raw.required;
  if (typeof raw.multivalued === "boolean") usage.multivalued = raw.multivalued;
  if (text(raw.description)) usage.description = text(raw.description);
  return usage;
}

/** The structured projection of a source that parses; `EMPTY_MODEL` for one that does not. */
export function parseModel(source: string): LinkmlModel {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return EMPTY_MODEL;
  }
  const root = record(document.toJS({ maxAliasCount: 100 }));

  const prefixes: Record<string, string> = {};
  for (const [prefix, target] of Object.entries(record(root.prefixes))) {
    const expansion =
      typeof target === "string" ? target : text(record(target).prefix_reference);
    if (expansion) {
      prefixes[prefix] = expansion;
    }
  }

  const classes: LinkmlClass[] = Object.entries(record(root.classes)).map(([name, value]) => {
    const raw = record(value);
    const slots = Array.isArray(raw.slots)
      ? (raw.slots as unknown[]).filter((s): s is string => typeof s === "string")
      : [];
    return {
      name,
      class_uri: text(raw.class_uri),
      description: text(raw.description),
      title: languageMap(raw.title),
      slots,
      // The hierarchy the model declares (DM-13): read so the editor, the preview and the
      // breaking-change detector see what the YAML says instead of only the flat class list.
      is_a: text(raw.is_a),
      mixins: names(raw.mixins),
      attributes: Object.entries(record(raw.attributes)).map(([slot, value]) => slotOf(slot, record(value))),
      slot_usage: Object.fromEntries(
        Object.entries(record(raw.slot_usage)).map(([slot, value]) => [slot, usageOf(record(value))]),
      ),
    };
  });

  const slots = Object.entries(record(root.slots)).map(([name, value]) =>
    slotOf(name, record(value)),
  );

  const enums: LinkmlEnum[] = Object.entries(record(root.enums)).map(([name, value]) => {
    const raw = record(value);
    const permissible = Object.entries(record(raw.permissible_values)).map(
      ([valueName, entry]) => {
        const details = record(entry);
        const title = text(details.title);
        return {
          name: valueName,
          meaning: text(details.meaning),
          description: text(details.description),
          // A plain string title is the model's one language; a map is read per language.
          title: title ? { en: title } : languageMap(details.title),
        };
      },
    );
    return { name, permissible_values: permissible };
  });

  return {
    id: text(root.id),
    name: text(root.name),
    title: languageMap(root.title),
    prefixes,
    default_prefix: text(root.default_prefix),
    classes,
    slots,
    enums,
    imports: names(root.imports),
  };
}

/** A CURIE resolved against the model's own prefixes; anything else is returned unchanged. */
export function expandIri(iri: string, prefixes: Record<string, string>): string {
  const colon = iri.indexOf(":");
  if (colon <= 0 || iri.startsWith("http://") || iri.startsWith("https://")) {
    return iri;
  }
  const expansion = prefixes[iri.slice(0, colon)];
  return expansion ? `${expansion}${iri.slice(colon + 1)}` : iri;
}

/** The reserved namespace an IRI falls under, or `undefined` where it is the organisation's. */
export function reservedNamespace(
  iri: string,
  prefixes: Record<string, string>,
): string | undefined {
  const expanded = expandIri(iri, prefixes);
  return RESERVED_NAMESPACES.find((namespace) => expanded.startsWith(namespace));
}

/**
 * Every problem the editor can see without compiling: the YAML itself, and the metamodel rules
 * a model has to satisfy before it may be published (DM-04, DM-05, DM-06, DM-14, DM-15, DM-16).
 *
 * `locales` are the organisation's configured languages; a title missing one of them is a
 * warning here and a block at publish time (DM-15).
 */
export function diagnose(
  source: string,
  locales: string[] = [],
  imported: Record<string, LinkmlModel> = {},
): Diagnostic[] {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return document.errors.map((error) => ({
      line: error.linePos?.[0]?.line ?? 1,
      column: error.linePos?.[0]?.col ?? 1,
      severity: "error" as const,
      message: error.message,
    }));
  }

  const model = parseModel(source);
  const root = record(document.toJS({ maxAliasCount: 100 }));
  const found: Diagnostic[] = [];
  const at = (path: (string | number)[]): Pick<Diagnostic, "line" | "column"> =>
    positionOf(document, path);

  if (!model.id) {
    found.push({ ...at([]), severity: "error", message: "the model needs an `id`", path: "id" });
  }
  if (!model.name) {
    found.push({
      ...at([]),
      severity: "error",
      message: "the model needs a `name`",
      path: "name",
    });
  }
  if (model.classes.length === 0) {
    found.push({
      ...at([]),
      severity: "warning",
      message: "the model declares no class, so it defines no entity type",
      path: "classes",
    });
  }

  const declared = new Set(model.slots.map((slot) => slot.name));
  for (const klass of model.classes) {
    if (!klass.class_uri) {
      found.push({
        ...at(["classes", klass.name]),
        severity: "warning",
        message: `class '${klass.name}' has no class_uri, and a model without complete IRI bindings cannot be published`,
        path: `classes.${klass.name}`,
      });
    }
    for (const slot of klass.slots) {
      if (!declared.has(slot)) {
        found.push({
          ...at(["classes", klass.name, "slots"]),
          severity: "error",
          message: `class '${klass.name}' uses slot '${slot}', which the model does not declare`,
          path: `classes.${klass.name}`,
        });
      }
    }
    found.push(
      ...missingLocales(
        klass.title,
        locales,
        `class '${klass.name}'`,
        at(["classes", klass.name]),
        `classes.${klass.name}`,
      ),
    );
  }

  for (const slot of model.slots) {
    const where = at(["slots", slot.name]);
    if (!slot.slot_uri) {
      found.push({
        ...where,
        severity: "warning",
        message: `slot '${slot.name}' has no slot_uri, and a model without complete IRI bindings cannot be published`,
        path: `slots.${slot.name}`,
      });
    } else {
      const reserved = reservedNamespace(slot.slot_uri, model.prefixes);
      if (reserved && !slot.upstream) {
        found.push({
          ...where,
          severity: "error",
          message: `slot '${slot.name}' mints '${slot.slot_uri}' under ${reserved}, which belongs to someone else; use the organisation's own prefix, or cite the upstream term with an ${UPSTREAM_ANNOTATION} annotation`,
          path: `slots.${slot.name}`,
        });
      }
    }
    if (!slot.range) {
      found.push({
        ...where,
        severity: "warning",
        message: `slot '${slot.name}' has no range, so it falls back to the model's default_range`,
        path: `slots.${slot.name}`,
      });
    }
    if (slot.unit && !slot.unit.ucum_code && !unitCode(slot.unit)) {
      found.push({
        ...where,
        severity: "warning",
        message: `slot '${slot.name}' declares a unit without a UN/CEFACT common code, so exports and dashboards cannot label it`,
        path: `slots.${slot.name}`,
      });
    }
    found.push(
      ...missingLocales(slot.title, locales, `slot '${slot.name}'`, where, `slots.${slot.name}`),
    );
  }

  // The annotation is free text in YAML, so a typo would only surface at generation.
  for (const [name, raw] of Object.entries(record(root.slots))) {
    const kind = text(record(record(raw).annotations).ngsi_ld_kind);
    if (kind && !(NGSI_LD_KINDS as readonly string[]).includes(kind)) {
      found.push({
        ...at(["slots", name]),
        severity: "error",
        message: `slot '${name}' declares ngsi_ld_kind '${kind}', which is not one of ${NGSI_LD_KINDS.join(", ")}`,
        path: `slots.${name}`,
      });
    }
  }

  // Relationships are strict (DM-68): every broken rule is an error that blocks Save, and the
  // server refuses the same list through Model Tools, so this is the early copy, not the gate.
  const { problems, unverified } = relationshipsOf(model, imported);
  for (const problem of problems) {
    found.push({
      ...at(problem.path.split(".")),
      severity: "error",
      message: problem.message,
      path: problem.path,
      rule: problem.rule,
    });
  }
  for (const [path, range] of unverified) {
    found.push({
      ...at(path.split(".")),
      severity: "warning",
      message: `${path.split(".").pop()} points at '${range}', which is no class of this model; the imports it may come from are not loaded here, so saving checks it`,
      path,
    });
  }
  return found;
}

/** The CEFACT common code a unit carries in `exact_mappings`, per DM-06. */
export function unitCode(unit: LinkmlUnit | undefined): string | undefined {
  const mapping = unit?.exact_mappings?.find((entry) => entry.includes(":"));
  return mapping?.split(":").pop() || undefined;
}

function missingLocales(
  title: Record<string, string> | undefined,
  locales: string[],
  what: string,
  where: Pick<Diagnostic, "line" | "column">,
  path: string,
): Diagnostic[] {
  if (locales.length === 0 || !title) {
    return [];
  }
  const missing = locales.filter((locale) => !title[locale]);
  return missing.length === 0
    ? []
    : [
        {
          ...where,
          severity: "warning",
          message: `${what} has no title in ${missing.join(", ")}`,
          path,
        },
      ];
}

/** Where a path sits in the source, so a message can point at the line it is about. */
export function positionOf(
  document: Document.Parsed,
  path: (string | number)[],
): { line: number; column: number } {
  const node = path.length > 0 ? document.getIn(path, true) : undefined;
  const offset =
    node && typeof node === "object" && "range" in node
      ? (node as { range?: [number, number, number] }).range?.[0]
      : undefined;
  if (offset === undefined) {
    return { line: 1, column: 1 };
  }
  const before = document.toString().slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Applies one structured edit to the source and returns the new source.
 *
 * Every visual edit goes through the YAML document rather than through a re-serialised object,
 * so the user's comments, key order and formatting survive an edit made in the tree (DM-13).
 */
/** What a merge could not take, because the model already had something by that name. */
export interface MergeConflict {
  section: "classes" | "slots" | "enums" | "prefixes";
  name: string;
}

/**
 * A second imported model folded into the one being edited (T-1102, DM-07).
 *
 * Importing replaced the source, so a person could hold one catalogue model at a time and never
 * connect two: a Vehicle and an AirQualityObserved had to live in one model before a slot could
 * relate them. This adds what the incoming model has and the current one does not, and keeps
 * what is already there — a name that exists is reported rather than overwritten, because the
 * version in hand may have been edited and the import must not undo that.
 *
 * The current document is mutated through the YAML AST, so its comments and its order survive.
 */
export function mergeModels(
  current: string,
  incoming: string,
): { source: string; conflicts: MergeConflict[] } {
  const conflicts: MergeConflict[] = [];
  const parsed = parseDocument(incoming);
  if (parsed.errors.length > 0) {
    return { source: current, conflicts };
  }
  const other = record(parsed.toJS({ maxAliasCount: 100 }));
  const merged = edit(current, (document) => {
    for (const section of ["prefixes", "classes", "slots", "enums"] as const) {
      const entries = record(other[section]);
      const held = record(parseDocument(current).toJS({ maxAliasCount: 100 })[section]);
      for (const [name, value] of Object.entries(entries)) {
        if (document.hasIn([section, name])) {
          // Two models declaring the same prefix for the same namespace agree; only a name
          // whose definition differs is something the person has to know was kept.
          if (JSON.stringify(held[name]) !== JSON.stringify(value)) {
            conflicts.push({ section, name });
          }
          continue;
        }
        document.setIn([section, name], value);
      }
    }
  });
  return { source: merged, conflicts };
}

export function edit(source: string, mutate: (document: Document) => void): string {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return source;
  }
  mutate(document);
  return document.toString();
}

/** Sets a value, or removes the key when the value is empty. */
export function setOrDelete(
  document: Document,
  path: (string | number)[],
  value: unknown,
): void {
  if (value === undefined || value === "" || value === null || value === false) {
    // A missing parent is not an error: clearing what was never set is a no-op, not a throw.
    if (document.hasIn(path)) {
      document.deleteIn(path);
    }
    return;
  }
  document.setIn(path, value);
}

/**
 * Every slot a class carries: its own, and the ones its parent and its mixins bring (DM-13).
 *
 * A class that specialises another answers with the parent's slots too, so an endpoint
 * projecting by class sees what the entity will actually carry rather than the line the class
 * happens to declare itself (T-1112). A hierarchy that loops is walked once and no further.
 */
export function effectiveSlots(model: LinkmlModel, klass: LinkmlClass): string[] {
  const byName = new Map(model.classes.map((one) => [one.name, one]));
  const slots: string[] = [];
  const walked = new Set<string>();
  const walk = (current: LinkmlClass): void => {
    if (walked.has(current.name)) {
      return;
    }
    walked.add(current.name);
    // The parent's first: a reader meets the inherited shape before what this class adds.
    const parent = current.is_a === undefined ? undefined : byName.get(current.is_a);
    if (parent !== undefined) {
      walk(parent);
    }
    for (const mixin of current.mixins ?? []) {
      const mixed = byName.get(mixin);
      if (mixed !== undefined) {
        walk(mixed);
      }
    }
    for (const slot of current.slots) {
      if (!slots.includes(slot)) {
        slots.push(slot);
      }
    }
  };
  walk(klass);
  return slots;
}

export type Affordance =
  | "range"
  | "select"
  | "multi-select"
  | "temporal"
  | "geometry"
  | "link"
  | "language-map"
  | "code"
  | "text";

/**
 * How a dashboard may use a slot, derived from its range and kind (DM-20).
 *
 * `enums` are the model's own enum names: a slot whose range is one of them is a select, which
 * the classification could never reach while it judged the slot alone (T-1113).
 *
 * The kind is read before the range, because the four NGSI-LD kinds beyond Property and
 * Relationship say what the value *is* and the range only says what one element of it is
 * (Architecture/11 §1.1, T-1175). Without them a language map and an opaque document both
 * arrived here as `text`, and the editor offered a text filter over a JSON object.
 */
export function slotAffordance(slot: LinkmlSlot, enums: readonly string[] = []): Affordance {
  if (slot.kind === "GeoProperty") {
    return "geometry";
  }
  if (slot.kind === "Relationship") {
    return "link";
  }
  if (slot.kind === "LanguageProperty") {
    // One value per locale: a single text box would edit whichever language it happened to
    // show and silently drop the rest.
    return "language-map";
  }
  if (slot.kind === "JsonProperty") {
    // The model does not describe what is inside, so nothing can be generated for it but a
    // view of the document itself.
    return "code";
  }
  if (slot.kind === "VocabProperty") {
    // A term of a vocabulary, which the model supplies as an enum.
    return "select";
  }
  if (slot.kind === "ListProperty") {
    // Several values at once. A list of terms picks from them; a list of anything else has no
    // set to pick from, so it stays what its elements are.
    return slot.range !== undefined && enums.includes(slot.range) ? "multi-select" : "text";
  }
  if (slot.range !== undefined && enums.includes(slot.range)) {
    return "select";
  }
  if (slot.range === "date" || slot.range === "datetime") {
    return "temporal";
  }
  if (["integer", "float", "double", "decimal"].includes(slot.range ?? "")) {
    return "range";
  }
  return "text";
}

/**
 * What a dashboard does with a slot of this affordance, beside the filter it offers (DM-20):
 * a numeric slot sizes a mark, an enum colours one. The rest carry the dashboard no dimension
 * of their own.
 */
export function slotDimension(affordance: Affordance): "sizeBy" | "colorBy" | undefined {
  if (affordance === "range") {
    return "sizeBy";
  }
  // Only a single pick colours a mark: a multi-select has no one value per entity to colour
  // by, and a language map and a document have none at all.
  return affordance === "select" ? "colorBy" : undefined;
}

/**
 * Every slot a class has, as it has it: the `slots` it lists (narrowed by its `slot_usage`),
 * then its own `attributes`. A listed slot the model does not declare is left out; `diagnose`
 * reports it.
 */
export function classSlots(model: LinkmlModel, klass: LinkmlClass): LinkmlSlot[] {
  const declared = new Map(model.slots.map((slot) => [slot.name, slot]));
  const listed = klass.slots.flatMap((name) => {
    const slot = declared.get(name);
    return slot === undefined ? [] : [{ ...slot, ...klass.slot_usage?.[name] }];
  });
  const own = new Set(listed.map((slot) => slot.name));
  return [...listed, ...(klass.attributes ?? []).filter((slot) => !own.has(slot.name))];
}

/** Where an import points, as the name of a model: `./air.linkml.yaml` and `air` are both `air`. */
export function importName(target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^https?:/i.test(target)) {
    // A CURIE such as `linkml:types` names the metamodel's own schemas, not a model of ours.
    return undefined;
  }
  const last = target.split(/[/#?]/).filter((part) => part !== "" && part !== ".").at(-1);
  const name = last?.replace(/\.linkml\.ya?ml$|\.ya?ml$/i, "");
  return name === undefined || name === "" ? undefined : name;
}

/**
 * The model with what it imports: every class, slot and enum of an imported model the model
 * does not declare itself, the classes and enums marked with the import they came from. The
 * model's own declaration wins a name both carry, as LinkML resolves it.
 */
export function withImports(model: LinkmlModel, imported: Record<string, LinkmlModel>): LinkmlModel {
  const classes = [...model.classes];
  const slots = [...model.slots];
  const enums = [...model.enums];
  const has = (list: { name: string }[], name: string) => list.some((one) => one.name === name);
  for (const [from, other] of Object.entries(imported)) {
    for (const klass of other.classes) {
      if (!has(classes, klass.name)) classes.push({ ...klass, from: klass.from ?? from });
    }
    for (const slot of other.slots) {
      if (!has(slots, slot.name)) slots.push(slot);
    }
    for (const entry of other.enums) {
      if (!has(enums, entry.name)) enums.push({ ...entry, from: entry.from ?? from });
    }
  }
  return { ...model, classes, slots, enums };
}

/** One box of the graph: a class with its own slots, or an enum with its values. */
export interface GraphNode {
  name: string;
  kind: "class" | "enum";
  /** A class's own slots (listed and inline), without the inherited ones; an enum's values. */
  slots: string[];
  /** How far down the `is_a` chain it sits, which is the row it is drawn on; enums go last. */
  depth: number;
  /** The import it came from, when it is not the model's own. */
  from?: string;
}

/** One line between two boxes, and why it is there. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: "is_a" | "mixin" | "range" | "enum";
  /** The slot whose range draws the line, for a `range` or an `enum` edge. */
  label?: string;
}

/**
 * The model as boxes and the lines between them (DM-13, T-1111, T-2720).
 *
 * Four kinds of line, because a reader asks four different questions of a model: what a class
 * specialises (`is_a`), what it mixes in (`mixins`), which class one of its slots points at (a
 * `range` that names another class), and which enum a slot picks from. A slot whose range is a
 * primitive draws no line: it is inside the box. Enums are boxes of their own, with their values,
 * on a row below the classes.
 *
 * The depth is the length of the `is_a` chain, computed here rather than by a layout library:
 * a class graph is a forest of short chains, and rows by depth put every parent above its
 * children without a dependency that would have to be pinned, audited and shipped.
 */
export function graphData(model: LinkmlModel): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const byName = new Map(model.classes.map((klass) => [klass.name, klass]));
  const enumNames = new Set(model.enums.map((entry) => entry.name));

  const depthOf = (klass: LinkmlClass, seen: Set<string> = new Set()): number => {
    // A cycle is a model somebody is still editing, not a reason to hang: the chain stops.
    if (klass.is_a === undefined || seen.has(klass.name)) {
      return 0;
    }
    seen.add(klass.name);
    const parent = byName.get(klass.is_a);
    return parent === undefined ? 0 : depthOf(parent, seen) + 1;
  };

  const nodes: GraphNode[] = model.classes.map((klass) => ({
    name: klass.name,
    kind: "class",
    slots: [...klass.slots, ...(klass.attributes ?? []).map((slot) => slot.name).filter((name) => !klass.slots.includes(name))],
    depth: depthOf(klass),
    ...(klass.from ? { from: klass.from } : {}),
  }));
  const enumRow = nodes.length === 0 ? 0 : Math.max(...nodes.map((node) => node.depth)) + 1;
  for (const entry of model.enums) {
    nodes.push({
      name: entry.name,
      kind: "enum",
      slots: entry.permissible_values.map((value) => value.name),
      depth: enumRow,
      ...(entry.from ? { from: entry.from } : {}),
    });
  }

  const edges: GraphEdge[] = [];
  for (const klass of model.classes) {
    if (klass.is_a !== undefined && byName.has(klass.is_a)) {
      edges.push({ from: klass.name, to: klass.is_a, kind: "is_a" });
    }
    for (const mixin of klass.mixins ?? []) {
      if (byName.has(mixin)) {
        edges.push({ from: klass.name, to: mixin, kind: "mixin" });
      }
    }
    for (const slot of classSlots(model, klass)) {
      if (slot.range !== undefined && byName.has(slot.range)) {
        edges.push({ from: klass.name, to: slot.range, kind: "range", label: slot.name });
      } else if (slot.range !== undefined && enumNames.has(slot.range)) {
        edges.push({ from: klass.name, to: slot.range, kind: "enum", label: slot.name });
      }
    }
  }
  return { nodes, edges };
}

/** What happens to the entities referencing one that is deleted (DM-66); `restrict` by default. */
export const ON_DELETE_RULES = ["restrict", "cascade", "set-null"] as const;
export type OnDelete = (typeof ON_DELETE_RULES)[number];

/** Read from the source class to the target class (DM-65). */
export const CARDINALITIES = ["one-to-one", "one-to-many", "many-to-one", "many-to-many"] as const;
export type Cardinality = (typeof CARDINALITIES)[number];

/** The rule identifiers of Architecture/11 §1.2, shared with the save route and Model Tools. */
export type RelationshipRule =
  | "range-not-a-class"
  | "class-range-not-relationship"
  | "primitive-range"
  | "inverse-missing"
  | "inverse-not-reciprocal"
  | "slot-in-two-relationships"
  | "required-on-computed-end"
  | "on-delete-unknown"
  | "on-delete-on-both-ends";

/** One end of a relationship: the class, its slot and what the slot says of the other class. */
export interface RelationshipEnd {
  class: string;
  slot: string;
  multivalued: boolean;
  required: boolean;
}

/** A relationship whose two ends agree (DM-64): what the editor, the diagram and forms read. */
export interface Relationship {
  source: RelationshipEnd;
  target: RelationshipEnd;
  cardinality: Cardinality;
  onDelete: OnDelete;
  /** The end whose entities hold the NGSI-LD Relationship; the other is a query (DM-67). */
  stored: "source" | "target";
}

export interface RelationshipProblem {
  rule: RelationshipRule;
  /** `slots.{name}`, or `classes.{class}.attributes.{name}` for an inline slot. */
  path: string;
  message: string;
}

/** The cardinality two `multivalued` flags make, read from the source (DM-65). */
export function cardinalityOf(sourceMany: boolean, targetMany: boolean): Cardinality {
  if (sourceMany) return targetMany ? "many-to-many" : "one-to-many";
  return targetMany ? "many-to-one" : "one-to-one";
}

/** The two `multivalued` flags of a cardinality: the source slot's and the target slot's. */
export function flagsOf(cardinality: Cardinality): { source: boolean; target: boolean } {
  return {
    source: cardinality === "one-to-many" || cardinality === "many-to-many",
    target: cardinality === "many-to-one" || cardinality === "many-to-many",
  };
}

/** Where a foreign key would be: the "many" side, or the source of 1:1 and N:M (DM-67). */
export function storedEnd(cardinality: Cardinality): "source" | "target" {
  return cardinality === "one-to-many" ? "target" : "source";
}

/** The shipped import every model may name, and the class it brings (DM-09). */
const CORE_IMPORT = "ngsi-ld-core";

/** A slot where one class has it: listed or inline, with its `slot_usage` applied. */
interface Placed {
  owner: string;
  slot: LinkmlSlot;
  path: string;
  /** Declaration order, which decides the source of a pair no `on_delete` marks (DM-64). */
  order: number;
}

/**
 * Every relationship of the model and every rule it breaks (DM-64…DM-69).
 *
 * `imported` are the models the model imports, by import name, as far as the caller has them.
 * A range naming no class the model can see is an error when every import is in hand, and is
 * returned as `unverified` otherwise: the save route resolves the imports and decides.
 */
export function relationshipsOf(
  model: LinkmlModel,
  imported: Record<string, LinkmlModel> = {},
): { relationships: Relationship[]; problems: RelationshipProblem[]; unverified: [string, string][] } {
  const all = withImports(model, imported);
  const classes = new Set(all.classes.map((klass) => klass.name));
  const imports = (model.imports ?? []).map(importName).filter((name): name is string => name !== undefined);
  if (imports.includes(CORE_IMPORT)) classes.add("Entity");
  const complete = imports.every((name) => name === CORE_IMPORT || imported[name] !== undefined);
  const enums = new Set(all.enums.map((entry) => entry.name));
  const primitives = new Set<string>(RANGES);

  // Where each slot sits. A declared slot listed by two classes is one slot with two owners.
  const declaredOrder = new Map(model.slots.map((slot, index) => [slot.name, index]));
  const listedBy = new Map<string, string[]>();
  for (const klass of model.classes) {
    for (const name of klass.slots) listedBy.set(name, [...(listedBy.get(name) ?? []), klass.name]);
  }
  const placedIn = (klass: LinkmlClass, order: (name: string, inline: boolean) => number): Placed[] =>
    classSlots(all, klass).map((slot) => {
      const inline = !klass.slots.includes(slot.name);
      return {
        owner: klass.name,
        slot,
        path: inline ? `classes.${klass.name}.attributes.${slot.name}` : `slots.${slot.name}`,
        order: order(slot.name, inline),
      };
    });
  let inlineOrder = model.slots.length;
  const own: Placed[] = model.classes.flatMap((klass) =>
    placedIn(klass, (name, inline) => (inline ? inlineOrder++ : (declaredOrder.get(name) ?? 0))),
  );
  const endOn = (klass: string, name: string): Placed | undefined => {
    const holder = all.classes.find((one) => one.name === klass);
    return holder === undefined ? undefined : placedIn(holder, () => Number.MAX_SAFE_INTEGER).find((one) => one.slot.name === name);
  };

  const problems: RelationshipProblem[] = [];
  const unverified: [string, string][] = [];
  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  const problem = (rule: RelationshipRule, path: string, message: string) => {
    const key = `${rule}|${path}`;
    if (!reported.has(key)) {
      reported.add(key);
      problems.push({ rule, path, message });
    }
  };

  for (const end of own) {
    const { slot, owner, path } = end;
    const range = slot.range;
    const classRange = range !== undefined && classes.has(range);
    if (slot.kind !== "Relationship") {
      if (classRange) {
        problem(
          "class-range-not-relationship",
          path,
          `${slot.name} on ${owner} points at the class ${range} but is a ${slot.kind}; a slot whose range is a class is a Relationship`,
        );
      }
      continue;
    }
    // An external reference: the id of an entity outside the model, with nothing to check.
    if (range === undefined || range === "uriorcurie") {
      if (slot.inverse !== undefined) {
        problem(
          "range-not-a-class",
          path,
          `${slot.name} on ${owner} names the inverse ${slot.inverse} but its range is no class; name the class it points at`,
        );
      }
      continue;
    }
    if (primitives.has(range) || enums.has(range)) {
      problem(
        "primitive-range",
        path,
        `${slot.name} on ${owner} is a Relationship with the range ${range}; a Relationship points at a class, or at uriorcurie for an entity outside the model`,
      );
      continue;
    }
    if (!classRange) {
      if (complete) {
        problem("range-not-a-class", path, `${slot.name} on ${owner} points at ${range}, which is no class of this model or of its imports`);
      } else {
        unverified.push([path, range]);
      }
      continue;
    }
    if (slot.on_delete !== undefined && !(ON_DELETE_RULES as readonly string[]).includes(slot.on_delete)) {
      problem("on-delete-unknown", path, `${slot.name} on ${owner} has on_delete '${slot.on_delete}'; it is one of ${ON_DELETE_RULES.join(", ")}`);
    }
    if (!path.startsWith("classes.") && (listedBy.get(slot.name) ?? []).length > 1) {
      problem(
        "slot-in-two-relationships",
        path,
        `${slot.name} is used by ${(listedBy.get(slot.name) ?? []).join(" and ")}, so it would be an end of two relationships; give each class a slot of its own`,
      );
      continue;
    }
    if (slot.inverse === undefined) {
      problem(
        "inverse-missing",
        path,
        `${slot.name} (${owner} → ${range}) names no inverse; add the slot on ${range} that points back`,
      );
      continue;
    }
    const other = endOn(range, slot.inverse);
    if (other === undefined) {
      const holder = all.classes.find((one) => one.name === range);
      problem(
        "inverse-missing",
        path,
        holder?.from !== undefined
          ? `${slot.name} names the inverse ${slot.inverse}, which ${range} from ${holder.from} does not have; declare the relationship in that model, or make ${slot.name} an external reference`
          : `${slot.name} names the inverse ${slot.inverse}, which ${range} does not have`,
      );
      continue;
    }
    if (other.slot.name === slot.name && other.owner === owner) {
      problem("inverse-not-reciprocal", path, `${slot.name} names itself as its inverse; the other end is a slot of its own`);
      continue;
    }
    if (other.slot.kind !== "Relationship" || other.slot.range !== owner || other.slot.inverse !== slot.name) {
      problem(
        "inverse-not-reciprocal",
        path,
        `${slot.name} (${owner} → ${range}) names ${range}.${slot.inverse} as its inverse, which ${
          other.slot.kind !== "Relationship"
            ? "is not a Relationship"
            : other.slot.range !== owner
              ? `points at ${other.slot.range ?? "nothing"}, not at ${owner}`
              : `names ${other.slot.inverse ?? "no inverse"} back, not ${slot.name}`
        }`,
      );
      continue;
    }
    const key = [`${owner}.${slot.name}`, `${range}.${other.slot.name}`].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const otherOrder = own.find((one) => one.owner === range && one.slot.name === other.slot.name)?.order ?? Number.MAX_SAFE_INTEGER;
    if (slot.on_delete !== undefined && other.slot.on_delete !== undefined) {
      problem(
        "on-delete-on-both-ends",
        path,
        `both ${slot.name} and ${other.slot.name} carry on_delete; it goes on the source end only`,
      );
      continue;
    }
    const thisIsSource =
      slot.on_delete !== undefined || (other.slot.on_delete === undefined && end.order <= otherOrder);
    const [source, target] = thisIsSource ? [end, other] : [other, end];
    const cardinality = cardinalityOf(source.slot.multivalued === true, target.slot.multivalued === true);
    const stored = storedEnd(cardinality);
    const computed = stored === "source" ? target : source;
    if (computed.slot.required) {
      problem(
        "required-on-computed-end",
        computed.path,
        `${computed.slot.name} on ${computed.owner} is computed from ${(stored === "source" ? source : target).slot.name} and cannot be required; make the stored end required instead`,
      );
    }
    const onDelete = (source.slot.on_delete ?? "restrict") as OnDelete;
    relationships.push({
      source: { class: source.owner, slot: source.slot.name, multivalued: source.slot.multivalued === true, required: source.slot.required === true },
      target: { class: target.owner, slot: target.slot.name, multivalued: target.slot.multivalued === true, required: target.slot.required === true },
      cardinality,
      onDelete: (ON_DELETE_RULES as readonly string[]).includes(onDelete) ? onDelete : "restrict",
      stored,
    });
  }
  return { relationships, problems, unverified };
}

/** The relationships whose two ends agree; a broken one is a diagnostic, not a relationship. */
export function relationships(model: LinkmlModel, imported: Record<string, LinkmlModel> = {}): Relationship[] {
  return relationshipsOf(model, imported).relationships;
}
