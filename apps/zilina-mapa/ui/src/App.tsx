/**
 * The city's map for its residents (T-3140, AP-07, AP-14, UI-15, UI-30): the national cultural
 * monuments placed at their buildings, the railway stations with the trains leaving them today and
 * the air-quality station, read from the public space `zilina-verejne` through its public
 * endpoint, so the bundle holds no token and never asks anybody to sign in (AP-28).
 *
 * A map is not readable by a screen reader or a keyboard, so the same places are a list; the list
 * is the screen and the map is the picture of it. Its own look (T-2779): the list is the left
 * column with the search above it, one kind or all of them at a time, and a picked place opens as
 * a card over the map. Each kind loads on its own: one the endpoint refuses is a sentence saying
 * why, and the others stay.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { endpointSource, Header, Page, SourceError, styleFor, transportFor, useClient } from "@joinedcontext/sdk";
import type { EntitySource } from "@joinedcontext/sdk";
import { byOrder, featuresOf, KIND_COLOUR, KIND_SHAPE, KINDS, matches, placeOf, POLLUTANTS, TYPE_OF } from "./places";
import type { Kind, Place } from "./places";
import { stringsFor } from "./locales";
import type { Strings } from "./locales";

/** The space this application reads. */
const SPACE = "zilina-verejne";
/** One request's page, and the most of one kind the map holds: a list a person reads, not a dump. */
const PAGE = 200;
export const MOST = 1000;
/** The centre of Žilina, where the map opens. */
const CENTRE: [number, number] = [18.7394, 49.2231];
const SOURCE_ID = "places";

type Layer =
  | { status: "loading" }
  | { status: "ready"; places: Place[]; truncated: boolean }
  | { status: "failed"; reason: string };

type Shown = Kind | "all";

function useEndpointSlug(): string | null {
  const { config } = useClient();
  const listed = config.endpoints?.find((candidate) => candidate.space === SPACE)?.slug;
  return listed ?? (config.space === SPACE ? config.slug : null) ?? null;
}

