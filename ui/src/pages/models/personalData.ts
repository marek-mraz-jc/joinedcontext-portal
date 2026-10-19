import type { Diagnostic, LinkmlClass, LinkmlModel } from "./linkml";

/** GDPR Art. 6(1), as the model's `legalBasis` annotation writes it (Architecture/11 §9). */
export const LEGAL_BASES = [
  "consent",
  "contract",
  "legal-obligation",
  "vital-interest",
  "public-task",
  "legitimate-interest",
] as const;

/** What of a personal slot reaches the broker (DM-121): `keep` is the default and stays unwritten. */
export const INGESTS = ["keep", "drop", "keyedHash"] as const;

/** A class's personal-data annotations (DM-120), as written; absent ones stay absent. */
export interface ClassPersonal {
  personalData?: boolean;
  legalBasis?: string;
  /** Per language, like a title. */
  purpose?: Record<string, string>;
  /** An ISO 8601 duration, e.g. `P90D`. */
  maxRetention?: string;
  /** The slot that identifies the person. */
  dataSubjectRef?: string;
}

/** An ISO 8601 duration with at least one part: `P90D`, `P1Y6M`, `PT12H`. */
const DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

export function isDuration(value: string): boolean {
  return DURATION.test(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function languages(value: unknown): Record<string, string> | undefined {
  if (typeof value === "string" && value.length > 0) {
    return { en: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const map = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return Object.keys(map).length > 0 ? map : undefined;
}

/** The class annotations of DM-120; `undefined` when the class carries none of them. */
export function classPersonalOf(annotations: Record<string, unknown>): ClassPersonal | undefined {
  const personal: ClassPersonal = {
    ...(annotations.personalData === true ? { personalData: true } : {}),
    ...(text(annotations.legalBasis) ? { legalBasis: text(annotations.legalBasis) } : {}),
    ...(languages(annotations.purpose) ? { purpose: languages(annotations.purpose) } : {}),
    ...(text(annotations.maxRetention) ? { maxRetention: text(annotations.maxRetention) } : {}),
    ...(text(annotations.dataSubjectRef) ? { dataSubjectRef: text(annotations.dataSubjectRef) } : {}),
  };
  return Object.keys(personal).length > 0 ? personal : undefined;
}

/** Every slot name the class holds, listed or inline. */
function slotsOf(klass: LinkmlClass): string[] {
  return [...klass.slots, ...(klass.attributes ?? []).map((slot) => slot.name)];
}

/** Whether the class or one of its slots marks personal data. */
export function holdsPersonalData(model: LinkmlModel, klass: LinkmlClass): boolean {
  const names = new Set(slotsOf(klass));
  return (
    klass.personal?.personalData === true ||
    model.slots.some((slot) => names.has(slot.name) && slot.personalData === true) ||
    (klass.attributes ?? []).some((slot) => slot.personalData === true)
  );
}

/** What a class that holds personal data lacks or writes wrong (DM-120); each one blocks a save. */
function classProblems(model: LinkmlModel, klass: LinkmlClass): string[] {
  const personal = klass.personal ?? {};
  const problems: string[] = [];
  if (holdsPersonalData(model, klass)) {
    const missing = (["legalBasis", "purpose", "maxRetention"] as const).filter((key) => !personal[key]);
    if (missing.length > 0) {
      problems.push(`holds personal data and needs ${missing.join(", ")}`);
    }
  }
  if (personal.legalBasis && !(LEGAL_BASES as readonly string[]).includes(personal.legalBasis)) {
    problems.push(`legalBasis '${personal.legalBasis}' is not one of ${LEGAL_BASES.join(", ")}`);
  }
  if (personal.maxRetention && !isDuration(personal.maxRetention)) {
    problems.push(`maxRetention '${personal.maxRetention}' is not an ISO 8601 duration such as P90D`);
  }
  if (personal.dataSubjectRef && !slotsOf(klass).includes(personal.dataSubjectRef)) {
    problems.push(`dataSubjectRef '${personal.dataSubjectRef}' is not a slot of the class`);
  }
  return problems;
}

/**
 * The personal-data rules of a model (DM-120, DM-121): a class that holds personal data names its
 * legal basis, purpose and maximum retention, and every annotation holds a value the platform
 * reads. Errors, so the model does not save until they are fixed.
 */
export function personalDataProblems(
  model: LinkmlModel,
  at: (path: string[]) => Pick<Diagnostic, "line" | "column">,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const klass of model.classes) {
    for (const problem of classProblems(model, klass)) {
      found.push({
        ...at(["classes", klass.name, "annotations"]),
        severity: "error",
        message: `class '${klass.name}' ${problem} (DM-120)`,
        path: `classes.${klass.name}`,
      });
    }
  }
  for (const slot of model.slots) {
    if (slot.ingest && !(INGESTS as readonly string[]).includes(slot.ingest)) {
      found.push({
        ...at(["slots", slot.name, "annotations"]),
        severity: "error",
        message: `slot '${slot.name}' ingest '${slot.ingest}' is not one of ${INGESTS.join(", ")} (DM-121)`,
        path: `slots.${slot.name}`,
      });
    }
  }
  return found;
}
