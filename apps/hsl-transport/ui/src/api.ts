/**
 * The app's own backend, and nothing else. The Endpoint URL never reaches the browser: the
 * server holds it, polls it once for every viewer and pushes what moved down this stream
 * (AP-04, AP-41). There is no login anywhere in this file, because the Endpoint behind the
 * app is public and the app never sees a user (AP-28).
 */
import { currentTokens, type DesignTokens } from "@joinedcontext/sdk";

const BASE = import.meta.env.BASE_URL;

export interface Vehicle {
  id: string;
  /** `[longitude, latitude]`, the GeoJSON order. */
  coordinates: [number, number];
  bearing?: number;
  speed?: number;
  refLine?: string;
}

export interface VehicleFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; color: string; bearing: number; refLine: string; speed?: number };
}

export interface VehicleCollection {
  type: "FeatureCollection";
  features: VehicleFeature[];
}

/** The fleet as the backend last saw it. A 503 means no poll has produced one yet. */
export async function getVehicles(): Promise<Vehicle[]> {
  const response = await fetch(`${BASE}api/vehicles`);
  if (!response.ok) {
    return [];
  }
  return (await response.json()) as Vehicle[];
}

/**
 * Every bus that moves. The first message carries the whole fleet, so a browser that opens
 * the stream alone is already drawing; returns the function that closes it.
 */
export function subscribe(onVehicles: (vehicles: Vehicle[]) => void): () => void {
  const source = new EventSource(`${BASE}api/stream`);
  source.addEventListener("vehicles", (event) => {
    try {
      onVehicles(JSON.parse((event as MessageEvent<string>).data) as Vehicle[]);
    } catch {
      // A malformed frame is one lost update, not a reason to tear the map down.
    }
  });
  return () => source.close();
}

/**
 * One colour per line, from the design tokens' chart palette (AP-123), so two buses on the 550
 * look like the same route without anybody maintaining a colour table, and no entity value ever
 * becomes CSS. A line the Policy hides falls back to the tokens' muted colour.
 */
export function lineColor(refLine: string | undefined, tokens: DesignTokens = currentTokens()): string {
  if (!refLine) {
    return tokens.color.muted;
  }
  let hash = 0;
  for (const character of refLine) {
    hash = (hash * 31 + character.charCodeAt(0)) % 9973;
  }
  // A grey in the palette reads as "no line"; lines take the palette's colours only.
  const colours = tokens.chart.palette.filter(chromatic);
  const palette = colours.length > 0 ? colours : tokens.chart.palette;
  return palette[hash % palette.length];
}

function channels(hex: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : undefined;
}

/** A colour, not a grey: its channels spread by more than a fifth of the range. */
function chromatic(hex: string): boolean {
  const rgb = channels(hex);
  return rgb !== undefined && Math.max(...rgb) - Math.min(...rgb) > 51;
}

/** `share` of the way from `from` to `to`, both `#rrggbb`; `from` when either is not. */
export function mix(from: string, to: string, share: number): string {
  const a = channels(from);
  const b = channels(to);
  if (!a || !b) return from;
  const t = Math.min(1, Math.max(0, share));
  return `#${a.map((value, index) => Math.round(value + (b[index] - value) * t).toString(16).padStart(2, "0")).join("")}`;
}

/** `[[west, south], [east, north]]`, as MapLibre's `getBounds().toArray()` answers. */
export type Bounds = [[number, number], [number, number]];

/** The buses inside the map's view; every bus while the map has not said where it looks. */
export function inView(vehicles: Vehicle[], bounds: Bounds | undefined): Vehicle[] {
  if (!bounds) {
    return vehicles;
  }
  const [[west, south], [east, north]] = bounds;
  return vehicles.filter(({ coordinates: [longitude, latitude] }) =>
    longitude >= west && longitude <= east && latitude >= south && latitude <= north,
  );
}

export interface Bar {
  label: string;
  value: number;
  color: string;
}

/** What the per-line chart calls a bus whose line the Policy hides. */
export const NO_LINE = "Line not shown";

/** Buses per line, most first, a tie in line order, at most `top` lines (the rest are summed). */
export function perLine(vehicles: Vehicle[], top = 15, tokens: DesignTokens = currentTokens()): Bar[] {
  const counts = new Map<string, number>();
  for (const { refLine } of vehicles) {
    const line = refLine || NO_LINE;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const sorted = [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b, "en", { numeric: true }));
  const bars = sorted.slice(0, top).map(([line, value]) => ({
    label: line,
    value,
    color: lineColor(line === NO_LINE ? undefined : line, tokens),
  }));
  const rest = sorted.slice(top).reduce((sum, [, value]) => sum + value, 0);
  return rest > 0 ? [...bars, { label: "Other lines", value: rest, color: tokens.color.muted }] : bars;
}

/** The speed chart's bands in km/h: the stream carries metres per second (HFP `spd`). */
export const SPEED_BANDS = [0, 10, 20, 30, 40, 50, 60] as const;

/**
 * Buses per speed band, every band present so the chart keeps its shape; a bus that reports no
 * speed is counted apart rather than as standing still.
 */
export function speedBands(vehicles: Vehicle[], tokens: DesignTokens = currentTokens()): { bars: Bar[]; unknown: number } {
  const counts: number[] = SPEED_BANDS.map(() => 0);
  let unknown = 0;
  for (const { speed } of vehicles) {
    if (speed === undefined || !Number.isFinite(speed) || speed < 0) {
      unknown += 1;
      continue;
    }
    const kmh = speed * 3.6;
    let band = SPEED_BANDS.length - 1;
    while (band > 0 && kmh < SPEED_BANDS[band]) band -= 1;
    counts[band] += 1;
  }
  // Slow to fast through the tokens' own colours: the map's low, success, warning, the map's high
  // and danger, each band on the way between two of them (AP-123).
  const ramp = [tokens.map.low, tokens.color.success, tokens.color.warning, tokens.map.high, tokens.color.danger];
  const at = (share: number): string => {
    const position = share * (ramp.length - 1);
    const stop = Math.min(ramp.length - 2, Math.floor(position));
    return mix(ramp[stop], ramp[stop + 1], position - stop);
  };
  const bars = SPEED_BANDS.map((from, index) => ({
    label: index === SPEED_BANDS.length - 1 ? `${from}+ km/h` : `${from}–${SPEED_BANDS[index + 1]} km/h`,
    value: counts[index],
    color: at(index / (SPEED_BANDS.length - 1)),
  }));
  return { bars, unknown };
}

/** The fleet as the map source reads it. */
export function featureCollection(vehicles: Vehicle[]): VehicleCollection {
  return {
    type: "FeatureCollection",
    features: vehicles.map((vehicle) => ({
      type: "Feature",
      id: vehicle.id,
      geometry: { type: "Point", coordinates: vehicle.coordinates },
      properties: {
        id: vehicle.id,
        color: lineColor(vehicle.refLine),
        // The arrow needs a number; a hidden bearing points north rather than disappearing.
        bearing: vehicle.bearing ?? 0,
        refLine: vehicle.refLine ?? "",
        ...(vehicle.speed === undefined ? {} : { speed: vehicle.speed }),
      },
    })),
  };
}
