import { useState } from "react";
import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { langOf, t } from "./i18n";
import type { Lang } from "./i18n";
import { Heatmap } from "./pages/Heatmap";
import { useScheme } from "./theme";

const LANGUAGES = [
  { code: "fi", label: "Suomi" },
  { code: "en", label: "English" },
];

/** Where and when Helsinki's alerts happen, in Finnish or English, the language kept in the address, in the SDK's shell (SDK-39). */
export default function App() {
  const [lang, setLang] = useState<Lang>(() => langOf(window.location.search, navigator.languages ?? [navigator.language]));
  const switchTo = (next: Lang) => {
    setLang(next);
    document.documentElement.lang = next;
    document.title = t(next, "title");
    try {
      const params = new URLSearchParams(window.location.search);
      params.set("lang", next);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
    } catch {
      // A sandboxed preview may refuse; the page still switches.
    }
  };
  document.documentElement.lang = lang;
  document.title = t(lang, "title");
  // A new scheme redraws the page, so the map and the chart take their colours again.
  const scheme = useScheme();
  const pages: ShellPage[] = [{ id: "alerts", label: t(lang, "page"), render: () => <Heatmap key={scheme} lang={lang} /> }];
  return (
    <AppShell
      title={t(lang, "title")}
      pages={pages}
      languages={LANGUAGES}
      language={lang}
      onLanguage={(next) => switchTo(next === "en" ? "en" : "fi")}
    />
  );
}
