import { useMemo } from "react";
import { AppShell } from "@joinedcontext/sdk";
import type { ShellPage } from "@joinedcontext/sdk";
import { getLanguage, t } from "./i18n";
import { Topics } from "./pages/Topics";

/**
 * Helsinki news topics in the SDK's shell (SDK-39): topic shares, weekly trends, and the articles
 * of a topic, each of which opens in the shell's entity panel (SDK-40).
 */
export default function App() {
  const lang = getLanguage();
  const pages: ShellPage[] = useMemo(() => [{ id: "topics", label: t("topics", lang), render: () => <Topics /> }], [lang]);
  return <AppShell title={t("appTitle", lang)} pages={pages} initial="topics" language={lang} />;
}
