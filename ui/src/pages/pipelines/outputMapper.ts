/**
 * The output node's mapper (T-3224): a record's fields mapped onto the attributes an entity type
 * has in the target space's data model (API/01 §36), and the Bloblang compute step that builds
 * the normalized NGSI-LD entity from them. The generated step is what the runner executes and the
 * pipeline test checks (PL-43, PL-59); the map rides in its first line, so the editor can show it
 * again, and only while the step is still exactly what that map generates: a step edited by hand
 * is the author's and the mapper leaves it alone.
 */
import type { components } from "../../api/schema";

export type Attribute = components["schemas"]["Attribute"];

/** Where one attribute's value comes from. */
export type Source =
  | { field: string }
  | { expression: string }
  | { value: string | number | boolean }
  | { longitude: string; latitude: string };

export interface MapperState {
  type: string;
  /** The field the entity's local id comes from. */
  idField?: string;
  attributes: Record<string, Source>;
}

/** The first line of a generated step: the map, so the editor can read it back. */
export const HEADER = "# jc-mapper ";

/** A record field as a Bloblang path: a plain name as it is, any other one quoted. */
export function fieldPath(field: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? `this.${field}` : `this.${JSON.stringify(field)}`;
}

/** The member of an NGSI-LD attribute that carries its value, by kind. */
const MEMBER: Record<string, string> = {
  Property: "value",
  Relationship: "object",
  GeoProperty: "value",
  LanguageProperty: "languageMap",
  VocabProperty: "vocab",
};

/** A source as one Bloblang expression, coerced to the slot's type: a CSV field is text. */
function valueOf(source: Source, attribute: Attribute): string {
  // A missing or empty field is `null`, so the attribute is left out; a present value the type
  // cannot read is an error, and the record is refused with it rather than written wrong.
  const present = (path: string) => `${path} != null && ${path} != ""`;
  if ("field" in source) {
    const path = fieldPath(source.field);
    if (attribute.kind !== "Property" || attribute.values) return path;
    const coerced: Record<string, string> = {
      number: `${path}.number()`,
      integer: `${path}.number().round().int64()`,
      boolean: `${path}.bool()`,
      string: `${path}.string()`,
    };
    const read = attribute.valueType ? coerced[attribute.valueType] : undefined;
    return read ? `if ${present(path)} { ${read} } else { null }` : path;
  }
  if ("expression" in source) return `(${source.expression})`;
  if ("value" in source) return JSON.stringify(source.value);
  const longitude = fieldPath(source.longitude);
  const latitude = fieldPath(source.latitude);
  return `if ${present(longitude)} && ${present(latitude)} { { "type": "Point", "coordinates": [ ${longitude}.number(), ${latitude}.number() ] } } else { null }`;
}

/**
 * The compute step for `state` over `attributes`, writing into `space`. An attribute the map
 * names but the model does not has no kind to be written as and is left out, as is one mapped to
 * nothing; a value that is missing on a record leaves the attribute out of that entity, since
 * NGSI-LD has no null attribute.
 */
export function generate(state: MapperState, attributes: Attribute[], space: string): string {
  const lines = [
    `${HEADER}${JSON.stringify(state)}`,
    `let domain = env("JC_ORG_DOMAIN")`,
    "root = {}",
  ];
  if (state.idField) {
    lines.push(
      `root.id = "urn:ngsi-ld:%v:%v:%v:%v".format(${JSON.stringify(state.type)}, $domain, ${JSON.stringify(space)}, ${fieldPath(state.idField)}.string().re_replace_all("[^A-Za-z0-9._~-]", "-"))`,
    );
  }
  lines.push(`root.type = ${JSON.stringify(state.type)}`);
  attributes.forEach((attribute, index) => {
    const source = state.attributes[attribute.name];
    if (!source) return;
    const member = MEMBER[attribute.kind] ?? "value";
    const unit = attribute.kind === "Property" && attribute.unit?.code ? `, "unitCode": ${JSON.stringify(attribute.unit.code)}` : "";
    const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(attribute.name) ? attribute.name : JSON.stringify(attribute.name);
    lines.push(`let a${index} = ${valueOf(source, attribute)}`);
    lines.push(
      `root.${name} = if $a${index} != null { { "type": ${JSON.stringify(attribute.kind)}, ${JSON.stringify(member)}: $a${index}${unit} } } else { deleted() }`,
    );
  });
  return `${lines.join("\n")}\n`;
}

/**
 * The map a step was generated from, when it was and still is exactly that: `undefined` for a
 * step written or edited by hand, which the editor then shows as code.
 */
export function readBack(bloblang: string | undefined, attributes: Attribute[], space: string): MapperState | undefined {
  if (!bloblang?.startsWith(HEADER)) return undefined;
  const first = bloblang.slice(HEADER.length).split("\n", 1)[0];
  let state: MapperState;
  try {
    state = JSON.parse(first) as MapperState;
  } catch {
    return undefined;
  }
  if (typeof state?.type !== "string" || typeof state.attributes !== "object" || state.attributes === null) return undefined;
  return generate(state, attributes, space) === bloblang ? state : undefined;
}

