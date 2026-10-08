import i18n from "i18next";
import ICU from "i18next-icu";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import type { BackendModule, ResourceKey } from "i18next";
import en from "./locales/en.json";

export const SUPPORTED_LOCALES = ["en", "sk", "de", "cs"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

// English is the fallback and ships in the entry; another language loads when it is chosen, so a
// visit downloads one locale besides English rather than all four (T-3316).
const LOCALES: Record<string, () => Promise<{ default: ResourceKey }>> = {
  sk: () => import("./locales/sk.json"),
  de: () => import("./locales/de.json"),
  cs: () => import("./locales/cs.json"),
};

export const localeLoader: BackendModule = {
  type: "backend",
  init: () => undefined,
  read: (language, _namespace, callback) => {
    const load = LOCALES[language];
    if (!load) return callback(null, language === "en" ? en : {});
    load().then(
      (locale) => callback(null, locale.default),
      (error: unknown) =>
        callback(error instanceof Error ? error.message : String(error), false),
    );
  },
};

// WCAG 3.1.1: the document language has to follow the chosen locale, not stay at the
// `lang="en"` baked into index.html. Registered before init: init detects `?lang=` and fires
// its first languageChanged inside the call (T-2814).
i18n.on("languageChanged", (lng) => {
  if (typeof document !== "undefined") {
    document.documentElement.lang = lng;
  }
});

/** Settles once the chosen language is loaded (or failed to: English stands in). */
export const i18nReady = i18n
  .use(localeLoader)
  .use(ICU)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en } },
    partialBundledLanguages: true,
    supportedLngs: SUPPORTED_LOCALES,
    fallbackLng: "en",
    detection: {
      order: ["querystring", "localStorage"],
      lookupQuerystring: "lang",
      lookupLocalStorage: "jc-lang",
      caches: ["localStorage"],
    },
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
