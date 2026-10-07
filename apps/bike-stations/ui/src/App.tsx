/**
 * The mobility project's city bike stations (T-3185, AP-04, AP-14, UI-15, UI-30): every HSL docking
 * station with its free bikes and free docks, read through the project's shared space reference
 * `city-bikes`, which names the helsinki project's public `helsinki-bikes` endpoint. The application
 * reads and never writes, and holds no token of its own (AP-28).
 *
 * A map is not readable by a screen reader or a keyboard, so the same stations are a list beside
 * it; the list is the screen and the map is the picture of it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { endpointSource, Header, Page, SourceError, styleFor, transportFor, useClient } from "@joinedcontext/sdk";
import { byName, featuresOf, matches, STANDING_COLOUR, STANDING_SHAPE, standingOf, stationOf, totals, TYPE } from "./stations";
import type { Station } from "./stations";
import { stringsFor } from "./locales";
import type { Strings } from "./locales";

/** The space the shared stations live in: the helsinki project's, through `city-bikes`. */
const SHARED_SPACE = "helsinki";
/** One request's page, and the most stations the map holds; Helsinki has about 460. */
const PAGE = 200;
export const MOST = 2000;
/** The centre of Helsinki, where the map opens. */
const CENTRE: [number, number] = [24.9384, 60.1699];
const SOURCE_ID = "stations";

type Load =
  | { status: "loading" }
  | { status: "ready"; stations: Station[]; truncated: boolean }
  | { status: "failed"; reason: string };

/** The endpoint of the shared stations, found by its space and never by position (AP-04). */
function useStationsSlug(): string | null {
  const { config } = useClient();
  return config.endpoints?.find((candidate) => candidate.space === SHARED_SPACE)?.slug ?? null;
}

