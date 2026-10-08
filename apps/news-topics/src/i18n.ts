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
