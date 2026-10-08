import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { useLang } from "./i18n";
import type { Lang } from "./i18n";
import { Rebalance } from "./pages/Rebalance";
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

/** The operator's rebalancing plan in the SDK's shell (SDK-39): the stations to empty and fill, and the van's route between them. */
export default function App() {
  const lang = useLang();
  const pages: ShellPage[] = [{ id: "plan", label: t(lang, "page"), render: () => <Rebalance /> }];
  return <AppShell title={t(lang, "title")} pages={pages} languages={LANGUAGES} language={lang} onLanguage={(next) => chooseLanguage(next, lang)} />;
}
