/**
 * T-6404: a sweep worker hands a fetched bundle chunk to its later contexts, decoded, and only a
 * whole 200; it counts the edge's requests per minute.
 */
// covers: e2e/live/edgeShare.ts
import { describe, expect, it } from "vitest";
import { keepable, minuteOf, replayHeaders } from "../e2e/live/edgeShare";

describe("edgeShare", () => {
  it("drops the headers of the encoded body and keeps the rest", () => {
    expect(
      replayHeaders({ "Content-Encoding": "br", "content-length": "10", "transfer-encoding": "chunked", "content-type": "text/javascript", etag: "x" }),
    ).toEqual({ "content-type": "text/javascript", etag: "x" });
  });

  it("keeps only a 200, never the edge's 429 or an error", () => {
    const asset = (status: number) => ({ status, headers: {}, body: Buffer.from("") });
    expect(keepable(asset(200))).toBe(true);
    expect([429, 502, 404].map((status) => keepable(asset(status)))).toEqual([false, false, false]);
  });

  it("counts by UTC minute", () => {
    expect(minuteOf(Date.UTC(2026, 10, 2, 1, 7, 59, 999))).toBe("2026-11-02T01:07");
  });
});
