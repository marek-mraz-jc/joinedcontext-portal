/**
 * Prague right now (T-2917, AP-07, AP-14): the city's shared bikes, park-and-ride car parks and
 * air quality, read live from the praha-mesto space through this app's own endpoint with the
 * reader's own token. Each section loads on its own, so one type failing leaves the others on
 * screen and says what failed in its own place.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { endpointSource, Header, mapColors, Page, SourceError, transportFor, useClient } from "@joinedcontext/sdk";
import type { RichRow } from "@joinedcontext/sdk";
import {
  BIKE_STEPS,
  bikeHistogram,
  bikePoints,
  bikeTotals,
  histogramBars,
  legendOf,
  matching,
  POLLUTANTS,
  stepLabels,
  toAirStation,
  toBikeStation,
  toCarPark,
} from "./praha";
import type { AirStation, BikeStation, CarPark } from "./praha";
import { stringsFor } from "./locales";
import type { Strings } from "./locales";
import { Chart } from "./Chart";
import { StationMap } from "./StationMap";

const SPACE = "praha-mesto";
/** One request's worth of rows, and how many requests a type may take (1580 stations in 2026). */
const PAGE = 500;
const MAX_PAGES = 10;
/** Rows a list shows before the search narrows it. */
const SHOWN = 50;

type Load<T> = { status: "loading" } | { status: "ready"; rows: T[] } | { status: "failed"; reason: string } | { status: "unreachable" };

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  return (
    <main>
      <Page>
        <Header level={1} title={s.title} subtitle={s.subtitle} />
        <Bikes s={s} />
        <Parking s={s} />
        <Air s={s} />
        <p className="note source">{s.source}</p>
      </Page>
    </main>
  );
}

