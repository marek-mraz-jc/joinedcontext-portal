import { useState } from "react";
import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { langOf, t } from "./i18n";
import type { Lang } from "./i18n";
import { Compare } from "./pages/Compare";
import { useScheme } from "./theme";

/** Compare districts side by side, in Finnish or English, with URL hash persistence. */
export default function App(): React.JSX.Element {
  const [lang, setLang] = useState<Lang>(() =>
    langOf(window.location.search, navigator.languages ?? [navigator.language]),
  );

  const switchTo = (next: Lang) => {
    setLang(next);
    document.documentElement.lang = next;
    document.title = t(next, "title");
    try {
      const params = new URLSearchParams(window.location.search);
      params.set("lang", next);
      window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`);
    } catch {
      // sandboxed preview may refuse
    }
  };

  document.documentElement.lang = lang;
  document.title = t(lang, "title");
  const scheme = useScheme();

  const pages: Page[] = [
    {
      id: "compare",
      label: t(lang, "page"),
      render: () => <Compare key={scheme} lang={lang} />,
    },
  ];

  return (
    <AppShell
      title={t(lang, "title")}
      pages={pages}
      actions={
        <button
          type="button"
          className="jc-button"
          lang={lang === "fi" ? "en" : "fi"}
          onClick={() => switchTo(lang === "fi" ? "en" : "fi")}
        >
          {t(lang, "language")}
        </button>
      }
    />
  );
}
