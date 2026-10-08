import { useState } from "react";
import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { langOf, t } from "./i18n";
import type { Lang } from "./i18n";
import { Forecast } from "./pages/Forecast";
import { useScheme } from "./theme";

const LANGUAGES = [
  { code: "fi", label: "Suomi" },
  { code: "en", label: "English" },
];

/**
 * Helsinki's indicators, their trends and forecasts, in the SDK's shell (SDK-39): Finnish or
 * English, the language kept in the address; an indicator opens in the SDK's entity panel (SDK-40).
 */
export default function App() {
  const [lang, setLang] = useState<Lang>(() => langOf(window.location.search, navigator.languages ?? [navigator.language]));
  const switchTo = (next: string) => {
    const chosen: Lang = next === "en" ? "en" : "fi";
    setLang(chosen);
    try {
      const params = new URLSearchParams(window.location.search);
      params.set("lang", chosen);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
    } catch {
      // A sandboxed preview may refuse; the page still switches.
    }
  };
  document.documentElement.lang = lang;
  document.title = t(lang, "title");
  // A new scheme redraws the page, so the chart takes its colours again.
  const scheme = useScheme();
  const pages: ShellPage[] = [{ id: "kpis", label: t(lang, "page"), render: () => <Forecast key={scheme} lang={lang} /> }];
  return <AppShell title={t(lang, "title")} pages={pages} languages={LANGUAGES} language={lang} onLanguage={switchTo} />;
}
