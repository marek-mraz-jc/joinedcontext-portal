import type { Lang } from "./i18n";

/** The page's words, Finnish and English. */
const TEXTS = {
  title: { fi: "Kaupunkipyörien tasaussuunnitelma", en: "City bike rebalancing planner" },
  page: { fi: "Tasaus", en: "Rebalancing" },
  language: { fi: "Kieli", en: "Language" },
  soonEmpty: { fi: "Tyhjenemässä", en: "About to run empty" },
  soonFull: { fi: "Täyttymässä", en: "About to be full" },
  moved: { fi: "Pakettiauto siirtää", en: "The van moves" },
  bikesOver: { fi: "pyörää, {km} km, {stops} pysähdystä", en: "bikes, {km} km, {stops} stops" },
  stationsOf: { fi: "{n} / {all} asemaa", en: "{n} of {all} stations" },
  updated: { fi: "Tiedot päivitetty {at}", en: "Counts as of {at}" },
  van: { fi: "Auton kapasiteetti (pyörää)", en: "Van capacity (bikes)" },
  start: { fi: "Lähtöpaikka", en: "Start at" },
  startAuto: { fi: "Täysin asema", en: "The fullest station" },
  reset: { fi: "Palauta valinnat", en: "Reset choices" },
  map: { fi: "Kartta", en: "Map" },
  mapLabel: { fi: "Asemat värin mukaan ja auton reitti", en: "Stations by colour and the van's route" },
  route: { fi: "Reitti", en: "Route" },
  routeEmpty: { fi: "Mitään siirrettävää ei ole: jokainen asema on tasapainossa tai jätetty pois.", en: "Nothing to move: every station is balanced or left out." },
  pick: { fi: "Ota {n}", en: "Take {n}" },
  drop: { fi: "Jätä {n}", en: "Leave {n}" },
  load: { fi: "kyydissä {n}", en: "{n} on board" },
  leg: { fi: "{km} km edellisestä", en: "{km} km from the last stop" },
  leaveOut: { fi: "Jätä pois reitiltä", en: "Leave out of the route" },
  addIn: { fi: "Lisää reitille", en: "Add to the route" },
  putBack: { fi: "Palauta reitille", en: "Put back in the route" },
  watch: { fi: "Epätasapainoisimmat asemat", en: "Stations most out of balance" },
  station: { fi: "Asema", en: "Station" },
  bikes: { fi: "Pyöriä / paikkoja", en: "Bikes / places" },
  fill: { fi: "Täyttöaste", en: "Fill" },
  state: { fi: "Tila", en: "State" },
  choice: { fi: "Reitillä", en: "In the route" },
  fillChart: { fi: "Asemat täyttöasteen mukaan", en: "Stations by fill" },
  stationsAxis: { fi: "Asemia", en: "Stations" },
  reading: { fi: "Luetaan asemia…", en: "Reading the stations…" },
  planning: { fi: "Lasketaan reittiä…", en: "Planning the route…" },
  noStations: { fi: "Kaupunkipyöräasemia ei löytynyt.", en: "No docking station was found." },
  unreadable: { fi: "Asemia ei voitu lukea (HTTP {status}). Yritä myöhemmin uudelleen.", en: "The stations could not be read (HTTP {status}). Try again later." },
  offline: { fi: "Asemia ei voitu lukea. Tarkista yhteys ja yritä uudelleen.", en: "The stations could not be read. Check the connection and try again." },
  plannerFailed: { fi: "Reittiä ei voitu laskea: {why}", en: "The route could not be planned: {why}" },
  retry: { fi: "Yritä uudelleen", en: "Retry" },
  empty: { fi: "tyhjä", en: "empty" },
  low: { fi: "vähissä", en: "low" },
  balanced: { fi: "tasapainossa", en: "balanced" },
  high: { fi: "lähes täynnä", en: "nearly full" },
  full: { fi: "täynnä", en: "full" },
  unknown: { fi: "ei tietoa", en: "no count" },
  auto: { fi: "automaattisesti", en: "automatic" },
  included: { fi: "lisätty", en: "added" },
  excluded: { fi: "pois", en: "left out" },
} as const;

export type Key = keyof typeof TEXTS;

/** The text of `key` in `lang`, each `{name}` replaced by `values[name]`. */
export function t(lang: Lang, key: Key, values: Record<string, string | number> = {}): string {
  return TEXTS[key][lang].replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
