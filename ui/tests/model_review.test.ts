import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withRange } from "../src/pages/spaces/ModelReview";

describe("withRange (T-6456)", () => {
  it("changes a shared slot's range and keeps the rest of the model", () => {
    const out = withRange("id: https://x/m\nclasses:\n  T:\n    slots: [a]\nslots:\n  a: { range: integer, title: { en: A } }\n", "T", "a", "string");
    expect(parse(out)).toMatchObject({ id: "https://x/m", slots: { a: { range: "string", title: { en: "A" } } } });
  });

  it("changes an attribute written on the class", () => {
    const out = withRange("classes:\n  T:\n    attributes:\n      a:\n        range: float\n", "T", "a", "date");
    expect(parse(out)).toEqual({ classes: { T: { attributes: { a: { range: "date" } } } } });
  });
});
