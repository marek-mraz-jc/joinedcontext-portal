import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, Problem, server } from "./server";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("the App's server", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers at /apps/{name}/api, and a name that is not an App's never builds a path", () => {
    expect(apiBase("data-quality-inspector")).toBe("/apps/data-quality-inspector/api");
    expect(apiBase(undefined)).toBe("/api");
    expect(apiBase("../x")).toBe("/api");
  });

  it("reads the runs, makes one, reads a report's URL, and an answer that is not a success is a Problem with its detail", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/runs" && init?.method === "POST") return json(201, { id: 4 });
      if (url === "/api/runs") return json(200, { runs: [], stale: false });
      if (url === "/api/runs/4/report") return json(200, { url: "https://store.test/r.json" });
      if (url === "/api/runs/5/report") return json(404, { title: "Not Found", detail: "no such run" });
      return new Response("<html>", { status: 502 });
    });
    vi.stubGlobal("fetch", fetch);
    const api = server("/api");
    expect(await api.runs()).toEqual({ runs: [], stale: false });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" });
    expect(await api.runNow()).toBe(4);
    expect(await api.reportUrl(4)).toBe("https://store.test/r.json");
    const refused = await api.reportUrl(5).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Problem);
    expect(refused).toMatchObject({ status: 404, message: "no such run" });
    await expect(api.reportUrl(6)).rejects.toMatchObject({ status: 502, message: "HTTP 502" });
  });
});
