import { useReducer } from "react";
import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { useLang } from "./i18n";
import { MyDay } from "./pages/MyDay";
import { t } from "./texts";
import { readParams, writeParams } from "./url";

const LANGUAGES = [
  { code: "fi", label: "Suomi" },
  { code: "en", label: "English" },
];

/**
 * A visitor's day of Helsinki's events in the SDK's shell (SDK-39): what to see, in which order,
 * and the walk between; an event opens in the shell's entity panel (SDK-40).
 */
export default function App() {
  const lang = useLang();
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  // Suomi or English: written into the address (`?lang=`), which every text, number and date reads,
  // so the page redraws in it at once and a shared link keeps the language.
  const switchTo = (next: string) => {
    const params = readParams(window.location.search);
    params.set("lang", next === "en" ? "en" : "fi");
    writeParams(params);
    redraw();
  };
  const pages: ShellPage[] = [{ id: "day", label: t(lang, "page"), render: () => <MyDay /> }];
  return <AppShell title={t(lang, "title")} pages={pages} languages={LANGUAGES} language={lang} onLanguage={switchTo} />;
}
