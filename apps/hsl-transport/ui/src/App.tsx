import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Card, Header, NO_BASEMAP, Page, Split, styleFor } from "@joinedcontext/sdk";
import {
  featureCollection,
  getVehicles,
  inView,
  lineColor,
  perLine,
  speedBands,
  subscribe,
  type Bar,
  type Bounds,
  type Vehicle,
  type VehicleCollection,
} from "./api";

const SOURCE = "vehicles";
const ARROW = "heading-arrow";
const ARROW_SIZE = 24;
const HELSINKI: [number, number] = [24.94, 60.17];

/**
 * The project's basemap, as the page the App's server writes carries it: `#jc-config.basemap`,
 * the Portal's basemap route (AP-67, T-2928). The App names no tile host of its own; without a
 * configured basemap the map is the SDK's plain background and says so.
 */
export function basemapOf(doc: Document = document): string | undefined {
  const text = doc.getElementById("jc-config")?.textContent;
  if (!text) return undefined;
  try {
    const basemap = (JSON.parse(text) as { basemap?: unknown }).basemap;
    return typeof basemap === "string" && basemap.startsWith("https://") ? basemap : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A white arrow pointing north on a transparent square, drawn pixel by pixel so the map needs no
 * sprite sheet and no canvas; the symbol layer turns it to each bus's heading.
 */
export function arrowImage(size = ARROW_SIZE): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4);
  const middle = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    // Tip at the top, base at three quarters of the height, a third of the square wide there.
    const top = size * 0.2;
    const bottom = size * 0.72;
    if (y < top || y > bottom) continue;
    const half = ((y - top) / (bottom - top)) * (size * 0.26);
    for (let x = 0; x < size; x += 1) {
      if (Math.abs(x - middle) <= half) {
        data.set([255, 255, 255, 255], (y * size + x) * 4);
      }
    }
  }
  return { width: size, height: size, data };
}

/**
 * The fleet, seeded from the backend's snapshot and kept current by the stream. A message
 * carries only what moved, so it is merged into what is already on the map rather than
 * replacing it (AP-41).
 */
export function useVehicles(): { vehicles: Vehicle[]; live: boolean } {
  const [byId, setById] = useState<Map<string, Vehicle>>(new Map());
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const merge = (batch: Vehicle[]) => {
      if (cancelled || batch.length === 0) {
        return;
      }
      setById((current) => {
        const next = new Map(current);
        for (const vehicle of batch) {
          next.set(vehicle.id, vehicle);
        }
        return next;
      });
    };
    void getVehicles().then(merge);
    const close = subscribe((batch) => {
      setLive(true);
      merge(batch);
    });
    return () => {
      cancelled = true;
      close();
    };
  }, []);

  return { vehicles: [...byId.values()], live };
}

/** The map, and the one source every update writes to. */
export function VehicleMap({
  collection,
  onView,
  basemap,
}: {
  collection: VehicleCollection;
  /** The basemap's style URL; the SDK's plain background without one. */
  basemap?: string;
  /** Where the map looks, once it has loaded and after every pan or zoom. */
  onView?: (bounds: Bounds) => void;
}) {
  const reportView = useRef(onView);
  useEffect(() => {
    reportView.current = onView;
  }, [onView]);
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) {
      return;
    }
    const instance = new MapLibreMap({
      container: container.current,
      style: styleFor(basemap),
      center: HELSINKI,
      zoom: 11,
    });
    map.current = instance;
    instance.on("load", () => {
      instance.addSource(SOURCE, { type: "geojson", data: collection });
      instance.addLayer({
        id: "vehicle-dots",
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-radius": 9,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#ffffff",
        },
      });
      if (!instance.hasImage(ARROW)) {
        instance.addImage(ARROW, arrowImage());
      }
      // The heading, on top of the line's colour: the arrow turns with the map, so north on the
      // bus is north on the ground.
      instance.addLayer({
        id: "vehicle-heading",
        type: "symbol",
        source: SOURCE,
        layout: {
          "icon-image": ARROW,
          "icon-size": 0.6,
          "icon-rotate": ["get", "bearing"],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });
      setReady(true);
      // The container may have taken its final size after the map measured it (the page's grid
      // settles once the charts beside it render): measure again before saying where it looks.
      instance.resize();
      reportView.current?.(instance.getBounds().toArray() as Bounds);
    });
    const report = () => reportView.current?.(instance.getBounds().toArray() as Bounds);
    instance.on("moveend", report);
    instance.on("resize", report);
    return () => {
      instance.remove();
      map.current = null;
    };
    // The collection is deliberately not a dependency: the map is built once and every later
    // fleet reaches it through setData below, which is what keeps a moving bus from
    // rebuilding the layer on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const source = map.current?.getSource(SOURCE) as GeoJSONSource | undefined;
    source?.setData(collection);
  }, [collection, ready]);

  return (
    <>
      <div className="map" ref={container} data-testid="map" role="application" aria-label="Bus map" />
      {!basemap && <p className="note">{NO_BASEMAP}</p>}
    </>
  );
}

