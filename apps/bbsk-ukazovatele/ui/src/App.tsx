/**
 * The indicators of the region and of the city, side by side (T-2308, AP-07, UI-15, UI-30).
 *
 * One section per publisher, because the whole point of the screen is that these are two bodies
 * and not one dataset: the region's ~600 000 inhabitants and the city's ~72 000 answer the same
 * question with numbers eight times apart, so every card names its territory and every section
 * names its publisher. An indicator both bodies published would appear once under each, never
 * merged.
 *
 * The two sections load independently. One publisher's endpoint being down leaves the other's
 * cards on screen and turns its own section into a sentence saying what failed — a dashboard
 * that blanks because one of two sources is unreachable tells a reader less than nothing.
 */
import { useEffect, useState } from "react";
import { endpointSource, SourceError, transportFor, useClient } from "@joinedcontext/sdk";
import type { JcEndpoint, RichRow } from "@joinedcontext/sdk";
import { byKey, toIndicator, unitAsContracted } from "./indicators";
import type { Body, Indicator, State } from "./indicators";
import { stringsFor } from "./locales";
import type { Strings } from "./locales";

/** The space each body publishes its indicators in (`Development/10` §2). */
const SPACE_OF: Record<Body, string> = {
  bbsk: "bbsk-kpi",
  banskabystrica: "banskabystrica-kpi",
};

const BODIES: Body[] = ["bbsk", "banskabystrica"];

/** One page is enough for the 31 indicators the contract declares, and caps a hostile answer. */
const LIMIT = 200;

type Load =
  | { status: "loading" }
  | { status: "ready"; indicators: Indicator[] }
  | { status: "failed"; reason: string }
  | { status: "unreachable" };

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);

  return (
    <main className="page">
      <h1>{s.title}</h1>
      <p className="subtitle">{s.subtitle}</p>
      {BODIES.map((body) => (
        <BodySection key={body} body={body} s={s} />
      ))}
    </main>
  );
}

/**
 * Reads one body's indicators through the endpoint the served configuration names for its space.
 *
 * The endpoint is found by space and never by position, so the application behaves the same
 * whether its own endpoint or the shared one is listed first, and a configuration that names only
 * one leaves the other body honestly marked unreachable instead of showing the wrong body's rows
 * under its heading.
 */
function useIndicators(body: Body): Load {
  const { config } = useClient();
  const [load, setLoad] = useState<Load>({ status: "loading" });

  const endpoints: JcEndpoint[] = config.endpoints ?? [];
  const endpoint = endpoints.find((candidate) => candidate.space === SPACE_OF[body]);
  const slug = endpoint?.slug;
  const language = config.language;

  useEffect(() => {
    if (!slug) {
      setLoad({ status: "unreachable" });
      return;
    }
    let live = true;
    setLoad({ status: "loading" });
    endpointSource(slug, transportFor(config), language)
      .query({ type: "KeyPerformanceIndicator" }, { offset: 0, limit: LIMIT })
      .then((page) => {
        if (!live) return;
        setLoad({ status: "ready", indicators: indicatorsOf(page.rows, body) });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setLoad({ status: "failed", reason: reasonOf(cause) });
      });
    return () => {
      live = false;
    };
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, language, body]);

  return load;
}

/**
 * The rows of one endpoint, as indicators of the body that endpoint belongs to.
 *
 * An entity whose own id says it belongs to the other body is dropped rather than shown: an
 * endpoint is only allowed to serve its own space, so such a row means something is wrong
 * upstream, and putting it under this heading would be the exact confusion this screen exists to
 * prevent.
 */
export function indicatorsOf(rows: RichRow[], body: Body): Indicator[] {
  return rows
    .map(toIndicator)
    .filter((indicator): indicator is Indicator => indicator !== null && indicator.body === body);
}

