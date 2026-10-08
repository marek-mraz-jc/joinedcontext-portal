import type { Lang } from "./i18n";

/** The page's words, Finnish and English. */
const TEXTS = {
  title: { fi: "Tapahtumapäiväni", en: "My day of events" },
  page: { fi: "Päiväni", en: "My day" },
  language: { fi: "Kieli", en: "Language" },
  day: { fi: "Päivä", en: "Day" },
  search: { fi: "Haku", en: "Search" },
  searchHint: { fi: "Nimi, paikka tai sana", en: "Name, place or word" },
  clear: { fi: "Tyhjennä valinnat", en: "Clear choices" },
  plan: { fi: "Suunnitelma", en: "The plan" },
  suggested: { fi: "Ehdotettu päivä: valitse tapahtumia, niin suunnitelma tehdään niistä.", en: "A suggested day: pick events and the plan is made of them." },
  yours: { fi: "{n} valittua tapahtumaa parhaassa järjestyksessä.", en: "{n} chosen events in their best order." },
  walking: { fi: "Kävelyä yhteensä {min} min ({km} km)", en: "Walking in all: {min} min ({km} km)" },
  walkFrom: { fi: "{min} min kävelyä ({km} km)", en: "{min} min walk ({km} km)" },
  noPlace: { fi: "ei paikkaa: kävelyä ei laskettu", en: "no place: walking not counted" },
  late: { fi: "{min} min myöhässä", en: "{min} min late" },
  missed: { fi: "ei ehdi", en: "out of reach" },
  conflicts: { fi: "Päällekkäiset tapahtumat", en: "Events at the same time" },
  conflict: { fi: "{a} ja {b} ovat samaan aikaan.", en: "{a} and {b} take place at the same time." },
  ics: { fi: "Lataa kalenteriin (.ics)", en: "Download to calendar (.ics)" },
  icsNone: { fi: "Päivässä ei ole tapahtumia ladattavaksi.", en: "The day holds no event to download." },
  map: { fi: "Kartta", en: "Map" },
  mapLabel: { fi: "Päivän tapahtumat järjestyksessä ja kävelyreitti", en: "The day's events in order and the walk between them" },
  events: { fi: "Päivän tapahtumat", en: "Events of the day" },
  eventsOf: { fi: "{n} / {all} tapahtumaa", en: "{n} of {all} events" },
  add: { fi: "Lisää päivääni", en: "Add to my day" },
  perHour: { fi: "Tapahtumia alkaa tunneittain", en: "Events starting each hour" },
  eventsAxis: { fi: "Tapahtumia", en: "Events" },
  hour: { fi: "klo {h}", en: "at {h}" },
  showAll: { fi: "Näytä kaikki tunnit, ei vain {h}", en: "Show every hour, not only {h}" },
  reading: { fi: "Luetaan tapahtumia…", en: "Reading the events…" },
  planning: { fi: "Suunnitellaan päivää…", en: "Planning the day…" },
  noEvents: { fi: "Tälle päivälle ei löytynyt tapahtumia.", en: "No event takes place on this day." },
  noMatch: { fi: "Mikään tapahtuma ei vastaa hakua.", en: "No event matches the search." },
  unreadable: { fi: "Tapahtumia ei voitu lukea (HTTP {status}). Yritä myöhemmin uudelleen.", en: "The events could not be read (HTTP {status}). Try again later." },
  offline: { fi: "Tapahtumia ei voitu lukea. Tarkista yhteys ja yritä uudelleen.", en: "The events could not be read. Check the connection and try again." },
  plannerFailed: { fi: "Päivää ei voitu suunnitella: {why}", en: "The day could not be planned: {why}" },
  retry: { fi: "Yritä uudelleen", en: "Retry" },
  cancelled: { fi: "Peruttu", en: "Cancelled" },
  source: { fi: "Lähde", en: "Source" },
  about: { fi: "Tietoa", en: "About" },
  allDay: { fi: "koko päivän", en: "all day" },
} as const;

export type Key = keyof typeof TEXTS;

/** The text of `key` in `lang`, each `{name}` replaced by `values[name]`. */
export function t(lang: Lang, key: Key, values: Record<string, string | number> = {}): string {
  return TEXTS[key][lang].replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole));
}