function reasonOf(cause: unknown): string {
  if (cause instanceof SourceError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export function useStations(): Load | null {
  const { config } = useClient();
  const slug = useStationsSlug();
  const language = config.language ?? "en";
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    if (!slug) return;
    let live = true;
    setLoad({ status: "loading" });
    const source = endpointSource(slug, transportFor(config), language);
    (async (): Promise<Load> => {
      const stations: Station[] = [];
      for (let offset = 0; offset < MOST; offset += PAGE) {
        const page = await source.query({ type: TYPE }, { offset, limit: PAGE });
        stations.push(...page.rows.map((row) => stationOf(row, language.slice(0, 2))));
        if (page.rows.length < PAGE) return { status: "ready", stations, truncated: false };
      }
      return { status: "ready", stations, truncated: true };
    })()
      .catch((cause: unknown): Load => ({ status: "failed", reason: reasonOf(cause) }))
      .then((next) => {
        if (live) setLoad(next);
      });
    return () => {
      live = false;
    };
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, language]);

  return slug ? load : null;
}

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const load = useStations();
  const [search, setSearch] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const all = useMemo(() => (load?.status === "ready" ? load.stations : []), [load]);
  const visible = useMemo(() => all.filter((station) => matches(station, search)).sort(byName), [all, search]);
  const picked = visible.find((station) => station.id === pickedId) ?? null;
  const sum = totals(all);

  const close = () => {
    const id = pickedId;
    setPickedId(null);
    // Focus goes back to the station in the list the person came from, never to the top.
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-id]") ?? [];
      Array.from(items).find((item) => item.dataset.id === id)?.focus();
    });
  };

  return (
    <main>
      <Page>
        <Header level={1} title={s.title} subtitle={s.subtitle} />

        {load === null && <p role="status">{s.noEndpoint}</p>}
        {load?.status === "loading" && <p role="status">{s.loading}</p>}
        {load?.status === "failed" && (
          <p role="alert" className="failed">
            {s.refused(load.reason)}
          </p>
        )}
        {load?.status === "ready" && (
          <>
            <p className="totals" role="status">
              {s.totals(all.length, sum.bikes, sum.docks)}
            </p>
            {load.truncated && <p className="note">{s.truncated(MOST)}</p>}
            <div className="controls">
              <div className="search">
                <label htmlFor="search">{s.search}</label>
                <input
                  id="search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  aria-describedby="search-help"
                />
                <small id="search-help">{s.searchHelp}</small>
              </div>
              <ul className="legend" aria-label={s.status}>
                {(["available", "empty", "full", "unknown"] as const).map((standing) => (
                  <li key={standing}>
                    <span aria-hidden="true" className="shape" style={{ color: STANDING_COLOUR[standing] }}>
                      {STANDING_SHAPE[standing]}
                    </span>
                    {s.standing[standing]}
                  </li>
                ))}
              </ul>
            </div>

            <div className="map-screen">
              <StationMap stations={visible} picked={pickedId} onPick={setPickedId} s={s} />
              <div className="side">
                {picked ? <StationSheet station={picked} onClose={close} s={s} /> : null}
                <section className="results" aria-labelledby="results-heading">
                  <h2 id="results-heading">{s.results(visible.length)}</h2>
                  {visible.length === 0 ? <p>{s.noResults}</p> : null}
                  <ul ref={listRef}>
                    {visible.map((station) => {
                      const standing = standingOf(station);
                      return (
                        <li key={station.id}>
                          <button
                            type="button"
                            data-id={station.id}
                            aria-pressed={station.id === pickedId}
                            onClick={() => setPickedId(station.id)}
                          >
                            <span aria-hidden="true" className="shape" style={{ color: STANDING_COLOUR[standing] }}>
                              {STANDING_SHAPE[standing]}
                            </span>
                            <span className="name">{station.name ?? s.unnamed}</span>
                            <span className="sub">
                              {s.bikesAndDocks(station.bikes, station.docks)} · {s.standing[standing]}
                              {station.coordinates === null ? ` · ${s.notOnMap}` : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>
            </div>
          </>
        )}

        <p className="source">{s.attribution}</p>
      </Page>
    </main>
  );
}

function StationMap({
  stations,
  picked,
  onPick,
  s,
}: {
  stations: Station[];
  picked: string | null;
  onPick: (id: string) => void;
  s: Strings;
}) {
  // The basemap is the platform's, named in the document the Portal served (AP-67, AP-12).
  const { basemap } = useClient().config;
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const collection = useMemo(() => featuresOf(stations, picked), [stations, picked]);
  const latest = useRef(collection);
  latest.current = collection;

  useEffect(() => {
    if (!holder.current || map.current) return;
    const drawn = new MapLibreMap({ container: holder.current, style: styleFor(basemap), center: CENTRE, zoom: 12 });
    drawn.on("load", () => {
      ready.current = true;
      drawn.addSource(SOURCE_ID, { type: "geojson", data: latest.current });
      drawn.addLayer({
        id: SOURCE_ID,
        type: "circle",
        source: SOURCE_ID,
        paint: {
          "circle-radius": ["case", ["get", "picked"], 10, 6],
          "circle-color": ["get", "colour"],
          "circle-stroke-width": ["case", ["get", "picked"], 3, 1.5],
          "circle-stroke-color": "#ffffff",
        },
      });
    });
    drawn.on("click", SOURCE_ID, (event: { features?: Array<{ properties?: Record<string, unknown> }> }) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === "string") onPick(id);
    });
    map.current = drawn;
    return () => {
      drawn.remove();
      map.current = null;
      ready.current = false;
    };
    // The map is built once; the effect below keeps its data current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!map.current || !ready.current) return;
    (map.current.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(collection);
  }, [collection]);

  return (
    <div className="jc-map">
      <div className="jc-map-canvas" ref={holder} data-testid="jc-map" role="application" aria-label={s.mapLabel} />
      {!basemap && <p className="jc-map-notice">{s.noBasemap}</p>}
    </div>
  );
}

/** One station whole: a bottom sheet on a phone, a panel beside the list on a wider screen. */
function StationSheet({ station, onClose, s }: { station: Station; onClose: () => void; s: Strings }) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [station.id]);
  const name = station.name ?? s.unnamed;
  const standing = standingOf(station);
  const shown = (value: number | null) => (value === null ? s.noValue : String(value));
  return (
    <section
      className="sheet"
      aria-labelledby="sheet-heading"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="sheet-head">
        <h2 id="sheet-heading" ref={heading} tabIndex={-1}>
          {s.detailOf(name)}
        </h2>
        <button type="button" onClick={onClose}>
          {s.close}
        </button>
      </div>
      <p className="sub">
        <span aria-hidden="true" style={{ color: STANDING_COLOUR[standing] }}>
          {STANDING_SHAPE[standing]}
        </span>{" "}
        {s.standing[standing]}
      </p>
      <dl>
        <dt>{s.freeBikes}</dt>
        <dd>{shown(station.bikes)}</dd>
        <dt>{s.freeDocks}</dt>
        <dd>{shown(station.docks)}</dd>
        <dt>{s.capacity}</dt>
        <dd>{shown(station.capacity)}</dd>
        <dt>{s.status}</dt>
        <dd>{station.status ?? s.noValue}</dd>
        <dt>{s.updated}</dt>
        <dd>{station.updatedAt ? moment(station.updatedAt, s) : s.noValue}</dd>
      </dl>
    </section>
  );
}

function moment(iso: string, s: Strings): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat(s.locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}
