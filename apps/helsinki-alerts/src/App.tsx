import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { Alerts } from "./pages/Alerts";
import { Overview } from "./pages/Overview";

const PAGES: Page[] = [
  { id: "overview", label: "Overview", render: () => <Overview /> },
  { id: "alerts", label: "Alerts", render: () => <Alerts /> },
];

/** Traffic alerts in the capital region: the numbers, and every alert on a map and in a table. */
export default function App() {
  return <AppShell title="Helsinki traffic alerts" pages={PAGES} />;
}
