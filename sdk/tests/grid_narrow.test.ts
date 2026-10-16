import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// T-4242 (T-4162 #6): at a phone's width the pinned name keeps room to read, and the table shows
// that more columns wait to its right instead of cutting them off with no hint.
describe("the grid at a phone's width", () => {
  const css = readFileSync("src/grid/grid.css", "utf8");

  it("keeps the pinned name a column to read in on a narrow screen", () => {
    const narrow = css.slice(css.indexOf("@media (width <= 640px)"));
    expect(narrow).toMatch(/\.jc-grid td\.jc-grid-pinned[^{]*\{[^}]*min-width:\s*min\(45vw, 12rem\)/);
  });

  it("shadows the right edge while the table scrolls on", () => {
    const scroll = css.match(/\.jc-grid-scroll\s*\{[^}]*\}/)?.[0] ?? "";
    expect(scroll).toMatch(/background:[^;]*\blocal\b[^;]*\bscroll\b/s);
  });
});
