import { api } from "./client";

/**
 * One run of a candidate pipeline over a sample (PL-43, API/01 §7a), through the typed client
 * (UI-07): the route is the API's own and the csrf and session handling are the client's.
 *
 * The document publishes the trace as an object (it is jcctl's `TestTrace`, which carries no
 * schema), so its shape is written here once, beside the one call that reads it.
 */

export type SampleFormat = "csv" | "json" | "text";

export type TestSample = { url: string; format: SampleFormat } | { text: string; format: SampleFormat };

export interface Trace {
  input: { events: number; bytes: number; sample?: unknown };
  mapping: unknown[];
  validation: { index: number; ok: boolean; problems: string[] }[];
  errors: {
    stage: string;
    /** The step of `spec.steps` a `mapping` error failed at (PL-52); absent on lint and runner. */
    step?: number | null;
    line?: number | null;
    message: string;
  }[];
}

/** The trace, or the status and the reason the route refused the run. */
export type TestAnswer = { trace: Trace } | { status: number; detail?: string };

export async function testPipeline(
  project: string,
  pipeline: unknown,
  sample: TestSample,
): Promise<TestAnswer> {
  const { data, error, response } = await api.POST("/api/v1/projects/{project}/pipelines/test", {
    params: { path: { project } },
    body: { pipeline, sample },
  });
  if (data !== undefined) {
    return { trace: data as unknown as Trace };
  }
  const detail = (error as { detail?: unknown } | undefined)?.detail;
  return { status: response.status, detail: typeof detail === "string" ? detail : undefined };
}
