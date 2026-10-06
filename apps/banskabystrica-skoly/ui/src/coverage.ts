/**
 * The schools of the city as a coverage desk reads them (T-2782): pupils, staff and budget from
 * the national school map, and the two ratios a desk compares, pupils per teacher and budget per
 * pupil. A ratio is computed only from counts the school actually published; a missing count makes
 * the ratio missing, never zero. What stands out is judged against the city's own schools (the
 * highest or lowest tenth), never against a threshold this application would have to invent.
 */
import type { RichCell, RichRow } from "@joinedcontext/sdk";

export interface School {
  id: string;
  name: string | null;
  address: string | null;
  pupils: number | null;
  teachers: number | null;
  otherStaff: number | null;
  budget: number | null;
  budgetYear: number | null;
  pupilsPerTeacher: number | null;
  budgetPerPupil: number | null;
}

function first(cell: RichCell | RichCell[] | undefined): RichCell | undefined {
  return Array.isArray(cell) ? cell[0] : cell;
}

function count(row: RichRow, attr: string): number | null {
  const value = first(row.cells[attr])?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(row: RichRow, attr: string, locale: string): string | null {
  const cell = first(row.cells[attr]);
  const map = cell?.languageMap;
  const value = map ? (map[locale] ?? map.sk ?? Object.values(map)[0]) : cell?.value;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function schoolOf(row: RichRow, locale: string): School {
  const pupils = count(row, "pupilCount");
  const teachers = count(row, "teachingStaff");
  const budget = count(row, "annualBudget");
  return {
    id: row.id,
    name: text(row, "name", locale),
    address: text(row, "address", locale),
    pupils,
    teachers,
    otherStaff: count(row, "nonTeachingStaff"),
    budget,
    budgetYear: count(row, "budgetYear"),
    pupilsPerTeacher: pupils !== null && teachers !== null && teachers > 0 ? pupils / teachers : null,
    budgetPerPupil: budget !== null && pupils !== null && pupils > 0 ? budget / pupils : null,
  };
}

export interface Totals {
  schools: number;
  pupils: number;
  teachers: number;
  /** Over the schools that published both counts: sum over sum, not a mean of ratios. */
  pupilsPerTeacher: number | null;
  /** Schools missing any of the counts the ratios need. */
  incomplete: number;
}

export function totals(schools: School[]): Totals {
  const both = schools.filter((s) => s.pupils !== null && s.teachers !== null && s.teachers > 0);
  const pupils = both.reduce((sum, s) => sum + (s.pupils ?? 0), 0);
  const teachers = both.reduce((sum, s) => sum + (s.teachers ?? 0), 0);
  return {
    schools: schools.length,
    pupils: schools.reduce((sum, s) => sum + (s.pupils ?? 0), 0),
    teachers: schools.reduce((sum, s) => sum + (s.teachers ?? 0), 0),
    pupilsPerTeacher: teachers > 0 ? pupils / teachers : null,
    incomplete: schools.filter((s) => s.pupilsPerTeacher === null || s.budgetPerPupil === null).length,
  };
}

/**
 * The value at or above which a school is in the highest tenth of the city (`side: "high"`), or at
 * or below which it is in the lowest (`"low"`). `null` with fewer than ten schools: a tenth of a
 * handful is one school, and calling it an outlier would be a claim the data cannot carry.
 */
export function tenth(values: (number | null)[], side: "high" | "low"): number | null {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (known.length < 10) return null;
  const at = side === "high" ? Math.ceil(known.length * 0.9) - 1 : Math.floor(known.length * 0.1);
  return known[at];
}

export type SortKey = "name" | "pupils" | "teachers" | "pupilsPerTeacher" | "budgetPerPupil";

/** Sorted by `key`; a missing value goes last whichever the direction, so it never tops a list. */
export function sorted(schools: School[], key: SortKey, ascending: boolean): School[] {
  return [...schools].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    const order = typeof x === "string" ? x.localeCompare(String(y), "sk") : (x as number) - (y as number);
    return ascending ? order : -order;
  });
}

/** One CSV field: quoted when it holds a separator, a quote or a line break; quotes doubled. */
function field(value: string | number | null): string {
  if (value === null) return "";
  const text = typeof value === "number" ? String(Math.round(value * 100) / 100) : value;
  // A cell a spreadsheet would run as a formula is prefixed, so an exported name never executes.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The desk's table as CSV, the computed ratios included, with the given header words. */
export function toCsv(schools: School[], header: string[]): string {
  const rows = schools.map((s) =>
    [s.name, s.address, s.pupils, s.teachers, s.pupilsPerTeacher, s.otherStaff, s.budget, s.budgetYear, s.budgetPerPupil]
      .map(field)
      .join(","),
  );
  return [header.map(field).join(","), ...rows].join("\r\n") + "\r\n";
}
