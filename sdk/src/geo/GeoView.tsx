/**
 * A geometry on the map, read only (UI-72, SDK-29, T-1442).
 *
 * The explorer shows a GeoProperty as a line of JSON and the kit's `MapView` draws one point per
 * row: neither shows the shape of a district boundary or a bus route. This draws whatever RFC 7946
 * carries — points, lines, polygons and their Multi- forms — on the same base map as every other
 * map in the kit, fits the view to it once, and says which feature is selected. `GeoEditor` is the
 * same picture with a toolbar; this one takes no input, so it is what a viewer with no grant sees.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap } from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { mapWorkerReady, NO_BASEMAP, styleFor } from "../sdk/map";
import { mapColors } from "../sdk/tokens";
import type { Geometry, Position } from "./validate";

const SOURCE = "geometry";

const workerReady = mapWorkerReady();

/** One shape on the map: a geometry with the id the host knows it by and an optional label. */
export interface GeoFeature {
  type: "Feature";
  id: string;
  geometry: Geometry;
  properties?: Record<string, unknown>;
}

/** Every position of a geometry, however deeply the type nests them. */
export function positionsOf(coordinates: unknown): Position[] {
  if (!Array.isArray(coordinates)) {
    return [];
  }
  if (typeof coordinates[0] === "number") {
    return [coordinates as Position];
  }
  return coordinates.flatMap((part) => positionsOf(part));
}

/** The corners of the box every position fits in, or `null` when there is nothing to fit to. */
export function boundsOf(features: GeoFeature[]): [[number, number], [number, number]] | null {
  const points = features.flatMap((feature) => positionsOf(feature.geometry.coordinates));
  if (points.length === 0) {
    return null;
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
  ];
}

/** A bare geometry, one feature or a list of them, as the one list the map draws. */
export function featuresOf(value: Geometry | GeoFeature | GeoFeature[] | null | undefined): GeoFeature[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if ((value as GeoFeature).type === "Feature") {
    return [value as GeoFeature];
  }
  return [{ type: "Feature", id: "geometry", geometry: value as Geometry }];
}

/**
 * An area's fill: the one drawn colour, or with a `ramp` the tokens' `map.low`→`map.high` over the
 * feature's numeric `value` property, and the drawn colour for an area that holds none (a
 * choropleth, AP-123). The colours are the tokens'; a feature only ever carries a number.
 */
export function fillOf(
  drawn: string,
  ramp: [number, number] | undefined,
  colors: { low: string; high: string },
): string | ExpressionSpecification {
  if (!ramp) {
    return drawn;
  }
  // Stops must rise: one value alone is drawn at the low end.
  const high = ramp[1] > ramp[0] ? ramp[1] : ramp[0] + 1;
  return [
    "case",
    ["==", ["typeof", ["get", "value"]], "number"],
    ["interpolate", ["linear"], ["get", "value"], ramp[0], colors.low, high, colors.high],
    drawn,
  ];
}

