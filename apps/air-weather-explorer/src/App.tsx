import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { LangSwitch } from "./components/LangSwitch";
import { useLang } from "./i18n";
import { Explore } from "./pages/Explore";
import { t } from "./texts";

/** How Helsinki's weather moves its air quality, station by station. */
export default function App() {
  const lang = useLang();
  const pages: Page[] = [{ id: "compare", label: t(lang, "page"), render: () => <Explore /> }];
  return <AppShell title={t(lang, "title")} pages={pages} actions={<LangSwitch label={t(lang, "language")} />} />;
}
