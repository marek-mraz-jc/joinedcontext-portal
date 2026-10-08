/**
 * Prague's map for its residents (T-2786, AP-07, AP-14, UI-15, UI-30): schools, cultural venues,
 * public toilets, ticket points and sorting isles of the city's open data, read from the public
 * space `praha-mesto` through a public endpoint, so the bundle holds no token and never asks
 * anybody to sign in (AP-28).
 *
 * A map is not readable by a screen reader or a keyboard, so the same places are a list beside it;
 * the list is the screen and the map is the picture of it. Each kind loads on its own: one the
 * endpoint refuses is a sentence saying why, and the others stay. A place picked in the list or
 * on the map opens in the SDK's entity panel, which links to it in the Portal: a public App
 * writes nothing (SDK-39, SDK-40, AP-140).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { AppShell, endpointSource, Page, styleFor, transportFor, useClient, useEntitySelection } from "@joinedcontext/sdk";
import type { EntitySource, ShellPage } from "@joinedcontext/sdk";
import { byOrder, featuresOf, KIND_COLOUR, KIND_SHAPE, KINDS, KINDS_OF, kindOf, matches, placeOf, TYPES } from "./places";
import type { Kind, Place, Type } from "./places";
import { stringsFor } from "./locales";
import type { Strings } from "./locales";

/** The space this application reads (`Development/10` §2). */
const SPACE = "praha-mesto";
/** One request's page, and the most of one kind the map holds: a list a person reads, not a dump. */
const PAGE = 200;
export const MOST = 4000;
/** The centre of Prague, where the map opens. */
const CENTRE: [number, number] = [14.4378, 50.0755];
const SOURCE_ID = "places";

type Layer =
  | { status: "loading" }
  | { status: "ready"; places: Place[]; truncated: boolean }
  | { status: "failed"; reason: string };

function useEndpointSlug(): string | null {
  const { config } = useClient();
  const listed = config.endpoints?.find((candidate) => candidate.space === SPACE)?.slug;
  return listed ?? (config.space === SPACE ? config.slug : null) ?? null;
}

/** The name the panel reads a place through: the listed endpoint of the space, else the App's own. */
function useEndpointName(): string | undefined {
  const { config } = useClient();
  return config.endpoints?.find((candidate) => candidate.space === SPACE)?.name;
}

/** A failure in words: the endpoint's own (a `SourceError` is an `Error`), else what was thrown. */
export function reasonOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Every place of one type, page by page up to `MOST`, each sorted into its kind. */
async function loadType(source: EntitySource, type: Type, locale: string): Promise<Layer> {
  const places: Place[] = [];
  for (let offset = 0; offset < MOST; offset += PAGE) {
    const page = await source.query({ type }, { offset, limit: PAGE });
    for (const row of page.rows) {
      const kind = kindOf(row, type);
      if (kind) places.push(placeOf(row, kind, locale));
    }
    if (page.rows.length < PAGE) return { status: "ready", places, truncated: false };
  }
  return { status: "ready", places, truncated: true };
}

export function useLayers(): { layers: Record<Type, Layer> | null } {
  const { config } = useClient();
  const slug = useEndpointSlug();
  const language = config.language ?? "sk";
  const [layers, setLayers] = useState<Record<Type, Layer> | null>(null);
  const source = useMemo(
    () => (slug ? endpointSource(slug, transportFor(config), language) : null),
    // `config` is the document the Portal served once; the slug and the language are what change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, language],
  );

  useEffect(() => {
    if (!source) return;
    let live = true;
    setLayers({ PointOfInterest: { status: "loading" }, WasteContainerIsle: { status: "loading" } });
    for (const type of TYPES) {
      loadType(source, type, language.slice(0, 2))
        .catch((cause: unknown): Layer => ({ status: "failed", reason: reasonOf(cause) }))
        .then((layer) => {
          if (live) setLayers((before) => (before ? { ...before, [type]: layer } : before));
        });
    }
    return () => {
      live = false;
    };
  }, [source, language]);

  return { layers: source ? layers : null };
}