function reasonOf(cause: unknown): string {
  if (cause instanceof SourceError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every place of one kind, page by page up to `MOST`. */
async function loadKind(source: EntitySource, kind: Kind, locale: string): Promise<Layer> {
  const places: Place[] = [];
  for (let offset = 0; offset < MOST; offset += PAGE) {
    const page = await source.query({ type: TYPE_OF[kind] }, { offset, limit: PAGE });
    places.push(...page.rows.map((row) => placeOf(row, kind, locale)));
    if (page.rows.length < PAGE) return { status: "ready", places, truncated: false };
  }
  return { status: "ready", places, truncated: true };
}

export function useLayers(): { layers: Record<Kind, Layer> | null } {
  const { config } = useClient();
  const slug = useEndpointSlug();
  const language = config.language ?? "sk";
  const [layers, setLayers] = useState<Record<Kind, Layer> | null>(null);
  const source = useMemo(
    () => (slug ? endpointSource(slug, transportFor(config), language) : null),
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, language],
  );

  useEffect(() => {
    if (!source) return;
    let live = true;
    setLayers({ monument: { status: "loading" }, station: { status: "loading" }, air: { status: "loading" } });
    for (const kind of KINDS) {
      loadKind(source, kind, language.slice(0, 2))
        .catch((cause: unknown): Layer => ({ status: "failed", reason: reasonOf(cause) }))
        .then((layer) => {
          if (live) setLayers((before) => (before ? { ...before, [kind]: layer } : before));
        });
    }
    return () => {
      live = false;
    };
  }, [source, language]);

  return { layers: source ? layers : null };
}

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const { layers } = useLayers();
  const [shown, setShown] = useState<Shown>("all");
  const [search, setSearch] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const all = useMemo(
    () => KINDS.flatMap((kind) => (layers?.[kind].status === "ready" ? layers[kind].places : [])),
    [layers],
  );
  const visible = useMemo(
    () =>
      all
        .filter((place) => shown === "all" || place.kind === shown)
        .filter((place) => matches(place, search))
        .sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || byOrder(a, b)),
    [all, shown, search],
  );
  const picked = visible.find((place) => place.id === pickedId) ?? null;

  const close = () => {
    const id = pickedId;
    setPickedId(null);
    // Focus goes back to the place in the list the person came from, never to the top of the page.
    requestAnimationFrame(() => {
      const items = listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-id]") ?? [];
      Array.from(items).find((item) => item.dataset.id === id)?.focus();
    });
  };

  const loading = layers !== null && KINDS.some((kind) => layers[kind].status === "loading");
  const count = (kind: Kind) => (layers?.[kind].status === "ready" ? (layers[kind] as { places: Place[] }).places.length : null);

  return (
    <main>
      <Page>
        <Header level={1} title={s.title} subtitle={s.subtitle} />

        {layers === null && <p role="status">{s.noEndpoint}</p>}
        {layers !== null && (
          <>
            {loading && <p role="status">{s.loading}</p>}
            {KINDS.map((kind) => {
              const layer = layers[kind];
              if (layer.status === "failed") {
                return (
                  <p key={kind} role="alert" className="failed">
                    {s.refused(s.kind[kind], layer.reason)}
                  </p>
                );
              }
              if (layer.status === "ready" && layer.truncated) {
                return (
                  <p key={kind} className="note">
                    {s.truncated(s.kind[kind], MOST)}
                  </p>
                );
              }
              return null;
            })}

            <div className="screen">
              <div className="list-column">
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
                <fieldset className="kinds">
                  <legend>{s.show}</legend>
                  {(["all", ...KINDS] as Shown[]).map((kind) => {
                    const n = kind === "all" ? null : count(kind);
                    return (
                      <label key={kind} className="kind" data-checked={shown === kind}>
                        <input type="radio" name="kind" checked={shown === kind} onChange={() => setShown(kind)} />
                        {kind !== "all" && (
                          <span aria-hidden="true" className="shape" style={{ color: KIND_COLOUR[kind] }}>
                            {KIND_SHAPE[kind]}
                          </span>
                        )}
                        <span>
                          {kind === "all" ? s.all : s.kind[kind]}
                          {n !== null ? ` (${n})` : ""}
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
                <section className="results" aria-labelledby="results-heading">
                  <h2 id="results-heading">{s.results(visible.length)}</h2>
                  {!loading && visible.length === 0 ? <p>{s.noResults}</p> : null}
                  <ul ref={listRef}>
                    {visible.map((place) => (
                      <li key={place.id}>
                        <button
                          type="button"
                          data-id={place.id}
                          aria-pressed={place.id === pickedId}
                          onClick={() => setPickedId(place.id)}
                        >
                          <span aria-hidden="true" className="shape" style={{ color: KIND_COLOUR[place.kind] }}>
                            {KIND_SHAPE[place.kind]}
                          </span>
                          <span className="name">{place.name ?? s.unnamed}</span>
                          <span className="sub">{summary(place, s)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
              <div className="map-column">
                <PlaceMap places={visible} picked={pickedId} onPick={setPickedId} s={s} />
                {picked ? <PlaceSheet place={picked} onClose={close} s={s} /> : null}
              </div>
            </div>
          </>
        )}

        <p className="source">{s.attribution}</p>
      </Page>
    </main>
  );
}

/** The line under a place's name in the list: what it is, and its one number where it has one. */
function summary(place: Place, s: Strings): string {
  const parts: string[] = [];
  if (place.kind === "monument") parts.push(place.monumentKind ?? s.kind.monument);
  if (place.kind === "station") parts.push(place.departures === null ? s.kind.station : s.departuresToday(place.departures));
  if (place.kind === "air") {
    const pm10 = place.readings.pm10;
    parts.push(pm10 ? `${s.pollutant.pm10} ${amount(pm10.value, pm10.unit, s)}` : s.kind.air);
  }
  if (place.coordinates === null) parts.push(s.notOnMap);
  return parts.join(" · ");
}

function PlaceMap({
  places,
  picked,
  onPick,
  s,
}: {
  places: Place[];
  picked: string | null;
  onPick: (id: string) => void;
  s: Strings;
}) {
  // The basemap is the platform's, named in the document the Portal served; the app names no tile
  // host of its own, which the app's policy would refuse anyway (AP-67, AP-12).
  const { basemap } = useClient().config;
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const collection = useMemo(() => featuresOf(places, picked), [places, picked]);
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
          "circle-radius": ["case", ["get", "picked"], 10, 7],
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

/** One place whole: a bottom sheet on a phone, a card over the map on a wider screen. */
function PlaceSheet({ place, onClose, s }: { place: Place; onClose: () => void; s: Strings }) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [place.id]);
  const name = place.name ?? s.unnamed;
  const field = (label: string, value: string | null) => (
    <>
      <dt>{label}</dt>
      <dd>{value ?? s.noValue}</dd>
    </>
  );
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
        <span aria-hidden="true" style={{ color: KIND_COLOUR[place.kind] }}>
          {KIND_SHAPE[place.kind]}
        </span>{" "}
        {s.kind[place.kind]}
      </p>
      <dl>
        {place.kind === "monument" && (
          <>
            {field(s.monumentKind, place.monumentKind)}
            {field(s.style, place.style)}
            {field(s.period, place.period)}
            {field(s.cadastralArea, place.cadastralArea)}
            {field(s.ownership, place.ownership)}
            {field(s.monumentNumber, place.monumentNumber)}
            {field(s.address, place.address)}
          </>
        )}
        {place.kind === "station" &&
          field(s.departures, place.departures === null ? null : new Intl.NumberFormat(s.locale).format(place.departures))}
        {place.kind === "air" &&
          POLLUTANTS.map((pollutant) => {
            const reading = place.readings[pollutant];
            return (
              <div key={pollutant} className="reading">
                <dt>{s.pollutant[pollutant]}</dt>
                <dd>
                  {reading ? amount(reading.value, reading.unit, s) : s.notReported}
                  {reading?.at ? <small> ({s.measuredAt(moment(reading.at, s))})</small> : null}
                </dd>
              </div>
            );
          })}
      </dl>
    </section>
  );
}

function amount(value: number, unit: string, s: Strings): string {
  return `${new Intl.NumberFormat(s.locale, { maximumFractionDigits: unit === "mg/m³" ? 2 : 1 }).format(value)} ${unit}`;
}

function moment(iso: string, s: Strings): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat(s.locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Bratislava" }).format(at);
}
