/**
 * Localization and strings in Finnish and English for data-quality-inspector.
 */

export type Lang = "fi" | "en";

const WORDS = {
  title: { fi: "Helsingin datan laatu", en: "Helsinki data quality" },
  page: { fi: "Helsingin datan laatu", en: "Helsinki data quality" },
  typesList: { fi: "Tietotyypit", en: "Entity types" },
  attributesTable: { fi: "Tyypin {type} ominaisuudet", en: "Attributes of {type}" },
  failingTable: { fi: "Virheelliset kohteet", en: "Failing entities" },
  loading: { fi: "Luetaan tietoja…", en: "Reading data…" },
  loadingProgress: { fi: "Luetaan {done} / {total} tyypistä…", en: "Reading {done} of {total} types…" },
  analysing: { fi: "Tarkastetaan…", en: "Inspecting…" },
  schemaUnreadable: {
    fi: "Julkaistua skeemaa ei voitu lukea; kelvollisuutta ei tarkisteta.",
    en: "The published schema could not be read; validity is not checked.",
  },
  typeReadError: { fi: "Tietoja ei voitu lukea.", en: "Data could not be read." },
  allTypesFailed: { fi: "Minkään tietotyypin kohteita ei voitu lukea.", en: "Could not read entities for any type." },
  noSchema: { fi: "ei julkaistua skeemaa", en: "no published schema" },
  noTimestamp: { fi: "ei aikaleimaa", en: "no timestamp" },
  entities: { fi: "Kohteet", en: "Entities" },
  completeness: { fi: "Kattavuus", en: "Completeness" },
  valid: { fi: "Kelvollinen", en: "Valid" },
  medianAge: { fi: "Mediaani-ikä", en: "Median age" },
  oldest: { fi: "Vanhin", en: "Oldest" },
  freshness: { fi: "Aikaleiman tuoreus", en: "Freshness" },
  freshnessField: { fi: "Tuoreuden ominaisuus", en: "Freshness attribute" },
  olderThan24hTitle: { fi: "Yli 24 h vanhat", en: "Older than 24 h" },
  olderThan24h: { fi: "{pct} yli 24 h vanhoja", en: "{pct} older than 24 h" },
  chartTitle: { fi: "Tietotyyppien kattavuus", en: "Completeness by type" },
  chartEmpty: { fi: "Ei kattavuustietoja kaavioon.", en: "No completeness data to chart." },
  overview: { fi: "Yleiskatsaus", en: "Overview" },
  allTypes: { fi: "Kaikki tyypit", en: "All types" },
  attribute: { fi: "Ominaisuus", en: "Attribute" },
  required: { fi: "Pakollinen", en: "Required" },
  notChecked: { fi: "Ei tarkistettu", en: "Not checked" },
  yes: { fi: "kyllä", en: "yes" },
  no: { fi: "ei", en: "no" },
  id: { fi: "Tunniste", en: "ID" },
  failedRule: { fi: "Hylkäyssyy", en: "Failed rule" },
  failingCapped: {
    fi: "Näytetään ensimmäiset {shown} / {total} virheellisestä kohteesta.",
    en: "Showing first {shown} of {total} failing entities.",
  },
  allValid: { fi: "Kaikki kohteet ovat kelvollisia.", en: "All entities pass validation." },
  noEntities: { fi: "Ei kohteita.", en: "No entities." },
  noSchemaDetails: {
    fi: "Ei julkaistua skeemaa; kelvollisuutta ei voitu tarkistaa.",
    en: "No published schema; validity could not be checked.",
  },
  inspectFailed: { fi: "Tarkastus epäonnistui: {reason}", en: "Inspection failed: {reason}" },

  // Rule wording
  rule_datetime: { fi: "ei kelvollinen aikaleima", en: "not a date-time" },
  rule_date: { fi: "ei kelvollinen päivämäärä", en: "not a date" },
  rule_uri: { fi: "ei kelvollinen URI", en: "not a URI" },
  rule_minimum: { fi: "alle minimin {detail}", en: "below the minimum {detail}" },
  rule_maximum: { fi: "yli maksimin {detail}", en: "above the maximum {detail}" },
  rule_enum: { fi: "ei mikään näistä: {detail}", en: "not one of: {detail}" },
  rule_required: { fi: "puuttuu, mutta pakollinen", en: "missing, but required" },
  rule_unknown: { fi: "ei mallissa", en: "not in the model" },
  rule_pattern: { fi: "ei vastaa säännöllistä lauseketta {detail}", en: "does not match pattern {detail}" },
  rule_type: { fi: "ei tyyppiä {detail}", en: "not of type {detail}" },
  rule_format_other: { fi: "ei kelvollinen {detail}", en: "not a valid {detail}" },
} as const;

export type Word = keyof typeof WORDS;

/** Formats a localized string with `{slot}` replacements. */
export function t(lang: Lang, word: Word, slots: Record<string, string | number> = {}): string {
  const text = WORDS[word]?.[lang] ?? String(word);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(slots[name] ?? `{${name}}`));
}

/** Determines active language from search parameters or navigator preferences. */
export function langOf(search: string, browser: readonly string[]): Lang {
  const asked = new URLSearchParams(search).get("lang");
  if (asked === "fi" || asked === "en") return asked;
  const first = browser.find((tag) => /^(fi|sv|en)\b/i.test(tag));
  return first !== undefined && /^(fi|sv)\b/i.test(first) ? "fi" : "en";
}

const locale = (lang: Lang) => (lang === "fi" ? "fi-FI" : "en-GB");

/** Formats whole or decimal numbers according to the active locale. */
export function number(lang: Lang, value: number, decimals = 0): string {
  return new Intl.NumberFormat(locale(lang), {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals > 0 && !Number.isInteger(value) ? 1 : 0,
  }).format(value);
}

/** Formats duration in seconds into human-readable age words. */
export function ageMessage(lang: Lang, seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0 min";
  if (seconds < 60) {
    return `${Math.round(seconds)} s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min`;
  }
  if (seconds < 86400) {
    return `${Math.round(seconds / 3600)} h`;
  }
  const days = Math.round(seconds / 86400);
  return lang === "fi" ? `${days} pv` : `${days} ${days === 1 ? "day" : "days"}`;
}

/** Words a validation rule failure in natural phrasing. */
export function ruleMessage(lang: Lang, rule: string, detail: string): string {
  if (rule === "format") {
    if (detail === "date-time") return t(lang, "rule_datetime");
    if (detail === "date") return t(lang, "rule_date");
    if (detail === "uri") return t(lang, "rule_uri");
    return t(lang, "rule_format_other", { detail });
  }
  if (rule === "minimum") return t(lang, "rule_minimum", { detail });
  if (rule === "maximum") return t(lang, "rule_maximum", { detail });
  if (rule === "enum") return t(lang, "rule_enum", { detail });
  if (rule === "required") return t(lang, "rule_required");
  if (rule === "unknown") return t(lang, "rule_unknown");
  if (rule === "pattern") return t(lang, "rule_pattern", { detail });
  if (rule === "type") return t(lang, "rule_type", { detail });
  return detail ? `${rule}: ${detail}` : rule;
}
