/**
 * The city's indicators (T-3140, PF-54, PF-55, AP-07, UI-30): the six numbers of `Development/13`,
 * read from the public space `zilina-kpi` through its public endpoint, so the bundle holds no token
 * and never asks anybody to sign in (AP-28).
 *
 * Its own look (T-2779): the population is the headline, the five others a grid of cards under
 * it; every card says its window and how it was computed. None has a published limit, so no
 * card has a colour that judges it (`Development/13` §3).
 */
import { useEffect, useState } from "react";
import { endpointSource, Header, Page, SourceError, transportFor, useClient } from "@joinedcontext/sdk";
import { KEYS, toIndicator, windowOf } from "./indicators";
import type { Indicator } from "./indicators";
import { stringsFor } from "./locales";
import type { Strings } from "./locales";

const SPACE = "zilina-kpi";

type Loaded = { status: "loading" } | { status: "ready"; indicators: Indicator[] } | { status: "failed"; reason: string };

function useIndicators(): Loaded | null {
  const { config } = useClient();
  const slug = config.endpoints?.find((candidate) => candidate.space === SPACE)?.slug ?? (config.space === SPACE ? config.slug : null);
  const language = config.language ?? "sk";
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    if (!slug) return;
    let live = true;
    setLoaded({ status: "loading" });
    endpointSource(slug, transportFor(config), language)
      .query({ type: "KeyPerformanceIndicator" }, { offset: 0, limit: 100 })
      .then((page): Loaded => {
        const found = page.rows.map(toIndicator).filter((indicator): indicator is Indicator => indicator !== null);
        found.sort((a, b) => KEYS.indexOf(a.key) - KEYS.indexOf(b.key));
        return { status: "ready", indicators: found };
      })
      .catch((cause: unknown): Loaded => ({
        status: "failed",
        reason: cause instanceof SourceError || cause instanceof Error ? cause.message : String(cause),
      }))
      .then((next) => {
        if (live) setLoaded(next);
      });
    return () => {
      live = false;
    };
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, language]);

  return slug ? loaded : null;
}

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const loaded = useIndicators();

  return (
    <main>
      <Page>
        <Header level={1} title={s.title} subtitle={s.subtitle} />
        {loaded === null && <p role="status">{s.noEndpoint}</p>}
        {loaded?.status === "loading" && <p role="status">{s.loading}</p>}
        {loaded?.status === "failed" && <p role="alert" className="failed">{s.refused(loaded.reason)}</p>}
        {loaded?.status === "ready" && loaded.indicators.length === 0 && <p>{s.none}</p>}
        {loaded?.status === "ready" && loaded.indicators.length > 0 && (
          <>
            <ul className="cards">
              {loaded.indicators.map((indicator, index) => (
                <li key={indicator.id} className={index === 0 && indicator.key === "obyvatelstvo-stav" ? "headline" : undefined}>
                  <Card indicator={indicator} s={s} />
                </li>
              ))}
            </ul>
            <p className="note">{s.noThreshold}</p>
          </>
        )}
        <p className="source">{s.attribution}</p>
      </Page>
    </main>
  );
}

function Card({ indicator, s }: { indicator: Indicator; s: Strings }) {
  const id = `card-${indicator.key}`;
  const window = indicator.period ? windowOf(indicator.period) : null;
  return (
    <article className="card" aria-labelledby={id}>
      <h2 id={id}>{s.label[indicator.key]}</h2>
      <p className="value">
        {indicator.value === null ? (
          <span className="missing">{s.notMeasured}</span>
        ) : (
          <>
            <data value={indicator.value}>{new Intl.NumberFormat(s.locale, { maximumFractionDigits: 2 }).format(indicator.value)}</data>{" "}
            <span className="unit">{indicator.unitAsDefined ? s.unit[indicator.key] : indicator.unitCode}</span>
          </>
        )}
      </p>
      <p className="question">{s.question[indicator.key]}</p>
      {window && (
        <p className="window">
          {s.window}:{" "}
          {window.kind === "quarter" ? s.quarter(window.label) : window.kind === "year" ? s.year(window.label) : window.label}
        </p>
      )}
      <details>
        <summary>{s.formula}</summary>
        <p>{indicator.formula}</p>
        {indicator.updatedAt && <p className="computed">{s.computed(moment(indicator.updatedAt, s))}</p>}
      </details>
    </article>
  );
}

function moment(iso: string, s: Strings): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat(s.locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Bratislava" }).format(at);
}
