/**
 * The App's server in memory, for the page's tests (T-3348): the fixture's readings kept as the
 * server keeps them, hourly means with humidity in per cent, served for the chosen stations and
 * period; comparisons kept under codes; an export answered with a URL.
 */
import { vi } from "vitest";
import { HISTORY, NOW } from "../fixtures/stations";
import { ServerProblem } from "../problem";
import type { AirApi, Comparison } from "../server";
import { hourlyOf } from "./hourly";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Memory = AirApi & {
  /** The readings the server holds, as the broker's temporalValues answer them. */
  history: ReadonlyArray<Record<string, unknown>>;
  saved: Map<string, Comparison>;
  /** Back to the fixture's history, nothing saved, fresh call records. */
  reset(): void;
};

/** The server's routes as fresh mocks over `memory`'s history and saved comparisons. */
function fill(memory: Partial<Memory> & Pick<Memory, "history" | "saved">): Memory {
  memory.series = vi.fn(async (air: string, weather: string, days: number) => {
    const from = Math.floor((NOW - days * DAY) / HOUR) * HOUR;
    return { air: hourlyOf(memory.history, air, from), weather: hourlyOf(memory.history, weather, from) };
  });
  memory.save = vi.fn(async (comparison: Comparison) => {
    const code = `c${String(memory.saved.size + 1).padStart(11, "0")}`;
    memory.saved.set(code, comparison);
    return { code, name: comparison.name };
  });
  memory.open = vi.fn(async (code: string) => {
    const found = memory.saved.get(code);
    if (!found) throw new ServerProblem(404, "no comparison is saved under this link");
    return { ...found, code };
  });
  memory.exportUrl = vi.fn(async () => "https://store.example/apps/s1/x/exports/c00000000001.csv?X-Amz-Signature=x");
  return memory as Memory;
}

export function memoryServer(): Memory {
  const memory: Partial<Memory> & Pick<Memory, "history" | "saved"> = { history: HISTORY, saved: new Map() };
  memory.reset = () => {
    memory.history = HISTORY;
    memory.saved.clear();
    fill(memory);
  };
  return fill(memory);
}

/** The one the page's module gets in the tests that mock `../server`. */
export const server = memoryServer();
