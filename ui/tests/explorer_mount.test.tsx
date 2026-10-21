/**
 * T-5082: the catalogue's script mounts the Endpoint data view only for an `https://api.{domain}`
 * origin and a slug; anything else in explore.html's address is refused before a request leaves.
 */
import { describe, expect, it, vi } from "vitest";
import { mount } from "../src/explorer/main";

describe("the catalogue widget's mount", () => {
  it("refuses an origin that is not an api host and a slug that is no Endpoint's", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const element = document.createElement("div");
    for (const origin of ["http://api.example.test", "https://evil.test", "https://api.example.test/x", "https://user@api.example.test"]) {
      expect(() => mount(element, { origin, slug: "air" })).toThrow(/origin/);
    }
    for (const slug of ["", "../x", "a/b", "A".repeat(65)]) {
      expect(() => mount(element, { origin: "https://api.example.test", slug })).toThrow(/slug/);
    }
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
