import { useMemo } from "react";
import { useClient } from "@joinedcontext/sdk";
import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { AlertDesk } from "./pages/AlertDesk";
import { requestedLanguage, setLanguage } from "./i18n";

const PAGES: Page[] = [{ id: "alerts", label: "Alerts", render: () => <AlertDesk /> }];

/** The capital region's traffic alerts as one sortable, filterable grid; it reads and never writes (T-3016). */
export default function App() {
  const { config } = useClient();
  // Before any page renders: the table and filter words answer in it.
  const language = useMemo(() => requestedLanguage(config.language), [config.language]);
  setLanguage(language);
  return <AppShell title="Alerts desk" pages={PAGES} />;
}
