/**
 * The publisher's records, with the one attribute a person may write (T-2436, T-2437).
 *
 * The same bundle is both grids: which body's records it shows comes from the space the served
 * configuration names, and the endpoint comes from the same document (SDK-02). Nothing here is
 * built for one project, so the city's screen and the region's cannot drift apart.
 *
 * The table itself is the SDK's `EntityGrid` (UI-64, UI-71, SDK-29): paging, a filter per column
 * that becomes the endpoint's own `q`, one open column, and a refusal shown beside the row it
 * belongs to. What this application adds is the narrowing — one type, six columns, one writable
 * attribute — and the sentence that says why the figures are not writable.
 *
 * Above the table, the same records as charts with the statistics office's names (T-2966): the
 * table keeps the publisher's codes, because its filters ask the endpoint about those.
 */
import { useMemo } from "react";
import { endpointSource, EntityGrid, Header, Page, transportFor, useClient } from "@joinedcontext/sdk";
import { recordRenderers } from "./cells";
import { Overview } from "./Overview";
import { gridConfig, notesOnly } from "./records";
import { bodyOf, noteWords, SPACE_OF, stringsFor } from "./locales";

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const body = bodyOf(config.space);
  const language = config.language;

  // The endpoint of this application's own space, found by space and never by position: a
  // configuration that names another body's endpoint first must not decide whose rows are shown.
  const slug = body
    ? (config.endpoints?.find((candidate) => candidate.space === SPACE_OF[body])?.slug ?? config.slug)
    : null;

  const source = useMemo(
    () => (slug ? notesOnly(endpointSource(slug, transportFor(config), language), noteWords(s)) : null),
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, language],
  );
  const grid = useMemo(() => (slug ? gridConfig(slug, s.column) : null), [slug, s.column]);
  const renderers = useMemo(
    () => recordRenderers(s.locale.startsWith("sk") ? "sk" : "en", { locale: s.locale, showId: s.showId }),
    [s.locale, s.showId],
  );

  if (!body) {
    return (
      <main>
        <Page>
          <p role="alert">{s.unknownSpace}</p>
        </Page>
      </main>
    );
  }

  return (
    <main>
      <Page>
        <Header level={1} title={s.title[body]} subtitle={s.subtitle[body]} />
        {source && grid ? (
          <>
            <Overview body={body} source={source} s={s} />
            <section className="records" aria-labelledby="records-title">
              <h2 id="records-title">{s.records}</h2>
              <div className="notes">
                <p className="note">{s.recordsWhy}</p>
                <p className="note">{s.readOnlyWhy}</p>
                <p className="note">{s.noteWhy}</p>
              </div>
              <EntityGrid config={grid} source={source} labels={s.grid} renderers={renderers} />
            </section>
          </>
        ) : (
          <p role="alert">{s.noEndpoint}</p>
        )}
        <p className="source">{s.source[body]}</p>
      </Page>
    </main>
  );
}
