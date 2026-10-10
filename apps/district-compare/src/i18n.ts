/**
 * Localization and UI strings in Finnish and English for district-compare.
 */
import type { Measure } from "./districts";

export type Lang = "fi" | "en";
export const ZONE = "Europe/Helsinki";

const WORDS = {
  title: { fi: "Vertaa kaupunginosia", en: "Compare districts" },
  page: { fi: "Vertaa kaupunginosia", en: "Compare districts" },
  measure: { fi: "Mittari", en: "Measure" },
  districtsRanked: { fi: "Kaupunginosat järjestyksessä", en: "Districts ranked" },
  selectedDistrictsCompared: { fi: "Valitut kaupunginosat rinnakkain", en: "Selected districts compared" },
  measure_events: { fi: "Tapahtumat", en: "Events" },
  measure_bikes: { fi: "Kaupunkipyöräasemat", en: "City-bike stations" },
  measure_bikeSlots: { fi: "Pyörätelinepaikat", en: "Bike slots" },
  measure_alerts: { fi: "Liikennetiedotteet", en: "Traffic alerts" },
  measure_pm25: { fi: "Pienhiukkaset (PM2.5)", en: "Fine particles (PM2.5)" },
  measure_aqi: { fi: "Ilmanlaatuindeksi", en: "Air quality index" },
  area: { fi: "Pinta-ala", en: "Area" },
  km2: { fi: "km²", en: "km²" },
  perKm2: { fi: "/ km²", en: "/ km²" },
  ugm3: { fi: "µg/m³", en: "µg/m³" },
  noStation: { fi: "ei mittausasemaa", en: "no station" },
  unlocatedEvents: { fi: "{n} tapahtumaa ilman sijaintitietoa.", en: "{n} events without a place." },
  unlocatedEvent: { fi: "1 tapahtuma ilman sijaintitietoa.", en: "1 event without a place." },
  emptyDistricts: { fi: "Kaupunginosien rajoja ei voitu lukea.", en: "No district boundaries readable." },
  loading: { fi: "Luetaan tietoja…", en: "Reading data…" },
  analysing: { fi: "Lasketaan vertailua…", en: "Calculating comparison…" },
  unreadable: { fi: "Tietoja ei voitu lukea.", en: "Data could not be read." },
  unreadableStatus: {
    fi: "Tietoja ei voitu lukea (HTTP {status}). Yritä myöhemmin uudelleen.",
    en: "Data could not be read (HTTP {status}). Try again later.",
  },
  partialFailed: { fi: "Tietotyyppejä ei voitu lukea: {types}", en: "Some data could not be read: {types}" },
  analysisFailed: { fi: "Vertailu epäonnistui: {reason}", en: "Comparison failed: {reason}" },
  clear: { fi: "Tyhjennä valinnat", en: "Clear selection" },
  map: { fi: "Kartta: kaupunginosat", en: "Map: districts" },
  mapLegend: {
    fi: "Väri sinisestä, mittarin pienin arvo, oranssiin, suurin; vaalea: ei arvoa. Paksu reuna: valittu kaupunginosa.",
    en: "Colour from blue, the lowest value of the measure, to orange, the highest; pale: no value. Thick border: a selected district.",
  },
  chartTitle: { fi: "Valitut kaupunginosat: {measure}", en: "Selected districts: {measure}" },
  history: { fi: "Valittujen kaupunginosien historia: {measure}", en: "History of the selected districts: {measure}" },
  historyNote: {
    fi: "Sovelluksen palvelin laskee joka päivä kunkin kaupunginosan luvut ja säilyttää ne, joten kaupunginosalla on historia.",
    en: "The App's server computes every district's figures each day and keeps them, so a district has a history.",
  },
  historyPick: { fi: "Valitse kaupunginosia nähdäksesi niiden historian.", en: "Select districts to see their history." },
  historyReading: { fi: "Luetaan säilytettyjä päiviä…", en: "Reading the kept days…" },
  historyEmpty: { fi: "Palvelin ei ole vielä säilyttänyt yhtään päivää näille kaupunginosille.", en: "The server has not kept any day of these districts yet." },
  historyFailed: { fi: "Historiaa ei voitu lukea: {reason}", en: "The history could not be read: {reason}" },
  historyStale: { fi: "Syötteitä ei voitu lukea juuri nyt: päivät ovat viimeksi säilytetyt.", en: "The feeds could not be read just now: these are the days as last kept." },
  day: { fi: "Päivä", en: "Day" },
  boundaries: { fi: "Rajat (GeoJSON)", en: "Boundaries (GeoJSON)" },
  boundariesOf: { fi: "Lataa kaupunginosien rajat GeoJSON-tiedostona", en: "Download the district boundaries as GeoJSON" },
  licence: { fi: "Lisenssi", en: "Licence" },
  licenceOf: { fi: "Lataa rajojen lisenssi", en: "Download the licence of the boundaries" },
  filesFailed: { fi: "Tiedostoa ei voitu ladata: {reason}", en: "The file could not be downloaded: {reason}" },
  chartEmpty: { fi: "Ei valittuja kaupunginosia.", en: "No districts selected." },
  noneSelected: { fi: "Valitse vähintään yksi kaupunginosa vertailuun.", en: "Select at least one district to compare." },
  details: { fi: "Tiedot: {name}", en: "Details: {name}" },
  deselectDistrict: { fi: "Poista valinta: {name}", en: "Deselect {name}" },
  selectDistrict: { fi: "Valitse {name}", en: "Select {name}" },
  type_CityDistrict: { fi: "Kaupunginosat", en: "City districts" },
  type_Event: { fi: "Tapahtumat", en: "Events" },
  type_BikeHireDockingStation: { fi: "Kaupunkipyöräasemat", en: "Bike stations" },
  type_Alert: { fi: "Liikennetiedotteet", en: "Alerts" },
  type_AirQualityObserved: { fi: "Ilmanlaatu", en: "Air quality" },
} as const;

