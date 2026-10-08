/**
 * The App's words in Finnish and English, and Helsinki's way of writing numbers and times. The
 * language comes from the address (`?lang=fi`), else the reader's browser: Finnish for a Finnish
 * or Swedish browser, English otherwise. The indicators' names are English only, as the city's
 * pipelines write them.
 */

export type Lang = "fi" | "en";
export const ZONE = "Europe/Helsinki";

const WORDS = {
  title: { fi: "Helsingin mittarit: trendi ja ennuste", en: "Helsinki KPIs: trend and forecast" },
  page: { fi: "Mittarit", en: "Indicators" },
  loading: { fi: "Luetaan mittareita…", en: "Reading the indicators…" },
  analysing: { fi: "Lasketaan…", en: "Working it out…" },
  unreadable: { fi: "Mittareita ei voitu lukea.", en: "The indicators could not be read." },
  unreadableStatus: { fi: "Mittareita ei voitu lukea (HTTP {status}). Yritä myöhemmin uudelleen.", en: "The indicators could not be read (HTTP {status}). Try again later." },
  historyUnreadable: {
    fi: "Mittareiden historiaa ei voitu lukea (HTTP {status}): näkyvissä ovat vain nykyiset arvot.",
    en: "The indicators' history could not be read (HTTP {status}): only the current values are shown.",
  },
  analysisFailed: { fi: "Laskenta epäonnistui: {reason}", en: "The analysis failed: {reason}" },
  retry: { fi: "Yritä uudelleen", en: "Retry" },
  none: { fi: "Ei mittareita.", en: "No indicators." },
  summary: {
    fi: "{total} mittaria, viimeiset {days} päivää: {rising} nousee, {falling} laskee, {flat} pysyy ennallaan. Poikkeavia pisteitä: {anomalies}.",
    en: "{total} indicators over the last {days} days: {rising} rising, {falling} falling, {flat} flat. Points that look wrong: {anomalies}.",
  },
  summaryShort: { fi: "{short} mittarilla on liian vähän historiaa ennusteeseen.", en: "{short} of them have too little history to forecast." },
  filters: { fi: "Rajaa mittareita", en: "Filter the indicators" },
  period: { fi: "Ajanjakso", en: "Period" },
  days: { fi: "{n} päivää", en: "{n} days" },
  clear: { fi: "Tyhjennä valinnat", en: "Clear filters" },
  odd: { fi: "Vain mittarit, joissa on poikkeamia", en: "Only indicators with points that look wrong" },
  details: { fi: "Kaikki tiedot", en: "All details" },
  list: { fi: "Mittarit", en: "Indicators" },
  up: { fi: "nousee", en: "rising" },
  down: { fi: "laskee", en: "falling" },
  flat: { fi: "ennallaan", en: "flat" },
  perWeek: { fi: "{change} viikossa", en: "{change} a week" },
  now: { fi: "Nyt {value}", en: "Now {value}" },
  noHistory: { fi: "Ei historiaa viimeisiltä {days} päivältä.", en: "No history in the last {days} days." },
  shortHistory: { fi: "{n} pistettä: liian vähän ennusteeseen.", en: "{n} points: too few to forecast." },
  oddCount: { fi: "{n} poikkeavaa", en: "{n} look wrong" },
  nothingOdd: { fi: "Yhdessäkään mittarissa ei ole poikkeavia pisteitä.", en: "No indicator has a point that looks wrong." },
  chart: { fi: "{name}: historia ja ennuste", en: "{name}: history and forecast" },
  chartEmpty: { fi: "Tällä mittarilla ei ole historiaa valitulta ajalta.", en: "This indicator has no history in the period chosen." },
  measured: { fi: "Mitattu", en: "Measured" },
  model: { fi: "Malli", en: "Model" },
  forecast: { fi: "Ennuste", en: "Forecast" },
  band: { fi: "95 %:n väli", en: "95 % interval" },
  anomaly: { fi: "Poikkeava", en: "Looks wrong" },
  formula: { fi: "Kaava", en: "Formula" },
  source: { fi: "Lähde", en: "Source" },
  forecastLine: { fi: "Ennuste {when}: {value} ({lo}–{hi}).", en: "Forecast for {when}: {value} ({lo} to {hi})." },
  modelLine: {
    fi: "Holt-Winters (additiivinen), {n} pistettä, askel {step}, kausi {season}.",
    en: "Holt-Winters (additive), {n} points, a step of {step}, season {season}.",
  },
  noSeason: { fi: "ei kautta", en: "none" },
  seasonSteps: { fi: "{n} askelta", en: "{n} steps" },
  anomalies: { fi: "Poikkeavat pisteet", en: "Points that look wrong" },
  anomalyLine: { fi: "{when}: {value}, odotettu {expected}", en: "{when}: {value}, expected {expected}" },
  noAnomalies: { fi: "Ei poikkeavia pisteitä.", en: "No point looks wrong." },
  minutes: { fi: "{n} min", en: "{n} min" },
  hours: { fi: "{n} h", en: "{n} h" },
  daysShort: { fi: "{n} vrk", en: "{n} d" },
} as const;

export type Word = keyof typeof WORDS;

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

/** A measured value: whole above 100, two decimals above 1, three below. */
export function value(lang: Lang, v: number): string {
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 3;
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: digits }).format(v);
}

/** A change as a signed share: +3,5 % in Finnish, +3.5% in English. */
export function percent(lang: Lang, share: number): string {
  return new Intl.NumberFormat(locale(lang), { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(share);
}

/** A day on Helsinki's calendar, short, for a time axis: 3.10. in Finnish, 3 Oct in English. */
export function dayShort(lang: Lang, ms: number): string {
  return new Intl.DateTimeFormat(locale(lang), { timeZone: ZONE, day: "numeric", month: lang === "fi" ? "numeric" : "short" }).format(ms);
}

/** A moment on Helsinki's clock: 8.10.2026 klo 10.00 in Finnish, 8 Oct 2026, 10:00 in English. */
export function moment(lang: Lang, ms: number): string {
  return new Intl.DateTimeFormat(locale(lang), {
    timeZone: ZONE,
    day: "numeric",
    month: lang === "fi" ? "numeric" : "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

/** A step of the model's clock, in the largest whole unit that reads well. */
export function duration(lang: Lang, ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 120) return t(lang, "minutes", { n: number(lang, minutes) });
  if (minutes < 48 * 60) return t(lang, "hours", { n: number(lang, minutes / 60) });
  return t(lang, "daysShort", { n: number(lang, minutes / 1440) });
}
