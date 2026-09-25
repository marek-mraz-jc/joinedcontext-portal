import list from "./generated/units.json";

/**
 * One UN/CEFACT unit of measure (DM-06, DM-59): UNECE Recommendation 20 joined with QUDT.
 *
 * The list is the platform's one code list, `crates/jc-core/data/unece-rec20.json`, generated in
 * the platform repository by `tools/units/generate.py` and copied here byte for byte; CI compares
 * the copy with the source. Nothing in this repository maps a unit by hand.
 */
export interface Unit {
  /** The Rec 20 common code NGSI-LD puts on the wire as `unitCode` (`GQ`). */
  code: string;
  name: string;
  /** What a person reads (`µg/m³`); empty where Rec 20 gives none (`piece`). */
  symbol: string;
  /** Still a valid code on the wire, not offered to a new model. */
  deprecated: boolean;
  ucum: string | null;
  qudt: string | null;
  quantityKinds: string[];
  dimension: string | null;
  /** To the SI unit of the dimension: `si = (value + offset) × factor`; null never converts. */
  factor: number | null;
  offset: number;
  /** In the municipal set a picker shows first. */
  frequent: boolean;
}

const source: { units: Unit[] } = list;

/** Every unit, sorted by code. */
export const UNITS: readonly Unit[] = source.units;

const BY_CODE = new Map(UNITS.map((unit) => [unit.code, unit]));

/** The unit of a Rec 20 code; codes are case-sensitive, as on the wire. */
export function unitOf(code: string | undefined): Unit | undefined {
  return code === undefined ? undefined : BY_CODE.get(code);
}

/** How a person reads a unit: its symbol and name, or the name alone where it has no symbol. */
export function unitLabel(unit: Unit): string {
  return unit.symbol ? `${unit.symbol} — ${unit.name}` : unit.name;
}

const SUPERSCRIPT: Record<string, string> = { "²": "2", "³": "3", "⁻": "-", "¹": "1" };

/**
 * Text as a search compares it: lower case, `µ` and `μ` as `u`, superscripts as digits, and no
 * punctuation, so `ug/m3`, `µg/m³` and `ug.m-3` are one word.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/[²³⁻¹]/g, (c) => SUPERSCRIPT[c] ?? c)
    .replace(/[^a-z0-9]/g, "");
}

/** How well a unit answers a query: 0 is its code, higher is looser, undefined is no match. */
function rank(unit: Unit, query: string, folded: string): number | undefined {
  if (unit.code.toLowerCase() === query) return 0;
  const symbol = fold(unit.symbol);
  const ucum = fold(unit.ucum ?? "");
  if ((symbol !== "" && symbol === folded) || (ucum !== "" && ucum === folded)) return 1;
  if (unit.code.toLowerCase().startsWith(query)) return 2;
  const name = unit.name.toLowerCase();
  if (name.startsWith(query)) return 2;
  if (name.includes(query) || (folded !== "" && (symbol.includes(folded) || ucum.includes(folded)))) return 3;
  if (unit.quantityKinds.some((kind) => kind.toLowerCase().includes(folded))) return 4;
  return undefined;
}

export interface UnitSearch {
  units: Unit[];
  /** How many matched before the limit. */
  total: number;
}

/**
 * The units a typed text finds (DM-06): by code, symbol, UCUM, name or quantity kind. The
 * frequent set comes first, then the rest grouped by quantity kind, the best-matching group
 * first. An empty text answers the frequent set. A deprecated code is found only by its code.
 */
export function searchUnits(text: string, limit = 100): UnitSearch {
  const query = text.trim().toLowerCase();
  const folded = fold(query);
  if (query === "") {
    const frequent = UNITS.filter((unit) => unit.frequent);
    return { units: sortByKind(frequent.map((unit) => ({ unit, score: 0 }))), total: frequent.length };
  }
  const found: { unit: Unit; score: number }[] = [];
  for (const unit of UNITS) {
    const score = rank(unit, query, folded);
    if (score === undefined || (unit.deprecated && score !== 0)) continue;
    found.push({ unit, score });
  }
  return { units: sortByKind(found).slice(0, limit), total: found.length };
}

/** The group a unit is listed under in a picker: frequent, else its first quantity kind. */
export function unitGroup(unit: Unit): string | undefined {
  return unit.frequent ? undefined : unit.quantityKinds[0];
}

function sortByKind(found: { unit: Unit; score: number }[]): Unit[] {
  const key = (unit: Unit) => (unit.frequent ? "" : (unit.quantityKinds[0] ?? "￿"));
  const best = new Map<string, number>();
  for (const { unit, score } of found) {
    const group = key(unit);
    best.set(group, Math.min(best.get(group) ?? score, score));
  }
  return found
    .sort((a, b) => {
      const [ga, gb] = [key(a.unit), key(b.unit)];
      if (ga !== gb) {
        if (ga === "" || gb === "") return ga === "" ? -1 : 1;
        return (best.get(ga) ?? 0) - (best.get(gb) ?? 0) || ga.localeCompare(gb);
      }
      return a.score - b.score || a.unit.code.localeCompare(b.unit.code);
    })
    .map(({ unit }) => unit);
}

/**
 * Whether a value in one unit can be written in the other (DM-06): both carry a factor, share
 * QUDT's dimension and at least one quantity kind. A percent and a minute of arc are both
 * dimensionless and still not one thing.
 */
export function convertible(from: Unit, to: Unit): boolean {
  if (from.code === to.code) return true;
  return (
    from.factor !== null &&
    to.factor !== null &&
    from.dimension !== null &&
    from.dimension === to.dimension &&
    from.quantityKinds.some((kind) => to.quantityKinds.includes(kind))
  );
}

/** Twelve significant digits: what a factor is written with, without a float's last-digit noise. */
function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * The linear conversion from one unit to another, `to = from × factor + offset`, or undefined
 * when they do not convert (DM-06, T-2811). Read from the code list's QUDT factors, never typed.
 */
export function conversion(from: Unit, to: Unit): { factor: number; offset: number } | undefined {
  if (!convertible(from, to)) return undefined;
  if (from.code === to.code || from.factor === null || to.factor === null) return { factor: 1, offset: 0 };
  const factor = from.factor / to.factor;
  return { factor: tidy(factor), offset: tidy(from.offset * factor - to.offset) };
}
