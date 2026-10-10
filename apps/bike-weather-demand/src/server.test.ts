import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, Problem, server } from "./server";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the App's server", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers at /apps/{name}/api, and a name that is not an App's never builds a path", () => {
    expect(apiBase("bike-weather-demand")).toBe("/apps/bike-weather-demand/api");
    expect(apiBase(undefined)).toBe("/api");
    expect(apiBase("../x")).toBe("/api");
  });

  it("asks for a station's models and a model's training data, and an answer that is not a success is a Problem with its detail", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === "/api/models?station=urn%3Angsi-ld%3AB%3A1") return json(200, { models: [], stale: false });
      if (url === "/api/models/3/snapshot") return json(200, { url: "https://store.test/t.json" });
      if (url === "/api/models/4/snapshot") return json(404, { title: "Not Found", detail: "no such model" });
      return new Response("<html>", { status: 502 });
    });
    vi.stubGlobal("fetch", fetch);
    const api = server("/api");
    expect(await api.models("urn:ngsi-ld:B:1")).toEqual({ models: [], stale: false });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
    expect(await api.snapshotUrl(3)).toBe("https://store.test/t.json");
    const refused = await api.snapshotUrl(4).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Problem);
    expect(refused).toMatchObject({ status: 404, message: "no such model" });
    await expect(api.snapshotUrl(5)).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
  });
});
