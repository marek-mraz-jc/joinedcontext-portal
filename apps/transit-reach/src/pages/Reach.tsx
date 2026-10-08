import { useEffect, useMemo, useState } from "react";
import { Card, Page } from "@joinedcontext/sdk";
import { useAnalysis } from "../analysis";
import type { AnalysisOutput, StopOut } from "../analysis";
import { ReachMap } from "../components/ReachMap";
import { Loading } from "../components/states";
import { useHistory } from "../history";
import { decimal, moment, number, t } from "../i18n";
import type { Lang } from "../i18n";
import { reachColours } from "../theme";
import { CENTRE, HOURS, readView, toVehicles, writeView } from "../vehicles";
import type { Hours, ViewState } from "../vehicles";

const BANDS = [10, 20, 30];
const WAIT = 5;

/** The sentence that answers the page's question before anything is touched. */
export function summaryOf(lang: Lang, out: AnalysisOutput): string {
  const limit = out.bands[out.bands.length - 1];
  return t(lang, "summary", {
    bands: out.bands.map((b) => t(lang, "bandPhrase", { minutes: number(lang, b.minutes), area: decimal(lang, b.areaKm2) })).join(", "),
    limit: number(lang, limit?.minutes ?? 0),
    reached: number(lang, limit?.stops ?? 0),
    all: number(lang, out.stops.length),
  });
}

function routesOf(lang: Lang, stop: StopOut): string {
  return stop.routes.length > 0 ? stop.routes.join(", ") : t(lang, "noRoutes");
}

/**
 * How far one gets by transit from a point of Helsinki (T-3331): one sentence with the area reached
 * in 10, 20 and 30 minutes, the map of it (a click starts from there), the stops reached in time,
 * and what the answer rests on: stops derived from where the vehicles stood still. The point and
 * the history's hours are in the address.
 */
