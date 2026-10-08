import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, notesApi, Problem } from "./notes";

afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("the notes server", () => {
  it("is reached below the App's own name, and nowhere a bad name could lead", () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<script id="jc-config" type="application/json">{"appName": "notes"}</script>';
    expect(apiBase(doc)).toBe("/apps/notes/api");
    doc.getElementById("jc-config")!.textContent = '{"appName": "../x"}';
    expect(apiBase(doc)).toBe("/api");
    doc.getElementById("jc-config")!.textContent = "{";
    expect(apiBase(doc)).toBe("/api");
  });

  it("sends a note as JSON and reads the problem a refusal carries", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(201, { id: 1, body: "hi", file: null, created_at: "" })).mockResolvedValueOnce(answer(400, { detail: "a note has some text" }));
    vi.stubGlobal("fetch", fetch);
    const api = notesApi("/apps/notes/api");
    expect((await api.add("hi")).id).toBe(1);
    expect(fetch.mock.calls[0][0]).toBe("/apps/notes/api/notes");
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ body: "hi" });
    await expect(api.add("")).rejects.toEqual(new Problem(400, "a note has some text"));
  });

  it("uploads a file to the URL the server gave, never through the server", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(answer(200, { url: "https://store.example/apps/s1/a/notes/1/a.txt?X-Amz-Signature=x" })).mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await notesApi("/api").upload(1, new File(["milk"], "a.txt", { type: "text/plain" }));
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual({ name: "a.txt", contentType: "text/plain" });
    expect(fetch.mock.calls[1][0]).toBe("https://store.example/apps/s1/a/notes/1/a.txt?X-Amz-Signature=x");
    expect(fetch.mock.calls[1][1].method).toBe("PUT");
  });

  it("says when the store refused the file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(answer(200, { url: "https://store.example/x" })).mockResolvedValueOnce(new Response(null, { status: 403 })));
    await expect(notesApi("/api").upload(1, new File(["x"], "x.txt"))).rejects.toThrow("could not be stored");
  });
});
