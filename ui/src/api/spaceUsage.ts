import { api, ApiError, unwrap } from "./client";
import type { components } from "./schema";

/**
 * How much a space holds (T-2889, API/01 §28): the broker's entity count of the space, which the
 * Portal keeps for five minutes, so the page keeps it as long and never retries a refusal.
 */
export type SpaceUsage = components["schemas"]["SpaceUsage"];

const FIVE_MINUTES = 5 * 60 * 1000;

export function spaceUsageQuery(project: string, space: string) {
  return {
    queryKey: ["space-usage", project, space] as const,
    staleTime: FIVE_MINUTES,
    retry: false,
    queryFn: async (): Promise<SpaceUsage> =>
      unwrap(
        await api.GET("/api/v1/projects/{project}/spaces/{space}/usage", {
          params: { path: { project, space } },
        }),
      ),
  };
}

/** Why a count cannot be shown, in the server's words when it gave some. */
export function usageRefusal(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem?.detail ?? error.message;
  }
  return error instanceof Error ? error.message : "";
}
