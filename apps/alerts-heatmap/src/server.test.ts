import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, Problem, server } from "./server";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the App's server", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers at /apps/{name}/api, and a name that is not an App's never builds a path", () => {
    expect(apiBase("alerts-heatmap")).toBe("/apps/alerts-heatmap/api");
    expect(apiBase(undefined)).toBe("/api");
    expect(apiBase("../x")).toBe("/api");
  });

  it("reads and writes JSON, and an answer that is not a success is a Problem with its detail", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/weeks")) return json(200, { weeks: [], stale: false });
      if (url.endsWith("/reports") && init?.method === "POST") return json(400, { title: "Bad Request", detail: "a report's title has 1 to 120 characters" });
      return json(502, {});
    });
    vi.stubGlobal("fetch", fetch);
    const api = server("/apps/a/api");
    expect(await api.weeks()).toEqual({ weeks: [], stale: false });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" });
    const refused = await api.save({ title: "", view: "", kept: 0, places: [] }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Problem);
    expect(refused).toMatchObject({ status: 400, message: "a report's title has 1 to 120 characters" });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ title: "", view: "", kept: 0, places: [] });
    await expect(api.reports()).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
  });

  it("puts a picture to the URL the server hands out, and says when the store refuses it", async () => {
    const puts: Array<[string, RequestInit | undefined]> = [];
    let store = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/reports/3/snapshot" && init?.method === "POST") return json(200, { url: "https://store.test/put", method: "PUT" });
        if (url === "/api/reports/3/snapshot") return json(200, { url: "https://store.test/get" });
        puts.push([url, init]);
        return new Response(null, { status: store });
      }),
    );
    const api = server("/api");
    const png = new Blob(["png"], { type: "image/png" });
    await api.attach(3, png);
    expect(puts[0]?.[0]).toBe("https://store.test/put");
    expect(puts[0]?.[1]).toMatchObject({ method: "PUT", body: png, headers: { "Content-Type": "image/png" } });
    store = 403;
    await expect(api.attach(3, png)).rejects.toMatchObject({ status: 403 });
    expect(await api.snapshotUrl(3)).toBe("https://store.test/get");
  });
});
