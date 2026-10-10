/** The App's server in memory, for the page's tests (T-3350): nothing kept until a test keeps it. */
import { vi } from "vitest";
import type { KeptForecast, KpiApi } from "./server";

export type Memory = KpiApi & { kept: Map<string, KeptForecast[]>; reset(): void };

function fill(memory: Partial<Memory> & Pick<Memory, "kept">): Memory {
  memory.record = vi.fn(async () => ({ recorded: 0, already: true }));
  memory.list = vi.fn(async (kpi: string) => memory.kept.get(kpi) ?? []);
  memory.reportUrl = vi.fn(async (month: string) => `https://store.example/apps/s1/x/reports/${month}.csv?X-Amz-Signature=x`);
  return memory as Memory;
}

export function memoryServer(): Memory {
  const memory: Partial<Memory> & Pick<Memory, "kept"> = { kept: new Map() };
  memory.reset = () => {
    memory.kept.clear();
    fill(memory);
  };
  return fill(memory);
}

/** The one the page's module gets in the tests that mock `./server`. */
export const server = memoryServer();
