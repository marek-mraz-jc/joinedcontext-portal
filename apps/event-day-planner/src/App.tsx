import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { LangSwitch } from "./components/LangSwitch";
import { useLang } from "./i18n";
import { MyDay } from "./pages/MyDay";
import { t } from "./texts";

/** A visitor's day of Helsinki's events: what to see, in which order, and the walk between. */
export default function App() {
  const lang = useLang();
  const pages: Page[] = [{ id: "day", label: t(lang, "page"), render: () => <MyDay /> }];
  return <AppShell title={t(lang, "title")} pages={pages} actions={<LangSwitch label={t(lang, "language")} />} />;
}
