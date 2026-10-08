import { useState } from "react";
import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { langOf, t } from "./i18n";
import type { Lang } from "./i18n";
import { Reach } from "./pages/Reach";
import { useScheme } from "./theme";

/** How far one gets by transit in Helsinki, in Finnish or English, the language kept in the address. */
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
  // A new scheme redraws the page, so the map and its legend take their colours again.
  const scheme = useScheme();
  const pages: Page[] = [{ id: "reach", label: t(lang, "page"), render: () => <Reach key={scheme} lang={lang} /> }];
  return (
    <AppShell
      title={t(lang, "title")}
      pages={pages}
      actions={
        <button type="button" className="jc-button" lang={lang === "fi" ? "en" : "fi"} onClick={() => switchTo(lang === "fi" ? "en" : "fi")}>
          {t(lang, "language")}
        </button>
      }
    />
  );
}
