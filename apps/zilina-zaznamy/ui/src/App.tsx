/**
 * The public datasets of the Žilina project as grids (T-3140, UI-64, UI-71, SDK-29): the
 * monuments, the railway stations and the air station of `zilina-verejne` and the university's
 * works of `zilina-uniza`, each through the app's own endpoint of its space, read only, with the
 * whole dataset as a CSV file.
 *
 * Its own look (T-2779): the datasets are a list on the left with what each holds and whose it is,
 * the grid fills the rest; on a phone the list is a row of buttons above the grid.
 */
import { useMemo, useState } from "react";
import { download, endpointSource, EntityGrid, Header, Page, SourceError, transportFor, useClient } from "@joinedcontext/sdk";
import { DATASETS, exportCsv, gridConfig, SPEC } from "./datasets";
import type { Dataset } from "./datasets";
import { stringsFor } from "./locales";

type Exported = { status: "idle" } | { status: "running" } | { status: "done"; rows: number; truncated: boolean } | { status: "failed"; reason: string };

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const language = config.language ?? "sk";
  const [dataset, setDataset] = useState<Dataset>("monuments");
  const [exported, setExported] = useState<Exported>({ status: "idle" });

  // The endpoint of the dataset's own space, found by space and never by position.
  const slug = config.endpoints?.find((candidate) => candidate.space === SPEC[dataset].space)?.slug ?? (config.space === SPEC[dataset].space ? config.slug : null);
  const source = useMemo(
    () => (slug ? endpointSource(slug, transportFor(config), language) : null),
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, language],
  );
  const grid = useMemo(() => (slug ? gridConfig(dataset, slug, s.column) : null), [dataset, slug, s.column]);

  const pick = (next: Dataset) => {
    setDataset(next);
    setExported({ status: "idle" });
  };

  const save = async () => {
    if (!source) return;
    setExported({ status: "running" });
    try {
      const result = await exportCsv(dataset, source, language.slice(0, 2));
      download(result.file, `zilina-${dataset}.csv`);
      setExported({ status: "done", rows: result.rows, truncated: result.truncated });
    } catch (cause) {
      setExported({ status: "failed", reason: cause instanceof SourceError || cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <main>
      <Page>
        <Header level={1} title={s.title} subtitle={s.subtitle} />
        <div className="screen">
          <nav aria-label={s.datasets}>
            <ul>
              {DATASETS.map((candidate) => (
                <li key={candidate}>
                  <button type="button" aria-current={candidate === dataset ? "true" : undefined} onClick={() => pick(candidate)}>
                    <span className="name">{s.name[candidate]}</span>
                    <span className="about">{s.about[candidate]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section className="dataset" aria-labelledby="dataset-title">
            <h2 id="dataset-title">{s.name[dataset]}</h2>
            <p className="about">{s.about[dataset]}</p>
            {source && grid ? (
              <>
                <div className="actions">
                  <button type="button" onClick={save} disabled={exported.status === "running"}>
                    {s.exportCsv}
                  </button>
                  <span role="status">
                    {exported.status === "running" && s.exporting}
                    {exported.status === "done" && (exported.truncated ? s.exportCut(exported.rows) : s.exported(exported.rows))}
                  </span>
                  {exported.status === "failed" && <span role="alert" className="failed">{s.exportFailed(exported.reason)}</span>}
                </div>
                <p className="note">{s.readOnly}</p>
                {/* A new key per dataset: the grid's filters and page belong to the dataset they were set on. */}
                <EntityGrid key={dataset} config={grid} source={source} labels={s.grid} />
              </>
            ) : (
              <p role="alert">{s.noEndpoint(s.name[dataset])}</p>
            )}
            <p className="source">{s.licence[dataset]}</p>
          </section>
        </div>
      </Page>
    </main>
  );
}
