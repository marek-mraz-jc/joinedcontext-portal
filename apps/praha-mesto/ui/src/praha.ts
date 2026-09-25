/**
 * The rows of the praha-mesto space as this screen reads them (T-2917): nextbike docking
 * stations, park-and-ride car parks and ČHMÚ air-quality stations, each from the attributes the
 * praha-mesto model declares and nothing guessed. A row of another type, or one missing the
 * attribute a line is about, is left out rather than shown with a made-up zero.
 */
import type { RichCell, RichRow } from "@joinedcontext/sdk";

export interface BikeStation {
  id: string;
  name: string;
  bikes: number | null;
  docks: number | null;
  working: boolean;
  reportedAt?: string;
}

export interface CarPark {
  id: string;
  name: string;
  capacity: number | null;
  /** Free and occupied spaces right now: present only once the live counters feed the space. */
  free: number | null;
  occupied: number | null;
  reportedAt?: string;
}

export type Pollutant = "pm10" | "pm25" | "no2" | "o3";
export const POLLUTANTS: readonly Pollutant[] = ["pm10", "pm25", "no2", "o3"];

export interface AirStation {
  id: string;
  name: string;
  readings: Partial<Record<Pollutant, { value: number; at?: string }>>;
}

function one(row: RichRow, attr: string): RichCell | undefined {
  const cell = row.cells[attr];
  return Array.isArray(cell) ? cell[0] : cell;
}

/** A count: a whole number that is not negative, or `null`. */
function count(cell: RichCell | undefined): number | null {
  const value = cell?.value;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function measure(cell: RichCell | undefined): number | null {
  const value = cell?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function when(cell: RichCell | undefined): string | undefined {
  const value = cell?.value;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** The name in `language`, else Czech, else any the publisher wrote; `null` when there is none. */
export function nameOf(row: RichRow, language: string): string | null {
  const cell = one(row, "name");
  const map = cell?.languageMap;
  const picked = map?.[language] ?? map?.cs ?? (map ? Object.values(map)[0] : undefined) ?? cell?.value;
  return typeof picked === "string" && picked.trim() !== "" ? picked.trim() : null;
}

export function toBikeStation(row: RichRow, language: string): BikeStation | null {
  if (row.type !== "BikeHireDockingStation") return null;
  const name = nameOf(row, language);
  if (!name) return null;
  return {
    id: row.id,
    name,
    bikes: count(one(row, "availableBikeNumber")),
    docks: count(one(row, "freeSlotNumber")),
    working: one(row, "status")?.value === "working",
    reportedAt: when(one(row, "dateModified")),
  };
}

export function toCarPark(row: RichRow, language: string): CarPark | null {
  if (row.type !== "OffStreetParking") return null;
  const name = nameOf(row, language);
  if (!name) return null;
  return {
    id: row.id,
    name,
    capacity: count(one(row, "totalSpotNumber")),
    free: count(one(row, "availableSpotNumber")),
    occupied: count(one(row, "occupiedSpotNumber")),
    reportedAt: when(one(row, "dateModified")),
  };
}

export function toAirStation(row: RichRow, language: string): AirStation | null {
  if (row.type !== "AirQualityObserved") return null;
  const name = nameOf(row, language);
  if (!name) return null;
  const readings: AirStation["readings"] = {};
  for (const pollutant of POLLUTANTS) {
    const cell = one(row, pollutant);
    const value = measure(cell);
    if (value !== null) readings[pollutant] = { value, at: cell?.observedAt ?? when(one(row, "dateObserved")) };
  }
  return Object.keys(readings).length === 0 ? null : { id: row.id, name, readings };
}

export interface BikeTotals {
  stations: number;
  working: number;
  bikes: number;
  docks: number;
}

/** The totals over the stations that rent right now; a station out of service lends nothing. */
export function bikeTotals(stations: BikeStation[]): BikeTotals {
  const working = stations.filter((station) => station.working);
  return {
    stations: stations.length,
    working: working.length,
    bikes: working.reduce((sum, station) => sum + (station.bikes ?? 0), 0),
    docks: working.reduce((sum, station) => sum + (station.docks ?? 0), 0),
  };
}

/** Stations whose name holds `search`, case and diacritics ignored, by name. */
export function matching<T extends { name: string }>(rows: T[], search: string, locale: string): T[] {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const wanted = fold(search.trim());
  return rows
    .filter((row) => wanted === "" || fold(row.name).includes(wanted))
    .sort((a, b) => a.name.localeCompare(b.name, locale));
}