const folded = (name: string) => name.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();

/** Each attribute matched to the field of the same name, case, accents and separators aside. */
export function autoMatch(attributes: Attribute[], fields: string[], already: Record<string, Source> = {}): Record<string, Source> {
  const matched: Record<string, Source> = { ...already };
  for (const attribute of attributes) {
    if (matched[attribute.name]) continue;
    const field = fields.find((candidate) => folded(candidate) === folded(attribute.name));
    if (field !== undefined) matched[attribute.name] = { field };
  }
  return matched;
}

/** The field an id most likely comes from: `id`, then anything ending in `id`, else none. */
export function idFieldOf(fields: string[]): string | undefined {
  return fields.find((f) => folded(f) === "id") ?? fields.find((f) => folded(f).endsWith("id"));
}

export type MapperProblem =
  | { attribute: string; kind: "required" }
  | { attribute: string; kind: "notInSample"; field: string }
  | { attribute: string; kind: "notNumber"; field: string; value: string }
  | { attribute: string; kind: "notBoolean"; field: string; value: string }
  | { attribute: string; kind: "notValue"; field: string; value: string; values: string[] }
  | { attribute: ""; kind: "noId" };

const isNumber = (value: unknown) =>
  typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));

/**
 * What would stop the entities from being written, in the sample's terms (T-3224): a required
 * attribute mapped to nothing, a field the sample does not have, a value the slot's type cannot
 * read. Each names its attribute, so the form shows it there before anything is saved.
 */
export function problemsOf(state: MapperState, attributes: Attribute[], records: Record<string, unknown>[]): MapperProblem[] {
  const problems: MapperProblem[] = [];
  if (!state.idField) problems.push({ attribute: "", kind: "noId" });
  const fields = new Set(records.flatMap((record) => Object.keys(record)));
  for (const attribute of attributes) {
    const source = state.attributes[attribute.name];
    if (!source) {
      if (attribute.required) problems.push({ attribute: attribute.name, kind: "required" });
      continue;
    }
    if (!("field" in source)) continue;
    if (records.length > 0 && !fields.has(source.field)) {
      problems.push({ attribute: attribute.name, kind: "notInSample", field: source.field });
      continue;
    }
    const value = records.map((record) => record[source.field]).find((v) => v !== undefined && v !== null && v !== "");
    if (value === undefined || attribute.kind !== "Property") continue;
    const shown = typeof value === "string" ? value : JSON.stringify(value);
    if (attribute.values && !attribute.values.includes(String(value))) {
      problems.push({ attribute: attribute.name, kind: "notValue", field: source.field, value: shown, values: attribute.values });
    } else if ((attribute.valueType === "number" || attribute.valueType === "integer") && !isNumber(value)) {
      problems.push({ attribute: attribute.name, kind: "notNumber", field: source.field, value: shown });
    } else if (attribute.valueType === "boolean" && !["true", "false", true, false].includes(value as string | boolean)) {
      problems.push({ attribute: attribute.name, kind: "notBoolean", field: source.field, value: shown });
    }
  }
  return problems;
}

/**
 * Up to three of the entities the step would write from the sample, as NGSI-LD, computed the way
 * the generated step computes them. An expression is the runner's to evaluate, so it shows as
 * such; the pipeline test runs the real step.
 */
export function preview(
  state: MapperState,
  attributes: Attribute[],
  records: Record<string, unknown>[],
  space: string,
  orgDomain: string,
): Record<string, unknown>[] {
  return records.slice(0, 3).map((record) => {
    const entity: Record<string, unknown> = {};
    if (state.idField) {
      const local = String(record[state.idField] ?? "").replace(/[^A-Za-z0-9._~-]/g, "-");
      entity.id = `urn:ngsi-ld:${state.type}:${orgDomain}:${space}:${local}`;
    }
    entity.type = state.type;
    for (const attribute of attributes) {
      const source = state.attributes[attribute.name];
      if (!source) continue;
      let value: unknown;
      if ("field" in source) {
        value = record[source.field];
        if (value !== undefined && value !== null && attribute.kind === "Property" && !attribute.values) {
          if (attribute.valueType === "number" && isNumber(value)) value = Number(value);
          if (attribute.valueType === "integer" && isNumber(value)) value = Math.round(Number(value));
          if (attribute.valueType === "boolean") value = value === true || value === "true";
          if (attribute.valueType === "string") value = String(value);
        }
      } else if ("value" in source) {
        value = source.value;
      } else if ("longitude" in source) {
        value = { type: "Point", coordinates: [Number(record[source.longitude]), Number(record[source.latitude])] };
      } else {
        value = `(${source.expression})`;
      }
      if (value === undefined || value === null || value === "") continue;
      const member = MEMBER[attribute.kind] ?? "value";
      entity[attribute.name] = {
        type: attribute.kind,
        [member]: value,
        ...(attribute.kind === "Property" && attribute.unit?.code && typeof value === "number" ? { unitCode: attribute.unit.code } : {}),
      };
    }
    return entity;
  });
}
