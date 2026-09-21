/**
 * Every word on screen, Slovak first (T-2435).
 *
 * Slovak is the language of the city that publishes these readings, so it is the default and
 * English is what a reader gets by asking; `config.language` decides and no component holds a
 * string. The two maps have the same keys, which `locales.test.ts` asserts, because a missing
 * Slovak key would silently show an English sentence on a Slovak page.
 */
import type { Band } from "./stations";

export interface Strings {
  /** The BCP 47 tag `Intl` formats numbers and dates with. */
  locale: string;
  title: string;
  subtitle: string;
  /** The map, which a screen reader cannot read: the list beside it is the same data. */
  mapLabel: string;
  stationsLabel: string;
  /** The word a station is named with: the published model carries no `name` slot. */
  station: string;
  pm10: string;
  pm25: string;
  unit: string;
  measuredAt: string;
  band: Record<Band, string>;
  bandOf: string;
  limitNote: string;
  staleNote: string;
  noReading: string;
  noLocation: string;
  pick: string;
  picked: string;
  historyTitle: string;
  historyOf: string;
  loading: string;
  empty: string;
  emptyWhy: string;
  failed: string;
  failedWhy: string;
  noEndpoint: string;
  source: string;
  history: {
    title: string;
    window: Record<"hour" | "day" | "week" | "custom", string>;
    from: string;
    to: string;
    at: string;
    value: string;
    unit: string;
    empty: string;
    cut: string;
    copy: string;
    close: string;
    loading: string;
    error: string;
  };
}

/** The shape beside the colour, so a band is never carried by colour alone (UI-30). */
export const BAND_SHAPE: Record<Band, string> = {
  low: "●",
  raised: "▲",
  high: "■",
  stale: "◌",
  unknown: "◌",
};

const SK: Strings = {
  locale: "sk-SK",
  title: "Ovzdušie v Banskej Bystrici",
  subtitle:
    "Meracie stanice mesta, farebne podľa posledného merania PM10 voči dennému limitu. Vyberte stanicu a uvidíte jej posledné hodnoty a jeden deň histórie.",
  mapLabel: "Mapa staníc",
  stationsLabel: "Stanice",
  station: "Stanica",
  pm10: "PM10",
  pm25: "PM2,5",
  unit: "µg/m³",
  measuredAt: "Merané",
  band: {
    low: "v limite",
    raised: "zvýšené",
    high: "nad limitom",
    stale: "staré meranie",
    unknown: "bez hodnoty",
  },
  bandOf: "Stav voči smernici 2008/50/ES",
  limitNote:
    "Denný limit PM10 je 50 µg/m³, zvýšené od 35 µg/m³ (smernica 2008/50/ES). Hodnotí sa posledné meranie stanice, nie denný priemer.",
  staleNote:
    "Stanica, ktorá viac ako tri hodiny nič neposlala, je označená ako staré meranie. Posledná hodnota sa nepreberá ako súčasná.",
  noReading: "stanica neposlala hodnotu",
  noLocation: "stanica neuvádza polohu, na mape nie je",
  pick: "Zobraziť stanicu",
  picked: "Vybraná stanica",
  historyTitle: "Jeden deň histórie",
  historyOf: "História hodnoty",
  loading: "Načítavajú sa stanice…",
  empty: "Zatiaľ tu nie je žiadna stanica.",
  emptyWhy: "Endpoint odpovedal, ale neposlal ani jednu stanicu.",
  failed: "Stanice sa nepodarilo načítať.",
  failedWhy: "Dôvod",
  noEndpoint: "Aplikácia nemá nastavený endpoint, cez ktorý by čítala.",
  source: "Zdroj: mesto Banská Bystrica, priestor ovzdusie, verejný endpoint public-air.",
  history: {
    title: "História",
    window: { hour: "Posledná hodina", day: "Posledný deň", week: "Posledný týždeň", custom: "Medzi" },
    from: "Od",
    to: "Do",
    at: "Merané",
    value: "Hodnota",
    unit: "Jednotka",
    empty: "V tomto okne nie je zaznamenaná žiadna hodnota.",
    cut: "najstaršie body nie sú zobrazené",
    copy: "Kopírovať ako CSV",
    close: "Zavrieť",
    loading: "Načítava sa…",
    error: "Chyba",
  },
};

const EN: Strings = {
  locale: "en-GB",
  title: "Air quality in Banská Bystrica",
  subtitle:
    "The city's measuring stations, coloured by their latest PM10 reading against the daily limit. Pick a station to see its latest values and one day of history.",
  mapLabel: "Map of the stations",
  stationsLabel: "Stations",
  station: "Station",
  pm10: "PM10",
  pm25: "PM2.5",
  unit: "µg/m³",
  measuredAt: "Measured",
  band: {
    low: "within the limit",
    raised: "elevated",
    high: "above the limit",
    stale: "old reading",
    unknown: "no value",
  },
  bandOf: "State against Directive 2008/50/EC",
  limitNote:
    "The PM10 daily limit is 50 µg/m³ and 35 µg/m³ is elevated (Directive 2008/50/EC). What is judged is the station's latest reading, not a daily mean.",
  staleNote:
    "A station that has sent nothing for more than three hours is marked as an old reading. Its last value is not carried forward as the air now.",
  noReading: "the station sent no value",
  noLocation: "the station publishes no location, so it is not on the map",
  pick: "Show this station",
  picked: "Selected station",
  historyTitle: "One day of history",
  historyOf: "History of",
  loading: "Loading the stations…",
  empty: "There is no station here yet.",
  emptyWhy: "The endpoint answered, and the answer held no station.",
  failed: "The stations could not be loaded.",
  failedWhy: "Reason",
  noEndpoint: "This application has no endpoint configured to read through.",
  source: "Source: city of Banská Bystrica, space ovzdusie, public endpoint public-air.",
  history: {
    title: "History",
    window: { hour: "Last hour", day: "Last day", week: "Last week", custom: "Between" },
    from: "From",
    to: "To",
    at: "Measured",
    value: "Value",
    unit: "Unit",
    empty: "Nothing was recorded in this window.",
    cut: "the oldest points are not shown",
    copy: "Copy as CSV",
    close: "Close",
    loading: "Loading…",
    error: "Error",
  },
};

export const LOCALES: Readonly<Record<string, Strings>> = { sk: SK, en: EN };

/** Slovak unless the served configuration asks for a language this application has. */
export function stringsFor(language?: string): Strings {
  const tag = (language ?? "sk").toLowerCase().split("-")[0];
  return LOCALES[tag] ?? SK;
}

/**
 * What a station is called. The published model has no `name` slot, so the only name there is is
 * the `{localId}` of its URN: `station-1` reads "Stanica 1", and an id in any other shape is
 * shown as it is rather than dressed up as a name nobody published.
 */
export function nameOf(localId: string, s: Strings): string {
  return `${s.station} ${localId.replace(/^(station|stanica)-/i, "")}`;
}