/**
 * A bar per row as plain HTML: a screen reader reads it as the list it is, it wraps on a phone,
 * and the bar's length is the only style computed from the data (its colour is a token).
 */
export function BarChart({ title, bars, note }: { title: string; bars: Bar[]; note?: string }) {
  const most = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <Card title={title}>
      {bars.every((bar) => bar.value === 0) ? (
        <p className="empty">No buses in view.</p>
      ) : (
        <ol className="bars" aria-label={title}>
          {bars.map((bar) => (
            <li className="bar" key={bar.label}>
              <span className="bar-label">{bar.label}</span>
              <span className="bar-track" aria-hidden="true">
                <span
                  className="bar-fill"
                  data-testid="bar-fill"
                  style={{ width: `${(bar.value / most) * 100}%`, background: bar.color }}
                />
              </span>
              <span className="bar-value">{bar.value}</span>
            </li>
          ))}
        </ol>
      )}
      {note && <p className="note">{note}</p>}
    </Card>
  );
}

export function App() {
  const { vehicles, live } = useVehicles();
  const [bounds, setBounds] = useState<Bounds | undefined>(undefined);
  const [basemap] = useState(() => basemapOf());
  const collection = useMemo(() => featureCollection(vehicles), [vehicles]);
  // The charts and the legend follow the map: what they count is what the person looks at.
  const shown = useMemo(() => inView(vehicles, bounds), [vehicles, bounds]);
  const lines = useMemo(() => perLine(shown), [shown]);
  const speeds = useMemo(() => speedBands(shown), [shown]);
  const legend = useMemo(
    () => [...new Set(shown.map((vehicle) => vehicle.refLine).filter(Boolean))].sort((a, b) =>
      (a as string).localeCompare(b as string, "en", { numeric: true }),
    ) as string[],
    [shown],
  );

  return (
    <main className="app">
      <Page width="full">
        <Header
          level={1}
          title="Buses live"
          subtitle={
            <span className="status" role="status">
              {vehicles.length === 0
                ? "Waiting for the first positions"
                : `${vehicles.length} buses${live ? ", updating live" : ""}${
                    bounds && shown.length !== vehicles.length ? `, ${shown.length} in view` : ""
                  }`}
            </span>
          }
        />
        <Split ratio="2:1">
          <div className="map-pane">
            <VehicleMap collection={collection} onView={setBounds} basemap={basemap} />
            {legend.length > 0 && (
              <ul className="lines" aria-label="Lines on the map">
                {legend.map((line) => (
                  <li className="line" key={line}>
                    <span className="swatch" style={{ background: lineColor(line) }} />
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="charts">
            <BarChart title="Buses per line" bars={lines} />
            <BarChart
              title="Speed"
              bars={speeds.bars}
              note={speeds.unknown > 0 ? `${speeds.unknown} without a speed reading` : undefined}
            />
          </div>
        </Split>
      </Page>
    </main>
  );
}
