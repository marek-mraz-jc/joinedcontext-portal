import { useMemo } from "react";
import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { getLanguage, t } from "./i18n";
import { Topics } from "./pages/Topics";

/** Helsinki news topics: topic shares, weekly trends, and articles by topic. */
export default function App() {
  const lang = getLanguage();
  const pages: Page[] = useMemo(
    () => [{ id: "topics", label: t("topics", lang), render: () => <Topics /> }],
    [lang],
  );

  return <AppShell title={t("appTitle", lang)} pages={pages} initial="topics" />;
}