export function Reach({ lang }: { lang: Lang }) {
  const [view, setView] = useState<ViewState>(() => readView(window.location.search));
  useEffect(() => {
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${writeView(window.location.search, view)}${window.location.hash}`);
    } catch {
      // A sandboxed preview may refuse; the view still holds on the page.
    }
  }, [view]);

  const history = useHistory(view.hours, true);
  const vehicles = useMemo(() => toVehicles(history.history), [history.history]);
  const input = useMemo(
    () => (history.loading ? null : { vehicles, origin: view.at, bands: BANDS, wait: WAIT }),
    [history.loading, vehicles, view.at],
  );
  const { output, running, error: failed } = useAnalysis(input);
  const limit = BANDS[BANDS.length - 1];
  const reached = useMemo(
    () =>
      (output?.stops ?? [])
        .map((stop, index) => ({ stop, index }))
        .filter(({ stop }) => stop.minutes !== null)
        .sort((a, b) => (a.stop.minutes ?? 0) - (b.stop.minutes ?? 0)),
    [output],
  );
  // The legend's colours are the map's, for the scheme in force (the page is drawn again per scheme).
  const colours = reachColours();
  const bandColours = [colours.near, colours.mid, colours.far];
  const pickedStop = output?.stops.findIndex((s) => s.lon === view.at.lon && s.lat === view.at.lat) ?? -1;

  return (
    <Page label={t(lang, "page")}>
      {history.error && (
        <div className="jc-problem" role="alert">
          <strong>{t(lang, "historyUnreadable", { status: history.error.status })}</strong>
          <button type="button" className="jc-button" onClick={history.reload}>
            {t(lang, "retry")}
          </button>
        </div>
      )}
      {failed && (
        <div className="jc-problem" role="alert">
          <strong>{t(lang, "analysisFailed", { reason: failed.message })}</strong>
        </div>
      )}
      {output ? (
        <p className="app-summary" aria-live="polite">
          {summaryOf(lang, output)}
        </p>
      ) : history.loading ? (
        <Loading label={t(lang, "loading")} />
      ) : running ? (
        <Loading label={t(lang, "analysing")} />
      ) : null}
      {output && (
        <p className="app-note">
          {output.readings === 0 || output.first === null || output.last === null
            ? t(lang, "walkOnly")
            : t(lang, "derived", { vehicles: number(lang, output.vehicles), from: moment(lang, output.first), to: moment(lang, output.last), wait: number(lang, WAIT) })}
        </p>
      )}

      <form className="app-filters" aria-label={t(lang, "controls")} onSubmit={(event) => event.preventDefault()}>
        <label>
          <span>{t(lang, "hours")}</span>
          <select value={view.hours} onChange={(event) => setView({ ...view, hours: Number(event.target.value) as Hours })}>
            {HOURS.map((hours) => (
              <option key={hours} value={hours}>
                {t(lang, "hoursOption", { n: number(lang, hours) })}
              </option>
            ))}
          </select>
        </label>
        {output && output.stops.length > 0 && (
          <label>
            <span>{t(lang, "startStop")}</span>
            <select
              value={pickedStop >= 0 ? String(pickedStop) : ""}
              onChange={(event) => {
                const stop = output.stops[Number(event.target.value)];
                if (stop) setView({ ...view, at: { lon: stop.lon, lat: stop.lat } });
              }}
            >
              <option value="">{t(lang, "pickedPoint")}</option>
              {output.stops.map((stop, index) => (
                <option key={`${stop.lon},${stop.lat}`} value={index}>
                  {t(lang, "stopOption", { n: number(lang, index + 1), routes: routesOf(lang, stop) })}
                </option>
              ))}
            </select>
          </label>
        )}
        {(view.at.lon !== CENTRE.lon || view.at.lat !== CENTRE.lat) && (
          <button type="button" className="jc-button" onClick={() => setView({ ...view, at: CENTRE })}>
            {t(lang, "centre")}
          </button>
        )}
      </form>

      <Card title={t(lang, "map")}>
        <ReachMap
          cells={output?.cells ?? []}
          stops={output?.stops ?? []}
          origin={view.at}
          bands={BANDS}
          label={t(lang, "map")}
          describe={(stop, index) => [
            t(lang, "stopOption", { n: number(lang, index + 1), routes: routesOf(lang, stop) }),
            stop.minutes === null ? t(lang, "stopFar", { limit: number(lang, limit) }) : t(lang, "stopReached", { minutes: decimal(lang, stop.minutes) }),
          ]}
          onPick={(at) => setView((current) => ({ ...current, at: { lon: Number(at.lon.toFixed(5)), lat: Number(at.lat.toFixed(5)) } }))}
        />
        <ul className="app-legend" aria-label={t(lang, "legend")}>
          {BANDS.map((minutes, i) => (
            <li key={minutes}>
              <span className="app-swatch" style={{ background: bandColours[Math.min(i, 2)] }} aria-hidden="true" />
              {t(lang, "bandLegend", { minutes: number(lang, minutes) })}
            </li>
          ))}
          <li>
            <span className="app-swatch app-dot" style={{ background: colours.origin }} aria-hidden="true" />
            {t(lang, "start")}
          </li>
          <li>
            <span className="app-swatch app-dot" style={{ background: colours.stop }} aria-hidden="true" />
            {t(lang, "stopLegend")}
          </li>
        </ul>
      </Card>

      <Card title={t(lang, "reached", { limit: number(lang, limit) })}>
        {!output ? (
          history.loading ? <Loading label={t(lang, "loading")} /> : null
        ) : reached.length === 0 ? (
          <p className="app-note">{t(lang, "noReached", { limit: number(lang, limit) })}</p>
        ) : (
          <ol className="app-places" aria-label={t(lang, "reached", { limit: number(lang, limit) })}>
            {reached.map(({ stop, index }) => (
              <li key={index}>
                <button
                  type="button"
                  className="app-link"
                  aria-label={t(lang, "startFrom", { stop: t(lang, "stopOption", { n: number(lang, index + 1), routes: routesOf(lang, stop) }) })}
                  onClick={() => setView({ ...view, at: { lon: stop.lon, lat: stop.lat } })}
                >
                  {t(lang, "stopOption", { n: number(lang, index + 1), routes: routesOf(lang, stop) })}
                </button>
                <span>{t(lang, "stopReached", { minutes: decimal(lang, stop.minutes ?? 0) })}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </Page>
  );
}
