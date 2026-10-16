import { api, ApiError, unwrap } from "./client";
import type { components } from "./schema";

/**
 * How much a space holds (T-2889, API/01 §29): the broker's entity count of the space, which the
 * Portal keeps for five minutes, so the page keeps it as long and never retries a refusal.
 */
export type SpaceUsage = components["schemas"]["SpaceUsage"];

const FIVE_MINUTES = 5 * 60 * 1000;

/** A count the broker has not given in this time is not coming: the page says so (T-4225). */
export const USAGE_TIMEOUT_MS = 15_000;

export function spaceUsageQuery(project: string, space: string) {
  return {
    queryKey: ["space-usage", project, space] as const,
    staleTime: FIVE_MINUTES,
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SpaceUsage> => {
      const call = new AbortController();
      const timer = setTimeout(
        () => call.abort(new DOMException("the count did not come", "TimeoutError")),
        USAGE_TIMEOUT_MS,
      );
      signal.addEventListener("abort", () => call.abort(signal.reason));
      try {
        return unwrap(
          await api.GET("/api/v1/projects/{project}/spaces/{space}/usage", {
            params: { path: { project, space } },
            signal: call.signal,
          }),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Why a count cannot be shown, in the server's words when it gave some. */
export function usageRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  return error instanceof Error ? error.message : "";
}