/** The map in the SDK's shell, which holds the entity panel (SDK-39). */
export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const pages: ShellPage[] = [{ id: "map", label: s.page, render: () => <PlacesPage /> }];
  return <AppShell title={s.title} pages={pages} language={s.locale} />;
}

function PlacesPage() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const { layers } = useLayers();
  const { selected, select } = useEntitySelection();
  const endpoint = useEndpointName();
  const [shown, setShown] = useState<Record<Kind, boolean>>({ school: true, culture: true, publicToilet: true, ticketSale: true, waste: false });
  const [search, setSearch] = useState("");
  const pickedId = selected?.id ?? null;

  const all = useMemo(
    () => TYPES.flatMap((type) => (layers?.[type].status === "ready" ? layers[type].places : [])),
    [layers],
  );
  const visible = useMemo(
    () =>
      all
        .filter((place) => shown[place.kind])
        .filter((place) => matches(place, search))
        .sort(byOrder),
    [all, shown, search],
  );
  const loading = layers !== null && TYPES.some((type) => layers[type].status === "loading");
  const typeOf = (kind: Kind): Type => (KINDS_OF.PointOfInterest.includes(kind) ? "PointOfInterest" : "WasteContainerIsle");
  const pick = (id: string) => {
    const place = all.find((candidate) => candidate.id === id);
    if (place) select({ id: place.id, type: typeOf(place.kind), endpoint });
  };

  return (
    <Page label={s.page}>
        <p className="subtitle">{s.subtitle}</p>

        {layers === null && <p role="status">{s.noEndpoint}</p>}
        {layers !== null && (
          <>
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
              <fieldset className="layers">
                <legend>{s.show}</legend>
                {KINDS.map((kind) => {
                  const layer = layers[typeOf(kind)];
                  const count = layer.status === "ready" ? layer.places.filter((place) => place.kind === kind).length : null;
                  return (
                    <label key={kind} className="layer">
                      <input
                        type="checkbox"
                        checked={shown[kind]}
                        onChange={(event) => setShown({ ...shown, [kind]: event.target.checked })}
                      />
                      <span aria-hidden="true" className="shape" style={{ color: KIND_COLOUR[kind] }}>
                        {KIND_SHAPE[kind]}
                      </span>
                      <span>
                        {s.kind[kind]}
                        {count !== null ? ` (${count})` : ""}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            </div>

            {loading && <p role="status">{s.loading}</p>}
            {TYPES.map((type) => {
              const layer = layers[type];
              if (layer.status === "failed") {
                return (
                  <p key={type} role="alert" className="failed">
                    {s.refused(s.type[type], layer.reason)}
                  </p>
                );
              }
              if (layer.status === "ready" && layer.truncated) {
                return (
                  <p key={type} className="note">
                    {s.truncated(s.type[type], MOST)}
                  </p>
                );
              }
              return null;
            })}

            <div className="map-screen">
              <PlaceMap places={visible} picked={pickedId} onPick={pick} s={s} />
              <div className="side">
                <section className="results" aria-labelledby="results-heading">
                  <h2 id="results-heading">{s.results(visible.length)}</h2>
                  {!loading && visible.length === 0 ? <p>{s.noResults}</p> : null}
                  <ul>
                    {visible.map((place) => (
                      <li key={place.id}>
                        <button
                          type="button"
                          data-id={place.id}
                          aria-pressed={place.id === pickedId}
                          onClick={() => pick(place.id)}
                        >
                          <span aria-hidden="true" className="shape" style={{ color: KIND_COLOUR[place.kind] }}>
                            {KIND_SHAPE[place.kind]}
                          </span>
                          <span className="name">{place.name ?? s.unnamed}</span>
                          <span className="sub">
                            {s.kind[place.kind]}
                            {place.facilityType ? ` · ${place.facilityType}` : ""}
                            {place.coordinates === null ? ` · ${s.notOnMap}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </>
        )}

        <p className="source">{s.attribution}</p>
    </Page>
  );
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
  // The handler the map was built with would keep the places of its first render: read the latest.
  const onPickLatest = useRef(onPick);
  onPickLatest.current = onPick;

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
      if (typeof id === "string") onPickLatest.current(id);
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
