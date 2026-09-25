import { useMemo } from "react";
import { useClient, useSchema } from "@joinedcontext/sdk";
import { AppShell } from "./components/AppShell";
import type { Page } from "./components/AppShell";
import { Empty, Loading, Problem } from "./components/states";
import { Overview } from "./pages/Overview";
import { TypePage } from "./pages/TypePage";
import { requestedLanguage, setLanguage, t } from "./i18n";

/** The overview and one page per entity type the endpoint publishes. Add a page to `pages` for a new screen. */
export default function App() {
  const { config } = useClient();
  // Before any page renders: every `t` below answers in it.
  const language = useMemo(() => requestedLanguage(config.language), [config.language]);
  setLanguage(language);
  const { schema, error } = useSchema();
  const pages = useMemo((): Page[] => {
    if (!schema) return [];
    return [
      { id: "overview", label: t("page.overview"), render: () => <Overview schema={schema} /> },
      ...Object.keys(schema)
        .sort()
        .map((type): Page => ({ id: type, label: type, render: () => <TypePage type={type} schema={schema[type]} /> })),
    ];
  }, [schema, language]);

  if (error) return <Problem error={error} />;
  if (!schema) return <Loading />;
  if (pages.length === 1) return <Empty>{t("app.noTypes")}</Empty>;
  return <AppShell title={config.appName ?? config.endpointName ?? t("app.name")} pages={pages} />;
}