function reasonOf(cause: unknown): string {
  if (cause instanceof SourceError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

function BodySection({ body, s }: { body: Body; s: Strings }) {
  const load = useIndicators(body);
  const headingId = `body-${body}`;

  return (
    <section className="body" aria-labelledby={headingId}>
      <h2 id={headingId}>{s.body[body]}</h2>
      <p className="note">{s.bodyNote[body]}</p>
      {load.status === "loading" && <p role="status">{s.loading}</p>}
      {load.status === "unreachable" && <p role="status">{s.noEndpoint}</p>}
      {load.status === "failed" && (
        <p role="alert" className="failed">
          {s.unavailable} {s.unavailableWhy}: {load.reason}
        </p>
      )}
      {load.status === "ready" && load.indicators.length === 0 && <p role="status">{s.empty}</p>}
      {load.status === "ready" &&
        byKey(load.indicators).map((group) => (
          <Group key={group.key} groupKey={group.key} rows={group.rows} s={s} body={body} />
        ))}
    </section>
  );
}

function Group({
  groupKey,
  rows,
  s,
  body,
}: {
  groupKey: string;
  rows: Indicator[];
  s: Strings;
  body: Body;
}) {
  const headingId = `group-${body}-${groupKey}`;
  const title = s.indicator[groupKey]?.title ?? groupKey;
  return (
    <section className="group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      <ul className="cards">
        {rows.map((indicator) => (
          <li key={indicator.id}>
            <Card indicator={indicator} s={s} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One indicator. Everything a reader needs to place the number is on the card and not in a
 * legend: whose it is, what it is measured in, the window it covers and when it was computed.
 */
function Card({ indicator, s }: { indicator: Indicator; s: Strings }) {
  const territory = s.territory[indicator.territory] ?? indicator.territory;
  const unit = s.indicator[indicator.key]?.unit;
  const contracted = unitAsContracted(indicator);
  const headingId = `card-${indicator.id}`;

  return (
    <article className="card" aria-labelledby={headingId}>
      <h4 id={headingId} className="territory">
        {territory}
      </h4>

      {indicator.value === null ? (
        <p className="value not-measured">
          <span className="reading">{s.notMeasured}</span>
          <span className="why">{s.notMeasuredWhy}</span>
        </p>
      ) : (
        <p className="value">
          <span className="reading">
            {number(indicator.value, s)}
            {/* The unit is read with the number, not left to a column heading. */}
            <span className="unit">
              {" "}
              {contracted && unit ? unit : (indicator.unitCode ?? "")}
            </span>
          </span>
          {!contracted && indicator.unitCode && (
            <span className="why">
              {s.rawUnit}: {indicator.unitCode}
            </span>
          )}
        </p>
      )}

      {indicator.state && <StateBadge state={indicator.state} s={s} />}

      <dl className="facts">
        {indicator.period && (
          <>
            <dt>{s.window}</dt>
            <dd>
              <time dateTime={indicator.period.start}>{day(indicator.period.start, s)}</time> –{" "}
              <time dateTime={indicator.period.end}>{day(indicator.period.end, s)}</time>
            </dd>
          </>
        )}
        {indicator.updatedAt && (
          <>
            <dt>{s.computedAt}</dt>
            <dd>
              <time dateTime={indicator.updatedAt}>{moment(indicator.updatedAt, s)}</time>
            </dd>
          </>
        )}
        {indicator.formula && (
          <>
            <dt>{s.formula}</dt>
            <dd className="formula">{indicator.formula}</dd>
          </>
        )}
      </dl>
    </article>
  );
}

/** The shape beside the word, so the state is never carried by colour alone (UI-30). */
const SHAPE: Record<State, string> = { green: "●", amber: "▲", red: "■" };

function StateBadge({ state, s }: { state: State; s: Strings }) {
  return (
    <p className={`state state-${state}`}>
      <span aria-hidden="true" className="shape">
        {SHAPE[state]}
      </span>{" "}
      <span>
        {s.stateOf}: {s.state[state]}
      </span>
    </p>
  );
}

function number(value: number, s: Strings): string {
  return new Intl.NumberFormat(s.locale, { maximumFractionDigits: 2 }).format(value);
}

function day(iso: string, s: Strings): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(s.locale, { dateStyle: "medium" }).format(at);
}

function moment(iso: string, s: Strings): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat(s.locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}
