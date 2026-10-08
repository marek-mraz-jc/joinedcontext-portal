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

export function getLanguage(search?: string): Lang {
  if (typeof search === "string") {
    const val = new URLSearchParams(search.startsWith("?") ? search : `?${search}`).get("lang");
    if (val === "fi" || val === "en") return val;
  }
  if (typeof window !== "undefined") {
    const searchVal = new URLSearchParams(window.location.search).get("lang");
    if (searchVal === "fi" || searchVal === "en") return searchVal;

    if (window.location.hash.includes("?")) {
      const hashQuery = window.location.hash.slice(window.location.hash.indexOf("?"));
      const hashVal = new URLSearchParams(hashQuery).get("lang");
      if (hashVal === "fi" || hashVal === "en") return hashVal;
    }
  }
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    if (navigator.language.toLowerCase().startsWith("fi")) {
      return "fi";
    }
  }
  return "en";
}

export function localeOf(lang: Lang): "fi-FI" | "en-GB" {
  return lang === "fi" ? "fi-FI" : "en-GB";
}

export function formatDate(
  date: Date | string | null | undefined,
  lang: Lang,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: ZONE,
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  };
  return new Intl.DateTimeFormat(localeOf(lang), opts).format(d);
}

export function formatDay(date: Date | string | null | undefined, lang: Lang): string {
  return formatDate(date, lang, { dateStyle: "medium", timeStyle: undefined });
}

export function formatNumber(
  value: number,
  lang: Lang,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(localeOf(lang), options).format(value);
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

export function t(
  key: TranslationKey,
  lang: Lang,
  params?: Record<string, string | number>,
): string {
  const dict = DICTIONARY[lang] ?? DICTIONARY.en;
  let val: string = dict[key] ?? DICTIONARY.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      val = val.replaceAll(`{${k}}`, String(v));
    }
  }
  return val;
}
