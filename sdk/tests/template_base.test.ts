import { describe, expect, it } from "vitest";
import template from "../template/vite.config";

// AP-14 (T-2724): a run cannot write `vite.config.ts`, so every generated app builds with the
// template's. Its asset URLs are relative: an app is served under `/apps/{name}/` (or a
// `ui-rust` server's JC_BASE_PATH), and `/assets/…` would be asked of the origin's root.
describe("the template's build", () => {
  it("writes relative asset URLs", () => {
    expect(template).toMatchObject({ base: "./" });
  });
});
