import { useState } from "react";
import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { langOf, t } from "./i18n";
import type { Lang } from "./i18n";
import { Quality } from "./pages/Quality";
import { useScheme } from "./theme";

const LANGUAGES = [
  { code: "fi", label: "Suomi" },
  { code: "en", label: "English" },
];

/**
 * Helsinki data quality inspector application, light and dark, Finnish and English, in the SDK's
 * shell (SDK-39).
 */
export default function App(): React.JSX.Element {
  const [lang, setLang] = useState<Lang>(() =>
    langOf(window.location.search, navigator.languages ?? [navigator.language]),
  );

  const switchTo = (next: string) => {
    if (next !== "fi" && next !== "en") return;
    setLang(next);
    document.documentElement.lang = next;
    document.title = t(next, "title");
    try {
      const params = new URLSearchParams(window.location.search);
      params.set("lang", next);
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}?${params}${window.location.hash}`,
      );
    } catch {
      // sandboxed preview may refuse
    }
  };

  document.documentElement.lang = lang;
  document.title = t(lang, "title");
  const scheme = useScheme();

  const pages: ShellPage[] = [
    {
      id: "quality",
      label: t(lang, "page"),
      render: () => <Quality key={scheme} lang={lang} />,
    },
  ];

  return <AppShell title={t(lang, "title")} pages={pages} languages={LANGUAGES} language={lang} onLanguage={switchTo} />;
}
