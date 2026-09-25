/**
 * The publish flow's form (EP-83): the drafted `spec.catalog` as fields a person edits, and back.
 * Pure, so every rule of the form is tested without a dialog.
 */
export const LICENCES = ["CC_BY_4_0", "CC0", "CC_BYSA_4_0", "ODC_BY", "ODC_ODBL", "ODC_PDDL"] as const;
export const THEMES = [
  "AGRI",
  "ECON",
  "EDUC",
  "ENER",
  "ENVI",
  "GOVE",
  "HEAL",
  "INTR",
  "JUST",
  "REGI",
  "SOCI",
  "TECH",
  "TRAN",
] as const;
export const FREQUENCIES = [
  "CONT",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
  "ANNUAL",
  "IRREG",
  "NEVER",
  "UNKNOWN",
] as const;

export type CatalogBlock = Record<string, unknown>;

export interface PublishForm {
  /** The language the texts below are in: the draft's keyword language, else the reader's. */
  language: string;
  publisher: string;
  contactName: string;
  contactEmail: string;
  license: string;
  themes: string[];
  /** Comma-separated, as a person types them. */
  keywords: string;
  spatial: string;
  temporalStart: string;
  temporalEnd: string;
  frequency: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(text: string): string[] {
  return [...new Set(text.split(",").map((item) => item.trim()).filter((item) => item !== ""))];
}

/** The draft's catalogue block as the form's fields. */
export function formOf(catalog: CatalogBlock, fallbackLanguage: string): PublishForm {
  const keywords = record(catalog.keywords);
  const publisher = record(record(catalog.publisher).name);
  const language = Object.keys(keywords)[0] ?? Object.keys(publisher)[0] ?? fallbackLanguage;
  const contact = record(catalog.contactPoint);
  const temporal = record(catalog.temporal);
  const words = keywords[language];
  return {
    language,
    publisher: str(publisher[language]) || str(Object.values(publisher)[0]),
    contactName: str(contact.name),
    contactEmail: str(contact.email),
    license: str(catalog.license),
    themes: Array.isArray(catalog.themes) ? catalog.themes.filter((t): t is string => typeof t === "string") : [],
    keywords: Array.isArray(words) ? words.filter((w): w is string => typeof w === "string").join(", ") : "",
    spatial: Array.isArray(catalog.spatial)
      ? catalog.spatial.filter((s): s is string => typeof s === "string").join(", ")
      : "",
    temporalStart: str(temporal.start),
    temporalEnd: str(temporal.end),
    frequency: str(catalog.frequency),
  };
}

/** What is wrong with the form, as locale keys per field; empty when it can be proposed. */
export function problems(form: PublishForm): Partial<Record<keyof PublishForm, string>> {
  const out: Partial<Record<keyof PublishForm, string>> = {};
  if (!form.license) out.license = "catalogue.publish.error.licence";
  const hasName = form.contactName.trim() !== "";
  const hasEmail = form.contactEmail.trim() !== "";
  if (hasName && !hasEmail) out.contactEmail = "catalogue.publish.error.contactBoth";
  if (hasEmail && !hasName) out.contactName = "catalogue.publish.error.contactBoth";
  if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail.trim())) {
    out.contactEmail = "catalogue.publish.error.email";
  }
  if (form.temporalStart && form.temporalEnd && form.temporalEnd < form.temporalStart) {
    out.temporalEnd = "catalogue.publish.error.period";
  }
  return out;
}

/**
 * The catalogue block the Change writes: the draft with the form's fields over it, so a member
 * the form does not show (attribution, sources, legislation) is carried as the draft had it.
 */
export function catalogOf(draft: CatalogBlock, form: PublishForm): CatalogBlock {
  const out: CatalogBlock = { ...draft };
  const set = (key: string, value: unknown, empty: boolean) => {
    if (empty) {
      delete out[key];
    } else {
      out[key] = value;
    }
  };
  // A text per language: the form edits one language and leaves the others as they were.
  const inLanguage = (map: unknown, value: unknown, empty: boolean) => {
    const next = { ...record(map) };
    if (empty) {
      delete next[form.language];
    } else {
      next[form.language] = value;
    }
    return next;
  };
  const publisher = record(draft.publisher);
  const names = inLanguage(publisher.name, form.publisher.trim(), form.publisher.trim() === "");
  set("publisher", { ...publisher, name: names }, Object.keys(names).length === 0);
  set(
    "contactPoint",
    { name: form.contactName.trim(), email: form.contactEmail.trim() },
    form.contactName.trim() === "" || form.contactEmail.trim() === "",
  );
  set("license", form.license, form.license === "");
  set("themes", form.themes, form.themes.length === 0);
  const keywords = list(form.keywords);
  const words = inLanguage(draft.keywords, keywords, keywords.length === 0);
  set("keywords", words, Object.keys(words).length === 0);
  const spatial = list(form.spatial);
  set("spatial", spatial, spatial.length === 0);
  set(
    "temporal",
    {
      ...(form.temporalStart ? { start: form.temporalStart } : {}),
      ...(form.temporalEnd ? { end: form.temporalEnd } : {}),
    },
    !form.temporalStart && !form.temporalEnd,
  );
  set("frequency", form.frequency, form.frequency === "");
  return out;
}
