import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { LangSwitch } from "./components/LangSwitch";
import { useLang } from "./i18n";
import { Rebalance } from "./pages/Rebalance";
import { t } from "./texts";

/** The operator's rebalancing plan: the stations to empty and fill, and the van's route between them. */
export default function App() {
  const lang = useLang();
  const pages: Page[] = [{ id: "plan", label: t(lang, "page"), render: () => <Rebalance /> }];
  return <AppShell title={t(lang, "title")} pages={pages} actions={<LangSwitch label={t(lang, "language")} />} />;
}