/** Every row of `type` in the space, page by page, parsed by `parse`; a row it refuses is left out. */
function useRows<T>(type: string, parse: (row: RichRow, language: string) => T | null): Load<T> {
  const { config } = useClient();
  const [load, setLoad] = useState<Load<T>>({ status: "loading" });
  const slug = (config.endpoints ?? []).find((endpoint) => endpoint.space === SPACE)?.slug;
  const language = config.language ?? "cs";

  useEffect(() => {
    if (!slug) {
      setLoad({ status: "unreachable" });
      return;
    }
    let live = true;
    setLoad({ status: "loading" });
    const source = endpointSource(slug, transportFor(config), language);
    (async () => {
      const rows: T[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const answer = await source.query({ type }, { offset: page * PAGE, limit: PAGE });
        for (const row of answer.rows) {
          const parsed = parse(row, language);
          if (parsed !== null) rows.push(parsed);
        }
        if (answer.rows.length < PAGE) break;
      }
      return rows;
    })()
      .then((rows) => live && setLoad({ status: "ready", rows }))
      .catch((cause: unknown) => live && setLoad({ status: "failed", reason: reasonOf(cause) }));
    return () => {
      live = false;
    };
    // `config` is served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, language, type]);

  return load;
}

function reasonOf(cause: unknown): string {
  if (cause instanceof SourceError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** The loading, unreachable, failed and empty states every section shares; `null` once there are rows. */
function Status<T>({ load, s }: { load: Load<T>; s: Strings }) {
  if (load.status === "loading") return <p role="status">{s.loading}</p>;
  if (load.status === "unreachable") return <p role="status">{s.noEndpoint}</p>;
  if (load.status === "failed")
    return (
      <p role="alert" className="failed">
        {s.unavailable}: {load.reason}
      </p>
    );
  if (load.rows.length === 0) return <p role="status">{s.empty}</p>;
  return null;
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="note">{note}</p>
      {children}
    </section>
  );
}

function Bikes({ s }: { s: Strings }) {
  const load = useRows<BikeStation>("BikeHireDockingStation", toBikeStation);
  const [search, setSearch] = useState("");
  const searchId = useId();
  return (
    <Section title={s.bikes.title} note={s.bikes.note}>
      <Status load={load} s={s} />
      {load.status === "ready" && load.rows.length > 0 && (
        <>
          <Totals stations={load.rows} s={s} />
          <div className="panels">
            <StationMap
              points={bikePoints(load.rows)}
              steps={BIKE_STEPS}
              label={s.bikes.map}
              legendTitle={s.bikes.legend}
              noMap={s.noMap}
            />
            <BikeHistogram stations={load.rows} s={s} />
          </div>
          <label htmlFor={searchId} className="search">
            {s.search}
          </label>
          <input id={searchId} type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          <BikeList stations={matching(load.rows, search, s.locale)} total={load.rows.length} s={s} />
        </>
      )}
    </Section>
  );
}

function Totals({ stations, s }: { stations: BikeStation[]; s: Strings }) {
  const totals = bikeTotals(stations);
  const figures: [number, string][] = [
    [totals.bikes, s.bikes.bikes],
    [totals.docks, s.bikes.docks],
    [totals.working, s.bikes.working],
    [totals.stations, s.bikes.stations],
  ];
  return (
    <ul className="totals">
      {figures.map(([value, label]) => (
        <li key={label}>
          <span className="figure">{number(value, s)}</span> <span className="label">{label}</span>
        </li>
      ))}
    </ul>
  );
}

function BikeHistogram({ stations, s }: { stations: BikeStation[]; s: Strings }) {
  const counts = bikeHistogram(stations);
  const labels = stepLabels(BIKE_STEPS);
  const option = useMemo(
    () => ({
      grid: { left: 48, right: 16, top: 16, bottom: 40 },
      xAxis: { type: "category", data: labels, name: s.bikes.legend, nameLocation: "middle", nameGap: 28 },
      yAxis: { type: "value", name: s.bikes.histogramAxis },
      tooltip: { trigger: "axis" },
      // The map's legend colours, step for step, so one step is one colour on the whole screen.
      series: [{ type: "bar", data: histogramBars(counts, legendOf(BIKE_STEPS, mapColors().low, mapColors().high)) }],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [counts.join(","), s],
  );
  const said = labels.map((label, i) => `${label}: ${counts[i]}`).join(", ");
  return <Chart option={option} label={s.bikes.histogram(said)} />;
}

function BikeList({ stations, total, s }: { stations: BikeStation[]; total: number; s: Strings }) {
  const shown = stations.slice(0, SHOWN);
  return (
    <>
      <p className="note" aria-live="polite">
        {s.shown(shown.length, total)}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{s.station}</th>
              <th scope="col" className="num">
                {s.bikes.bikes}
              </th>
              <th scope="col" className="num">
                {s.bikes.docks}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((station) => (
              <tr key={station.id}>
                <th scope="row">
                  {station.name}
                  {!station.working && <span className="off"> ({s.outOfService})</span>}
                </th>
                <td className="num">{station.bikes === null ? "–" : number(station.bikes, s)}</td>
                <td className="num">{station.docks === null ? "–" : number(station.docks, s)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Parking({ s }: { s: Strings }) {
  const load = useRows<CarPark>("OffStreetParking", toCarPark);
  return (
    <Section title={s.parking.title} note={s.parking.note}>
      <Status load={load} s={s} />
      {load.status === "ready" && load.rows.length > 0 && <ParkingChart parks={load.rows} s={s} />}
      {load.status === "ready" && load.rows.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{s.carPark}</th>
                <th scope="col" className="num">
                  {s.parking.capacity}
                </th>
                <th scope="col" className="num">
                  {s.parking.free}
                </th>
                <th scope="col" className="num">
                  {s.parking.occupied}
                </th>
                <th scope="col">{s.reported}</th>
              </tr>
            </thead>
            <tbody>
              {matching(load.rows, "", s.locale).map((park) => (
                <tr key={park.id}>
                  <th scope="row">{park.name}</th>
                  <td className="num">{park.capacity === null ? "–" : number(park.capacity, s)}</td>
                  {park.free === null && park.occupied === null ? (
                    <td colSpan={2} className="off">
                      {s.parking.noLive}
                    </td>
                  ) : (
                    <>
                      <td className="num">{park.free === null ? "–" : number(park.free, s)}</td>
                      <td className="num">{park.occupied === null ? "–" : number(park.occupied, s)}</td>
                    </>
                  )}
                  <td>{park.reportedAt ? <time dateTime={park.reportedAt}>{moment(park.reportedAt, s)}</time> : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function ParkingChart({ parks, s }: { parks: CarPark[]; s: Strings }) {
  const sorted = useMemo(() => matching(parks, "", s.locale), [parks, s.locale]);
  const option = useMemo(() => {
    const counted = (park: CarPark) => park.free !== null || park.occupied !== null;
    return {
      grid: { left: 150, right: 16, top: 32, bottom: 24 },
      legend: { top: 0 },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      xAxis: { type: "value" },
      yAxis: { type: "category", data: sorted.map((park) => park.name), axisLabel: { width: 140, overflow: "truncate" } },
      series: [
        { name: s.parking.occupied, type: "bar", stack: "p", data: sorted.map((park) => (counted(park) ? park.occupied : null)) },
        { name: s.parking.free, type: "bar", stack: "p", data: sorted.map((park) => (counted(park) ? park.free : null)) },
        { name: s.parking.capacity, type: "bar", stack: "p", data: sorted.map((park) => (counted(park) ? null : park.capacity)) },
      ],
    };
  }, [sorted, s]);
  return <Chart option={option} label={s.parking.chart(parks.length)} height={Math.max(220, sorted.length * 22 + 60)} />;
}

function AirChart({ stations, s }: { stations: AirStation[]; s: Strings }) {
  const sorted = useMemo(() => matching(stations, "", s.locale), [stations, s.locale]);
  const option = useMemo(
    () => ({
      grid: { left: 48, right: 16, top: 32, bottom: 96 },
      legend: { top: 0 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: sorted.map((station) => station.name), axisLabel: { rotate: 40, width: 120, overflow: "truncate" } },
      yAxis: { type: "value", name: s.air.unit },
      series: POLLUTANTS.map((pollutant) => ({
        name: s.pollutant[pollutant],
        type: "bar",
        data: sorted.map((station) => station.readings[pollutant]?.value ?? null),
      })),
    }),
    [sorted, s],
  );
  return <Chart option={option} label={s.air.chart(stations.length)} height={320} />;
}

function Air({ s }: { s: Strings }) {
  const load = useRows<AirStation>("AirQualityObserved", toAirStation);
  return (
    <Section title={s.air.title} note={s.air.note}>
      <Status load={load} s={s} />
      {load.status === "ready" && load.rows.length > 0 && <AirChart stations={load.rows} s={s} />}
      {load.status === "ready" && load.rows.length > 0 && (
        <div className="scroll">
          <table>
            <caption className="note">{s.air.unit}</caption>
            <thead>
              <tr>
                <th scope="col">{s.air.station}</th>
                {POLLUTANTS.map((pollutant) => (
                  <th key={pollutant} scope="col" className="num">
                    {s.pollutant[pollutant]}
                  </th>
                ))}
                <th scope="col">{s.reported}</th>
              </tr>
            </thead>
            <tbody>
              {matching(load.rows, "", s.locale).map((station) => {
                const at = POLLUTANTS.map((pollutant) => station.readings[pollutant]?.at).find(Boolean);
                return (
                  <tr key={station.id}>
                    <th scope="row">{station.name}</th>
                    {POLLUTANTS.map((pollutant) => {
                      const reading = station.readings[pollutant];
                      return (
                        <td key={pollutant} className="num">
                          {reading ? number(reading.value, s) : "–"}
                        </td>
                      );
                    })}
                    <td>{at ? <time dateTime={at}>{moment(at, s)}</time> : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function number(value: number, s: Strings): string {
  return new Intl.NumberFormat(s.locale, { maximumFractionDigits: 1 }).format(value);
}

function moment(iso: string, s: Strings): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(s.locale, { dateStyle: "short", timeStyle: "short" }).format(at);
}
