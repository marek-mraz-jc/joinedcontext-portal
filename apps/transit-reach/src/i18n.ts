/**
 * The App's words in Finnish and English, and Helsinki's way of writing numbers and times. The
 * language comes from the address (`?lang=fi`), else the reader's browser: Finnish for a Finnish
 * or Swedish browser, English otherwise.
 */

export type Lang = "fi" | "en";
export const ZONE = "Europe/Helsinki";

const WORDS = {
  title: { fi: "Kuinka pitkälle pääsen joukkoliikenteellä", en: "How far can I get by transit" },
  page: { fi: "Saavutettavuus", en: "Reach" },
  loading: { fi: "Luetaan ajoneuvojen kulkua…", en: "Reading where the vehicles went…" },
  analysing: { fi: "Lasketaan…", en: "Working it out…" },
  historyUnreadable: {
    fi: "Ajoneuvojen historiaa ei voitu lukea (HTTP {status}): näkyvissä on vain kävelymatka.",
    en: "The vehicles' history could not be read (HTTP {status}): only walking is shown.",
  },
  analysisFailed: { fi: "Laskenta epäonnistui: {reason}", en: "The analysis failed: {reason}" },
  retry: { fi: "Yritä uudelleen", en: "Retry" },
  summary: {
    fi: "Saavutettava alue tästä pisteestä: {bands}. Pysäkkejä {limit} minuutissa: {reached}/{all}.",
    en: "Reachable from this point: {bands}. Stops within {limit} minutes: {reached} of {all}.",
  },
  bandPhrase: { fi: "{minutes} min {area} km²", en: "{minutes} min {area} km²" },
  walkOnly: { fi: "Ajoneuvoista ei ole historiaa: alue on pelkkä kävelymatka.", en: "No vehicle history: the area is walking distance only." },
  derived: {
    fi: "Pysäkit on päätelty paikoista, joissa {vehicles} ajoneuvoa seisoi {from}–{to}. Rajapinnassa ei ole pysäkki- eikä aikataulutietoja, joten myös liikennevalot voivat näkyä pysäkkeinä. Odotus {wait} min jokaisella nousulla, kävely 4,5 km/h.",
    en: "Stops are derived from where {vehicles} vehicles stood still from {from} to {to}. The endpoint carries no stops or timetables, so a traffic light can show as a stop. A {wait}-minute wait at each boarding, walking at 4.5 km/h.",
  },
  controls: { fi: "Lähtöpiste ja historia", en: "Starting point and history" },
  hours: { fi: "Ajoneuvojen historia", en: "Vehicle history" },
  hoursOption: { fi: "viimeiset {n} h", en: "last {n} h" },
  startStop: { fi: "Lähde pysäkiltä", en: "Start from a stop" },
  pickedPoint: { fi: "Kartalta valittu piste", en: "The point picked on the map" },
  stopOption: { fi: "Pysäkki {n}: linjat {routes}", en: "Stop {n}: routes {routes}" },
  noRoutes: { fi: "ei linjaa", en: "no route" },
  centre: { fi: "Takaisin Rautatientorille", en: "Back to Rautatientori" },
  map: { fi: "Kartta: saavutettava alue. Napsauta karttaa aloittaaksesi sieltä.", en: "Map: the area reached. Click the map to start from there." },
  bandLegend: { fi: "enintään {minutes} min", en: "up to {minutes} min" },
  legend: { fi: "Selite", en: "Legend" },
  start: { fi: "Lähtöpiste", en: "Starting point" },
  stopLegend: { fi: "Päätelty pysäkki", en: "Derived stop" },
  cellLine: { fi: "{minutes} min lähtöpisteestä", en: "{minutes} min from the start" },
  stopLine: { fi: "Linjat {routes}", en: "Routes {routes}" },
  stopReached: { fi: "{minutes} min lähtöpisteestä", en: "{minutes} min from the start" },
  stopFar: { fi: "Ei {limit} minuutissa", en: "Not within {limit} minutes" },
  reached: { fi: "Pysäkit {limit} minuutissa", en: "Stops within {limit} minutes" },
  reachedLine: { fi: "{minutes} min: linjat {routes}", en: "{minutes} min: routes {routes}" },
  startFrom: { fi: "{stop}: lähde tästä", en: "{stop}: start from here" },
  noReached: { fi: "Ei pysäkkejä {limit} minuutin sisällä.", en: "No stop within {limit} minutes." },
  language: { fi: "In English", en: "Suomeksi" },
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

/** A number with one decimal: 2,4 in Finnish, 2.4 in English. */
export function decimal(lang: Lang, value: number): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value);
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