export function GeoView({
  value,
  selectedId,
  onSelect,
  accent,
  basemap,
  label = "Geometry",
  ramp,
}: {
  value: Geometry | GeoFeature | GeoFeature[] | null;
  /** The feature drawn as chosen; `null` draws none of them chosen. */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** The colour the shapes are drawn in; the app's own map point colour when none (SDK-25). */
  accent?: string;
  basemap?: string;
  /** What a screen reader calls the map, since the map itself says nothing. */
  label?: string;
  /** The range of the features' numeric `value`: areas are filled on the tokens' ramp over it. */
  ramp?: [number, number];
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const select = useRef(onSelect);
  select.current = onSelect;
  const features = useMemo(() => featuresOf(value), [value]);
  const style = useMemo(() => styleFor(basemap), [basemap]);
  // The design tokens colour the map as they colour the page (SDK-25, AP-137).
  const colors = mapColors();
  const drawn = accent ?? colors.point;

  const collection = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: features.map((feature) => ({
        ...feature,
        properties: { ...(feature.properties ?? {}), id: feature.id, chosen: feature.id === selectedId },
      })),
    }),
    [features, selectedId],
  );

  useEffect(() => {
    let gone = false;
    let instance: MapLibreMap | null = null;
    void workerReady.then(() => {
      if (gone || !container.current || map.current) {
        return;
      }
      instance = new MapLibreMap({
        container: container.current,
        style,
        center: [0, 0],
        zoom: 1,
        canvasContextAttributes: { preserveDrawingBuffer: true },
      });
      map.current = instance;
      instance.on("error", (event) => {
        // A silent map is the hardest kind to read from a screenshot, as in `MapView`.
        console.error("kit: map error", event.error?.message ?? event);
      });
      instance.on("load", () => {
        instance?.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        // Three layers for the three shapes one collection may mix: an area, its outline and the
        // points. A polygon gets both the fill and the line, which is what makes a selected
        // boundary readable over a basemap.
        instance?.addLayer({
          id: "areas",
          type: "fill",
          source: SOURCE,
          filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
          paint: {
            "fill-color": fillOf(drawn, ramp, colors),
            "fill-opacity": ramp ? ["case", ["get", "chosen"], 0.9, 0.7] : ["case", ["get", "chosen"], 0.45, 0.2],
          },
        });
        instance?.addLayer({
          id: "lines",
          type: "line",
          source: SOURCE,
          filter: ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false],
          paint: { "line-color": drawn, "line-width": ["case", ["get", "chosen"], 4, 2] },
        });
        instance?.addLayer({
          id: "points",
          type: "circle",
          source: SOURCE,
          filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
          paint: {
            "circle-radius": ["case", ["get", "chosen"], 9, 6],
            "circle-color": drawn,
            "circle-stroke-width": 1.5,
            "circle-stroke-color": colors.stroke,
          },
        });
        for (const layer of ["areas", "lines", "points"]) {
          instance?.on("click", layer, (event) => {
            const id = event.features?.[0]?.properties?.id;
            if (typeof id === "string") {
              select.current?.(id);
            }
          });
        }
        setReady(true);
      });
    });
    return () => {
      gone = true;
      instance?.remove();
      map.current = null;
    };
    // The map is built once and every later value reaches it through `setData`, as in `MapView`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another indicator is another range: the fill follows it without rebuilding the map.
  const low = ramp?.[0];
  const high = ramp?.[1];
  useEffect(() => {
    if (ready && low !== undefined && high !== undefined) {
      map.current?.setPaintProperty("areas", "fill-color", fillOf(drawn, [low, high], colors));
    }
    // `colors` and `drawn` are the tokens', read once per render and equal between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, low, high]);

  const fitted = useRef(false);
  useEffect(() => {
    if (!ready) {
      return;
    }
    // The library's own GeoJSON types are a discriminated union per geometry type; `Geometry` here
    // is the one shape a GeoProperty holds, checked by `checkGeometry` before it ever arrives.
    (map.current?.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(
      collection as unknown as Parameters<GeoJSONSource["setData"]>[0],
    );
    const bounds = boundsOf(features);
    // Fitted once: a person who has panned away from a shape did that on purpose, and every
    // keystroke in the editor's coordinate table would otherwise snap the view back.
    if (!fitted.current && bounds && map.current?.fitBounds) {
      fitted.current = true;
      map.current.fitBounds(bounds, { padding: 32, maxZoom: 16, duration: 0 });
    }
  }, [collection, features, ready]);

  return (
    <div className="map-wrap">
      <div className="map" ref={container} data-testid="geo-map" role="application" aria-label={label} />
      {!basemap && <span className="map-notice">{NO_BASEMAP}</span>}
      <span className="map-count">
        {features.length === 0
          ? "No geometry"
          : `${features.length} shape${features.length === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
