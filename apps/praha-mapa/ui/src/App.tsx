/**
 * Prague's map for its residents (T-2786, AP-07, AP-14, UI-15, UI-30): schools, cultural venues,
 * public toilets, ticket points and sorting isles of the city's open data, read from the public
 * space `praha-mesto` through a public endpoint, so the bundle holds no token and never asks
 * anybody to sign in (AP-28).
 *
 * A map is not readable by a screen reader or a keyboard, so the same places are a list beside it;
 * the list is the screen and the map is the picture of it. Each kind loads on its own: one the
 * endpoint refuses is a sentence saying why, and the others stay.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { endpointSource, Header, Page, SourceError, styleFor, transportFor, useClient } from "@joinedcontext/sdk";
import type { EntitySource } from "@joinedcontext/sdk";
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

function reasonOf(cause: unknown): string {
  if (cause instanceof SourceError) return cause.message;
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

export default function App() {
  const { config } = useClient();
  const s = stringsFor(config.language);
  const { layers } = useLayers();
  const [shown, setShown] = useState<Record<Kind, boolean>>({ school: true, culture: true, publicToilet: true, ticketSale: true, waste: false });
  const [search, setSearch] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

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

  const loading = layers !== null && TYPES.some((type) => layers[type].status === "loading");
  const typeOf = (kind: Kind): Type => (KINDS_OF.PointOfInterest.includes(kind) ? "PointOfInterest" : "WasteContainerIsle");

  return (
    <main>
      <Page>
        <Header level={1} title={s.title} subtitle={s.subtitle} />

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
              <PlaceMap places={visible} picked={pickedId} onPick={setPickedId} s={s} />
              <div className="side">
                {picked ? <PlaceSheet place={picked} onClose={close} s={s} /> : null}
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
    </main>
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

/** One place whole: a bottom sheet on a phone, a panel beside the list on a wider screen. */
function PlaceSheet({ place, onClose, s }: { place: Place; onClose: () => void; s: Strings }) {
  const heading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [place.id]);
  const name = place.name ?? s.unnamed;
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
        {place.kind === "waste" ? (
          <>
            <dt>{s.stationCode}</dt>
            <dd>{place.stationCode ?? s.noValue}</dd>
            <dt>{s.access}</dt>
            <dd>{place.access ? (s.values[place.access] ?? place.access) : s.noValue}</dd>
          </>
        ) : (
          <>
            <dt>{s.facilityType}</dt>
            <dd>{place.facilityType ?? s.noValue}</dd>
            <dt>{s.openingHours}</dt>
            <dd>{place.openingHours ?? s.noValue}</dd>
            <dt>{s.wheelchair}</dt>
            <dd>{place.wheelchairAccessible === null ? s.noValue : place.wheelchairAccessible ? s.yes : s.no}</dd>
          </>
        )}
        {place.kind === "school" && (
          <>
            <dt>{s.pupils}</dt>
            <dd>{place.pupils === null ? s.noValue : new Intl.NumberFormat(s.locale).format(place.pupils)}</dd>
          </>
        )}
        {place.kind === "culture" && (
          <>
            <dt>{s.capacity}</dt>
            <dd>{place.capacity === null ? s.noValue : new Intl.NumberFormat(s.locale).format(place.capacity)}</dd>
          </>
        )}
        <dt>{s.address}</dt>
        <dd>{place.address ?? s.noValue}</dd>
      </dl>
      {place.url ? (
        <p>
          <a href={place.url} target="_blank" rel="noopener noreferrer">
            {s.website}
          </a>
        </p>
      ) : null}
    </section>
  );
}
