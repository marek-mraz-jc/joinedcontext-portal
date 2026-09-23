import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { Overview } from "./pages/Overview";
import { Stations } from "./pages/Stations";

const PAGES: Page[] = [
  { id: "overview", label: "Overview", render: () => <Overview /> },
  { id: "stations", label: "Stations", render: () => <Stations /> },
];

/** Helsinki's city bikes: the numbers for the whole city, and every station on a map and in a table. */
export default function App() {
  return <AppShell title="Helsinki city bikes" pages={PAGES} />;
}
