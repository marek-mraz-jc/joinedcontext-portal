import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/sdk/client";
import { bridgeTransport, CSRF_COOKIE, CSRF_HEADER, originTransport, transportFor } from "../src/sdk/transport";

/** Sends one request through the bridge transport the document names; the answer never comes. */
function bridgeFor(base: { slug: string; orgDomain: string; space: string }) {
  return transportFor({ ...base, transport: "bridge" })({ method: "GET", path: "/api/endpoint/demo/access" });
}

describe("originTransport", () => {
  it("includes CSRF header and content-type on PATCH, and omits them on GET", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const fakeDoc = { cookie: `${CSRF_COOKIE}=token-abc123; other=val` } as Document;
    const transport = originTransport(fakeFetch, fakeDoc);

    await transport({ method: "GET", path: "/api/endpoint/demo/access" });
    expect(calls[0].init?.headers).toEqual({ Accept: "application/json" });
    expect(calls[0].init?.body).toBeUndefined();

    await transport({ method: "PATCH", path: "/api/endpoint/demo/ngsi-ld/v1/entities/x/attrs", body: { a: 1 } });
    const patchHeaders = calls[1].init?.headers as Record<string, string>;
    expect(patchHeaders.Accept).toBe("application/json");
    expect(patchHeaders[CSRF_HEADER]).toBe("token-abc123");
    expect(patchHeaders["content-type"]).toBe("application/json");
    expect(calls[1].init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  // AP-84, SDK-23: a published app's function call rides on the edge's token, so the host refuses
  // it without the double-submit token; the call carries it the same way a data write does.
  it("sends a published app's endpoint calls under the app's path, and nothing else there", async () => {
    const urls: string[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fakeFetch);
    try {
      const send = transportFor({ slug: "demo", orgDomain: "example.org", space: "demo", transport: "origin", appName: "bikes" });
      await send({ method: "GET", path: "/api/endpoint/demo/ngsi-ld/v1/entities?type=A" });
      await send({ method: "PATCH", path: "/api/endpoint/demo/ngsi-ld/v1/entities/urn%3Ax/attrs", body: {} });
      await send({ method: "POST", path: "/apps/bikes/api/functions/sum", body: {} });
      expect(urls).toEqual([
        "/apps/bikes/api/endpoint/demo/ngsi-ld/v1/entities?type=A",
        "/apps/bikes/api/endpoint/demo/ngsi-ld/v1/entities/urn%3Ax/attrs",
        "/apps/bikes/api/functions/sum",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends a published app's function call with the CSRF header, to the app's own route", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ stations: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const fakeDoc = { cookie: `${CSRF_COOKIE}=token-fn` } as Document;
    const client = createClient(
      { slug: "demo", orgDomain: "example.org", space: "demo", transport: "origin", appName: "bikes" },
      originTransport(fakeFetch, fakeDoc),
    );

    await expect(client.functions.call("near-me", { radius: 500 })).resolves.toEqual({ stations: 3 });
    expect(calls[0].url).toBe("/apps/bikes/api/functions/near-me");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>)[CSRF_HEADER]).toBe("token-fn");
  });

  it("returns null body on 204, parses text when not json, and resolves status 0 on network error", async () => {
    const fakeFetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/no-content")) {
        return new Response(null, { status: 204 });
      }
      if (u.endsWith("/plain-text")) {
        return new Response("hello plain text", { status: 200, headers: { "content-type": "text/plain" } });
      }
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const transport = originTransport(fakeFetch);

    const r1 = await transport({ method: "DELETE", path: "/no-content" });
    expect(r1.status).toBe(204);
    expect(r1.body).toBeNull();

    const r2 = await transport({ method: "GET", path: "/plain-text" });
    expect(r2.status).toBe(200);
    expect(r2.body).toBe("hello plain text");

    const r3 = await transport({ method: "GET", path: "/offline" });
    expect(r3.status).toBe(0);
    expect((r3.body as { title: string }).title).toContain("Failed to fetch");
  });
});

describe("bridgeTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts jc-request, resolves only on matching id AND source, ignoring forged source", async () => {
    const target = {
      postMessage: vi.fn(),
    } as unknown as Window;

    let messageListener: ((ev: MessageEvent) => void) | undefined;
    const self = {
      addEventListener: vi.fn((_type: string, listener: (ev: MessageEvent) => void) => {
        messageListener = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    const transport = bridgeTransport({ target, self, timeoutMs: 5000 });
    const p = transport({ method: "GET", path: "/api/endpoint/demo/access" });

    expect(target.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "jc-request", id: 1, method: "GET", path: "/api/endpoint/demo/access" }),
      "*",
    );

    // Forged source ignored
    messageListener?.({
      source: {} as Window,
      data: { kind: "jc-response", id: 1, status: 200, body: { ok: true } },
    } as MessageEvent);

    // Wrong id ignored
    messageListener?.({
      source: target,
      data: { kind: "jc-response", id: 999, status: 200, body: { ok: true } },
    } as MessageEvent);

    // Matching source and id resolves
    messageListener?.({
      source: target,
      data: { kind: "jc-response", id: 1, status: 200, body: { ok: true } },
    } as MessageEvent);

    const res = await p;
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(self.removeEventListener).toHaveBeenCalled();
  });

  it("times out to status 0 when framing page does not answer", async () => {
    const target = { postMessage: vi.fn() } as unknown as Window;
    const self = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;

    const transport = bridgeTransport({ target, self, timeoutMs: 15000 });
    const p = transport({ method: "POST", path: "/functions/test" });

    vi.advanceTimersByTime(15000);
    const res = await p;
    expect(res.status).toBe(0);
    expect((res.body as { title: string }).title).toBe("The Portal did not answer.");
  });

  // SDK-06: the served document decides the transport, and each choice really is that
  // transport: `origin` is a same-origin fetch and never a message, `bridge` is a message to the
  // Portal frame and never a fetch of its own.
  it("takes the transport the served document names, and nothing else", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const postSpy = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
    try {
      const base = { slug: "demo", orgDomain: "example.org", space: "demo" };

      await transportFor({ ...base, transport: "origin", appName: "test-app" })({
        method: "GET",
        path: "/api/endpoint/demo/access",
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // T-2670: under the app's own path, where the apps session cookie reaches and the edge
      // sets it as the bearer; at /api/endpoint/ the call would go out anonymous.
      expect(fetchSpy).toHaveBeenCalledWith("/apps/test-app/api/endpoint/demo/access", expect.anything());
      expect(postSpy).not.toHaveBeenCalled();

      vi.useFakeTimers();
      const pending = bridgeFor(base);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(postSpy).toHaveBeenCalledTimes(1);
      expect((postSpy.mock.calls[0][0] as { kind: string }).kind).toBe("jc-request");
      vi.runAllTimers();
      expect((await pending).status).toBe(0);
    } finally {
      vi.useRealTimers();
      postSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
