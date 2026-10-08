import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { useLang } from "./i18n";
import type { Lang } from "./i18n";
import { Explore } from "./pages/Explore";
import { t } from "./texts";
import { readParams, writeParams } from "./url";

const LANGUAGES = [
  { code: "fi", label: "Suomi" },
  { code: "en", label: "English" },
];

/**
 * Suomi or English: the choice is written into the address (`?lang=`) and the page reloads in it,
 * so every text, number and date follows at once and a shared link keeps the language.
 */
export function chooseLanguage(next: string, current: Lang, reload: () => void = () => window.location.reload()): void {
  if (next === current || (next !== "fi" && next !== "en")) return;
  const params = readParams(window.location.search);
  params.set("lang", next);
  writeParams(params);
  reload();
}

/** How Helsinki's weather moves its air quality, station by station, in the SDK's shell (SDK-39). */
export default function App() {
  const lang = useLang();
  const pages: ShellPage[] = [{ id: "compare", label: t(lang, "page"), render: () => <Explore /> }];
  return (
    <AppShell
      title={t(lang, "title")}
      pages={pages}
      languages={LANGUAGES}
      language={lang}
      onLanguage={(next) => chooseLanguage(next, lang)}
    />
  );
}
