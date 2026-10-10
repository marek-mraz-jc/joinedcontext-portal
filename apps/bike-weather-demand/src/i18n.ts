/**
 * Localization and UI strings in Finnish and English for bike-weather-demand.
 */

export type Lang = "fi" | "en";
export const ZONE = "Europe/Helsinki";

const WORDS = {
  title: { fi: "Pyörät ja sää", en: "Bikes and the weather" },
  page: { fi: "Pyörät ja sää", en: "Bikes and the weather" },
  models: { fi: "Aseman mallin historia: palvelimen säilyttämät", en: "The station's model over time: kept by the server" },
  modelsNote: {
    fi: "Sovelluksen palvelin opettaa mallin kerran päivässä aseman seitsemältä edelliseltä päivältä ja säilyttää sen, joten mallin muutokset näkyvät.",
    en: "The App's server trains the model once a day on the station's seven days before and keeps it, so you see how the model changes.",
  },
  modelsReading: { fi: "Luetaan säilytettyjä malleja…", en: "Reading the kept models…" },
  modelsEmpty: { fi: "Palvelin ei ole vielä säilyttänyt tämän aseman mallia.", en: "The server has not kept a model of this station yet." },
  modelsFailed: { fi: "Malleja ei voitu lukea: {reason}", en: "The models could not be read: {reason}" },
  modelsStale: { fi: "Dataa ei voitu lukea juuri nyt: mallit ovat viimeksi säilytetyt.", en: "The data could not be read just now: these are the models as kept." },
  trainedOn: { fi: "Opetettu", en: "Trained on" },
  trainedHours: { fi: "Tunteja", en: "Hours" },
  perDegree: { fi: "Pyöriä / °C", en: "Bikes per °C" },
  rainEffect: { fi: "Sade", en: "Rain" },
  spread: { fi: "Hajonta (σ)", en: "Spread (σ)" },
  trainingData: { fi: "Opetusdata", en: "Training data" },
  trainingDataOf: { fi: "Lataa {day} opetusdata", en: "Download the training data of {day}" },
  trainingFailed: { fi: "Opetusdataa ei voitu ladata: {reason}", en: "The training data could not be downloaded: {reason}" },
  station: { fi: "Asema", en: "Station" },
  searchStation: { fi: "Etsi asemaa…", en: "Search station…" },
  bikesNow: { fi: "Pyöriä nyt", en: "Bikes now" },
  freeSlots: { fi: "Vapaita telineitä", en: "Free slots" },
  totalSlots: { fi: "Telineitä yhteensä", en: "Total slots" },
  mapTitle: { fi: "Asemat kartalla", en: "Stations on map" },
  mapNotice: {
    fi: "Ympyrän väri kertoo pyörien saatavuudesta asemalla. Valitse asema napsauttamalla.",
    en: "Circle colour reflects bike availability at each station. Click to select a station.",
  },
  chartTitle: { fi: "Saatavuushistoria ja 6 tunnin ennuste", en: "Availability history and 6-hour estimate" },
  chartEmpty: { fi: "Ei saatavuushistoriaa.", en: "No availability history." },
  profileTitle: { fi: "Saatavuus viikon tunneittain", en: "Availability by hour of the week" },
  profileTable: { fi: "Saatavuus viikon tunneittain", en: "Availability by hour of the week" },
  hour: { fi: "Tunti", en: "Hour" },
  day: { fi: "Viikonpäivä", en: "Day of week" },
  mon: { fi: "Ma", en: "Mon" },
  tue: { fi: "Ti", en: "Tue" },
  wed: { fi: "Ke", en: "Wed" },
  thu: { fi: "To", en: "Thu" },
  fri: { fi: "Pe", en: "Fri" },
  sat: { fi: "La", en: "Sat" },
  sun: { fi: "Su", en: "Sun" },
  weatherEffect: {
    fi: "1 °C lämpimämpi: {perDegree} pyörää; sade: {rain} pyörää; {hours} tunnista sään kanssa",
    en: "1 °C warmer: {perDegree} bikes; rain: {rain} bikes; from {hours} hours with weather",
  },
  weatherAssumption: {
    fi: "Sää pysyy samana kuin klo {time}: {temp} °C, {rainState}",
    en: "The weather stays as it was at {time}: {temp} °C, {rainState}",
  },
  noRain: { fi: "ei sadetta", en: "no rain" },
  rain: { fi: "sadetta", en: "rain" },
  tooLittleHistory: {
    fi: "Liian vähän historiaa (alle 24 tuntia): näytetään viikkoprofiili ilman sääennustetta.",
    en: "Too little history (fewer than 24 hourly points): showing profile only, no regression.",
  },
  noWeatherTerms: {
    fi: "Ei sääasemaa 10 km säteellä: säävaikutuksia ei arvioida.",
    en: "No weather station within 10 km: weather effects not evaluated.",
  },
  weatherUnreadable: {
    fi: "Säätietoja ei voitu lukea.",
    en: "Weather data could not be read.",
  },
  loading: { fi: "Luetaan tietoja…", en: "Reading data…" },
  analysing: { fi: "Lasketaan ennustetta…", en: "Calculating estimate…" },
  emptyStations: { fi: "Pyöräasemia ei löytynyt.", en: "No bike stations readable." },
  noHistory: { fi: "Asemalle ei ole historiatietoja.", en: "No history available for this station." },
  details: { fi: "Tiedot: {name}", en: "Details: {name}" },
  estimationFailed: { fi: "Ennusteen laskenta epäonnistui: {reason}", en: "Estimation failed: {reason}" },
  bikesHistorySeries: { fi: "Havaittu saatavuus", en: "Observed bikes" },
  estimateSeries: { fi: "Ennuste", en: "Estimate" },
  estimateBand: { fi: "Vaihteluväli (80 %)", en: "Uncertainty band (80%)" },
  nearestWeather: { fi: "Lähin sääasema: {name} ({dist} km)", en: "Nearest weather station: {name} ({dist} km)" },
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

/** Formats an ISO timestamp or Date to HH:mm in Europe/Helsinki time. */
export function formatHelsinkiTime(iso: string | Date, lang: Lang): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale(lang), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: ZONE,
  }).format(date);
}

export const DAYS: readonly Word[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
