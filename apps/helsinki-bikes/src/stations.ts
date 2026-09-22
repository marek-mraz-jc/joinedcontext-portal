import type { Row } from "@joinedcontext/sdk";

/** The one entity type the app's data need names (AP-04). */
export const STATION = "BikeHireDockingStation";

/** The bikes a station has now, or `null` when the station did not say. */
export function bikes(row: Row): number | null {
  const value = row.availableBikeNumber;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A station that has at least one bike to take. */
export function hasBikes(row: Row): boolean {
  return (bikes(row) ?? 0) > 0;
}

/** A station that says it has none; one that says nothing is unknown, not empty. */
export function isEmpty(row: Row): boolean {
  return bikes(row) === 0;
}

export interface Totals {
  stations: number;
  bikes: number;
  empty: number;
}

export function totals(rows: Row[]): Totals {
  return {
    stations: rows.length,
    bikes: rows.reduce((sum, row) => sum + (bikes(row) ?? 0), 0),
    empty: rows.filter(isEmpty).length,
  };
}
