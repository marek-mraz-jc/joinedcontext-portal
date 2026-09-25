import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { Events } from "./pages/Events";

const PAGES: Page[] = [{ id: "events", label: "Events", render: () => <Events /> }];

/** Helsinki's upcoming events: charts, a map and the list, read from the app's own endpoint. */
export default function App() {
  return <AppShell title="Helsinki events" pages={PAGES} />;
}