export type Word = keyof typeof WORDS;

/** Formats a translated string with `{slot}` replacement. */
export function t(lang: Lang, word: Word, slots: Record<string, string | number> = {}): string {
  const text = WORDS[word]?.[lang] ?? String(word);
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(slots[name] ?? `{${name}}`));
}

/** Determines active language from search parameters or navigator preferences. */
export function langOf(search: string, browser: readonly string[]): Lang {
  const asked = new URLSearchParams(search).get("lang");
  if (asked === "fi" || asked === "en") return asked;
  // The first of the person's languages the app speaks decides; Swedish readers get Finnish, the
  // district names being Finnish and Swedish and the interface having no Swedish.
  const first = browser.find((tag) => /^(fi|sv|en)\b/i.test(tag));
  return first !== undefined && /^(fi|sv)\b/i.test(first) ? "fi" : "en";
}

const locale = (lang: Lang) => (lang === "fi" ? "fi-FI" : "en-GB");

/** Formats numbers with localized thousands and decimal separators. */
export function number(lang: Lang, value: number, decimals = 1): string {
  return new Intl.NumberFormat(locale(lang), {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals > 0 && !Number.isInteger(value) ? 1 : 0,
  }).format(value);
}

/** Translated name for a measure. */
export function measureTitle(lang: Lang, measure: Measure): string {
  const key = `measure_${measure}` as Word;
  return t(lang, key);
}

/** Unit suffix for a measure. */
export function measureUnit(lang: Lang, measure: Measure): string {
  if (measure === "pm25") return t(lang, "ugm3");
  return "";
}

/** Localized entity type name for loading and error notices. */
export function translateType(type: string, lang: Lang): string {
  const key = `type_${type}` as Word;
  return WORDS[key] ? t(lang, key) : type;
}
