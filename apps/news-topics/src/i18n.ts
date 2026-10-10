/**
 * UI strings and locale formatting for Helsinki news topics (T-3334).
 * Supports English and Finnish, formatting dates in Europe/Helsinki.
 */

export type Lang = "en" | "fi";

export const ZONE = "Europe/Helsinki";

export const DICTIONARY = {
  en: {
    appTitle: "Helsinki news topics",
    topics: "Topics",
    pageTitle: "Topics in the news",
    filters: "Filter the news",
    period: "Period",
    weeks4: "4 weeks",
    weeks8: "8 weeks",
    weeks12: "12 weeks",
    all: "All",
    topicsCount: "Number of topics",
    search: "Search",
    searchPlaceholder: "Search the titles",
    reading: "Reading the news…",
    loading: "Finding the topics…",
    empty: "No news in this period.",
    topicsTitle: "Topics of the period",
    topicN: "Topic",
    keywords: "Keywords",
    articlesCount: "articles",
    chartTitle: "Topic share per week",
    showTable: "Show the numbers as a table",
    hideTable: "Hide the table",
    tableAria: "Topic share per week, as a table",
    week: "Week",
    articlesTitle: "Articles of topic",
    noDate: "No date",
    readOriginal: "Read on hel.fi",
    kept: "Topics week by week, kept by the server",
    keptNote: "The App's server fits the topics of each week and keeps them, also after the feed has dropped the week's articles.",
    keptReading: "Reading the kept weeks…",
    keptEmpty: "The server has not kept any week yet.",
    keptFailed: "The kept weeks could not be read:",
    keptStale: "The feed could not be read just now: these are the weeks as last kept.",
    keptTable: "Topics week by week",
    keptArticles: "Articles",
    keptTopics: "Topics, the largest first",
    corpus: "Articles as a file",
    corpusOf: "Download the articles of week",
    corpusFailed: "The articles of the week could not be downloaded:",
  },
  fi: {
    appTitle: "Helsingin uutisaiheet",
    topics: "Aiheet",
    pageTitle: "Uutisaiheet",
    filters: "Rajaa uutisia",
    period: "Ajanjakso",
    weeks4: "4 viikkoa",
    weeks8: "8 viikkoa",
    weeks12: "12 viikkoa",
    all: "Kaikki",
    topicsCount: "Aiheiden määrä",
    search: "Hae",
    searchPlaceholder: "Hae otsikoista",
    reading: "Luetaan uutisia…",
    loading: "Etsitään aiheita…",
    empty: "Ei uutisia tällä ajanjaksolla.",
    topicsTitle: "Ajanjakson aiheet",
    topicN: "Aihe",
    keywords: "Avainsanat",
    articlesCount: "artikkelia",
    chartTitle: "Aiheiden osuus viikoittain",
    showTable: "Näytä luvut taulukkona",
    hideTable: "Piilota taulukko",
    tableAria: "Aiheiden osuus viikoittain taulukkona",
    week: "Viikko",
    articlesTitle: "Aiheen artikkelit",
    noDate: "Ei päivämäärää",
    readOriginal: "Lue hel.fi:ssä",
    kept: "Aiheet viikoittain, palvelimen säilyttämät",
    keptNote: "Sovelluksen palvelin etsii kunkin viikon aiheet ja säilyttää ne myös sen jälkeen, kun syöte on pudottanut viikon artikkelit.",
    keptReading: "Luetaan säilytettyjä viikkoja…",
    keptEmpty: "Palvelin ei ole vielä säilyttänyt yhtään viikkoa.",
    keptFailed: "Säilytettyjä viikkoja ei voitu lukea:",
    keptStale: "Syötettä ei voitu lukea juuri nyt: viikot ovat viimeksi säilytetyt.",
    keptTable: "Aiheet viikoittain",
    keptArticles: "Artikkeleita",
    keptTopics: "Aiheet, suurin ensin",
    corpus: "Artikkelit tiedostona",
    corpusOf: "Lataa viikon artikkelit",
    corpusFailed: "Viikon artikkeleita ei voitu ladata:",
  },
} as const satisfies Record<Lang, Record<string, string>>;

export type TranslationKey = keyof typeof DICTIONARY.en;

/** The page's language: `?lang=` in the address or in its `#topics?` part, else the browser's, else English. */
export function getLanguage(): Lang {
  const hash = window.location.hash;
  for (const query of [window.location.search, hash.slice(hash.indexOf("?") + 1)]) {
    const asked = new URLSearchParams(query).get("lang");
    if (asked === "fi" || asked === "en") return asked;
  }
  return navigator.language.toLowerCase().startsWith("fi") ? "fi" : "en";
}

export function localeOf(lang: Lang): "fi-FI" | "en-GB" {
  return lang === "fi" ? "fi-FI" : "en-GB";
}

export function formatDate(date: Date | string | null | undefined, lang: Lang): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  };
  return new Intl.DateTimeFormat(localeOf(lang), opts).format(d);
}

export function formatPercent(
  fraction: number,
  lang: Lang,
  maximumFractionDigits = 1,
): string {
  return new Intl.NumberFormat(localeOf(lang), {
    style: "percent",
    maximumFractionDigits,
  }).format(fraction);
}

export function t(key: TranslationKey, lang: Lang): string {
  return DICTIONARY[lang][key];
}
