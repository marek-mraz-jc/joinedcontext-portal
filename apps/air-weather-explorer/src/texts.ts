import type { Lang } from "./i18n";

/** The page's words, Finnish and English. */
const TEXTS = {
  title: { fi: "Ilmanlaatu ja sää", en: "Air quality and weather" },
  page: { fi: "Vertailu", en: "Compare" },
  language: { fi: "Kieli", en: "Language" },
  station: { fi: "Ilmanlaatuasema", en: "Air quality station" },
  weatherStation: { fi: "Sääasema", en: "Weather station" },
  nearest: { fi: "{name} ({km} km)", en: "{name} ({km} km)" },
  period: { fi: "Ajanjakso", en: "Period" },
  days: { fi: "{n} vrk", en: "{n} days" },
  day1: { fi: "1 vrk", en: "1 day" },
  window: { fi: "Liukuva keskiarvo", en: "Rolling mean" },
  hours: { fi: "{n} h", en: "{n} h" },
  pollutant: { fi: "Saaste", en: "Pollutant" },
  variable: { fi: "Säämuuttuja", en: "Weather variable" },
  answer: { fi: "Vastaus", en: "The answer" },
  rises: { fi: "{air} nousee, kun {weather} nousee", en: "{air} rises as {weather} rises" },
  falls: { fi: "{air} laskee, kun {weather} nousee", en: "{air} falls as {weather} rises" },
  none: { fi: "{air} ei juuri seuraa muuttujaa {weather}", en: "{air} hardly moves with {weather}" },
  strong: { fi: "voimakkaasti", en: "strongly" },
  moderate: { fi: "kohtalaisesti", en: "moderately" },
  weak: { fi: "heikosti", en: "weakly" },
  evidence: { fi: "Spearman {rho}, Pearson {r}, {n} yhteistä tuntia.", en: "Spearman {rho}, Pearson {r}, over {n} common hours." },
  notEnough: { fi: "Yhteisiä tunteja on liian vähän sanomaan mitään. Valitse pidempi jakso tai toinen asema.", en: "Too few common hours to say anything. Pick a longer period or another station." },
  matrix: { fi: "Korrelaatiot (Spearman)", en: "Correlations (Spearman)" },
  table: { fi: "Kaikki parit", en: "Every pair" },
  pair: { fi: "Pari", en: "Pair" },
  series: { fi: "{air} ja {weather} tunneittain", en: "{air} and {weather} by the hour" },
  outlier: { fi: "Poikkeava lukema", en: "Outlying reading" },
  outliers: { fi: "{n} poikkeavaa lukemaa ({air})", en: "{n} outlying readings ({air})" },
  map: { fi: "Asemat", en: "Stations" },
  mapLabel: { fi: "Ilmanlaatu- ja sääasemat; valittu korostettuna", en: "Air quality and weather stations, the chosen ones highlighted" },
  airKind: { fi: "ilmanlaatu", en: "air quality" },
  weatherKind: { fi: "sää", en: "weather" },
  chosen: { fi: "valittu", en: "chosen" },
  reading: { fi: "Luetaan mittauksia…", en: "Reading the measurements…" },
  computing: { fi: "Lasketaan…", en: "Computing…" },
  noStations: { fi: "Ilmanlaatuasemia ei löytynyt.", en: "No air quality station was found." },
  noHistory: { fi: "Valitulta jaksolta ei ole mittauksia.", en: "No measurements in the chosen period." },
  unreadable: { fi: "Mittauksia ei voitu lukea (HTTP {status}). Yritä myöhemmin uudelleen.", en: "The measurements could not be read (HTTP {status}). Try again later." },
  offline: { fi: "Mittauksia ei voitu lukea. Tarkista yhteys ja yritä uudelleen.", en: "The measurements could not be read. Check the connection and try again." },
  failed: { fi: "Vertailua ei voitu laskea: {why}", en: "The comparison could not be computed: {why}" },
  retry: { fi: "Yritä uudelleen", en: "Retry" },
  open: { fi: "Tiedot: {name}", en: "Details of {name}" },
  pm10: { fi: "PM10 (µg/m³)", en: "PM10 (µg/m³)" },
  pm25: { fi: "PM2.5 (µg/m³)", en: "PM2.5 (µg/m³)" },
  airQualityIndex: { fi: "ilmanlaatuindeksi", en: "air quality index" },
  temperature: { fi: "lämpötila (°C)", en: "temperature (°C)" },
  windSpeed: { fi: "tuulen nopeus (m/s)", en: "wind speed (m/s)" },
  relativeHumidity: { fi: "ilmankosteus (%)", en: "humidity (%)" },
  precipitation: { fi: "sade (mm/h)", en: "rain (mm/h)" },
} as const;

export type Key = keyof typeof TEXTS;

/** The text of `key` in `lang`, each `{name}` replaced by `values[name]`. */
export function t(lang: Lang, key: Key, values: Record<string, string | number> = {}): string {
  return TEXTS[key][lang].replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
