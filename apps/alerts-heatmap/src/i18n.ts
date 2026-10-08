/**
 * The App's words in Finnish and English, and Helsinki's way of writing numbers, days and hours.
 * The language comes from the address (`?lang=fi`), else the reader's browser: Finnish for a
 * Finnish or Swedish browser, English otherwise. The alerts' own texts are Finnish only, as the
 * feed publishes them.
 */

export type Lang = "fi" | "en";
export const ZONE = "Europe/Helsinki";

const WORDS = {
  title: { fi: "Missä ja milloin häiriöitä on", en: "Where and when alerts happen" },
  page: { fi: "Häiriöt", en: "Alerts" },
  loading: { fi: "Luetaan tiedotteita…", en: "Reading the alerts…" },
  analysing: { fi: "Lasketaan…", en: "Working it out…" },
  unreadable: { fi: "Tiedotteita ei voitu lukea.", en: "The alerts could not be read." },
  unreadableStatus: { fi: "Tiedotteita ei voitu lukea (HTTP {status}). Yritä myöhemmin uudelleen.", en: "The alerts could not be read (HTTP {status}). Try again later." },
  analysisFailed: { fi: "Laskenta epäonnistui: {reason}", en: "The analysis failed: {reason}" },
  retry: { fi: "Yritä uudelleen", en: "Retry" },
  none: { fi: "Ei tiedotteita.", en: "No alerts." },
  noneMatch: { fi: "Mikään tiedote ei vastaa valintoja.", en: "No alert matches the filters." },
  summary: {
    fi: "{kept} tiedotetta {first}–{last}. Eniten kuusikulmiossa: {hot} tiedotetta. Vilkkain alkamistunti: {busiest}.",
    en: "{kept} alerts from {first} to {last}. Most in one hexagon: {hot}. Busiest starting hour: {busiest}.",
  },
  summaryNoTime: { fi: "{kept} tiedotetta. Eniten kuusikulmiossa: {hot} tiedotetta.", en: "{kept} alerts. Most in one hexagon: {hot}." },
  unlocated: { fi: "{n} tiedotteella ei ole sijaintia, eikä niitä näy kartalla.", en: "{n} alerts have no location and are not on the map." },
  filters: { fi: "Rajaa tiedotteita", en: "Filter the alerts" },
  from: { fi: "Alkaen", en: "From" },
  to: { fi: "Päättyen", en: "To" },
  kinds: { fi: "Tyyppi", en: "Kind" },
  clear: { fi: "Tyhjennä valinnat", en: "Clear filters" },
  open: { fi: "Tiedot: {name}", en: "Details of {name}" },
  map: { fi: "Kartta: tiedotteet kuusikulmioittain", en: "Map: alerts per hexagon" },
  mapLegend: { fi: "Värin tummuus: tiedotteiden määrä kuusikulmiossa. Ympyrä: toistuva paikka.", en: "Darker colour: more alerts in the hexagon. Circle: a place alerts keep coming back to." },
  onMap: { fi: "{n} kuusikulmiota kartalla", en: "{n} hexagons on the map" },
  week: { fi: "Viikon tunnit: milloin tiedotteet alkavat (Helsingin aikaa)", en: "Hours of the week: when the alerts start (Helsinki time)" },
  weekEmpty: { fi: "Valituilla tiedotteilla ei ole alkamisaikaa.", en: "The alerts chosen have no start time." },
  picked: { fi: "Vain {when}", en: "Only {when}" },
  unpick: { fi: "Näytä kaikki tunnit, ei vain {when}", en: "Show every hour, not only {when}" },
  places: { fi: "Toistuvat paikat", en: "Places alerts keep coming back to" },
  placesEmpty: { fi: "Mikään paikka ei toistu: ei vähintään kolmea tiedotetta 120 metrin säteellä.", en: "No place repeats: nowhere holds three alerts within 120 metres." },
  hexLine: { fi: "{count} tiedotetta tässä kuusikulmiossa", en: "{count} alerts in this hexagon" },
  placeLine: { fi: "{count} tiedotetta, {radius} m säteellä", en: "{count} alerts within {radius} m" },
} as const;

export type Word = keyof typeof WORDS;

const DAYS = {
  fi: ["maanantai", "tiistai", "keskiviikko", "torstai", "perjantai", "lauantai", "sunnuntai"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};
const SHORT_DAYS = { fi: ["ma", "ti", "ke", "to", "pe", "la", "su"], en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] };

const SUB_CATEGORIES: Record<string, Record<Lang, string>> = {
  ROAD_WORK: { fi: "Tietyö", en: "Road work" },
  TRAFFIC_ANNOUNCEMENT: { fi: "Liikennetiedote", en: "Traffic announcement" },
  WEIGHT_RESTRICTION: { fi: "Painorajoitus", en: "Weight restriction" },
  EXEMPTED_TRANSPORT: { fi: "Erikoiskuljetus", en: "Exempted transport" },
};

/** One phrase in a language, its `{name}` slots filled. */
export function t(lang: Lang, word: Word, slots: Record<string, string | number> = {}): string {
  return WORDS[word][lang].replace(/\{(\w+)\}/g, (_, name: string) => String(slots[name] ?? `{${name}}`));
}

/** The language of the page: `?lang=` when it names one, else the browser's. */
export function langOf(search: string, browser: readonly string[]): Lang {
  const asked = new URLSearchParams(search).get("lang");
  if (asked === "fi" || asked === "en") return asked;
  return browser.some((tag) => /^(fi|sv)\b/i.test(tag)) ? "fi" : "en";
}

const locale = (lang: Lang) => (lang === "fi" ? "fi-FI" : "en-GB");

/** A whole number in the language's way: 1 234 in Finnish, 1,234 in English. */
export function number(lang: Lang, value: number): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 0 }).format(value);
}

/** A day on Helsinki's calendar: 8.10.2026 in Finnish, 8 Oct 2026 in English. */
export function day(lang: Lang, ms: number): string {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: ZONE, day: "numeric", month: lang === "fi" ? "numeric" : "short", year: "numeric" }).format(ms);
}

/** One hour of the week: "maanantai klo 7–8" or "Monday 07:00–08:00". */
export function hourOfWeek(lang: Lang, weekday: number, hour: number): string {
  const name = DAYS[lang][weekday] ?? "";
  const next = (hour + 1) % 24;
  return lang === "fi" ? `${name} klo ${hour}–${next}` : `${name} ${String(hour).padStart(2, "0")}:00–${String(next).padStart(2, "0")}:00`;
}

export function shortDays(lang: Lang): string[] {
  return SHORT_DAYS[lang];
}

/** A sub-category in words, or the code itself for one the App does not know. */
export function subCategory(lang: Lang, code: string): string {
  return SUB_CATEGORIES[code]?.[lang] ?? (code || (lang === "fi" ? "Muu" : "Other"));
}
