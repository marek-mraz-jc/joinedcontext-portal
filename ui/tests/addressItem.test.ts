import { describe, expect, it } from "vitest";
import { addressItem } from "../src/components/layout/Shell";

describe("addressItem", () => {
  it("names the item of a section by its address", () => {
    expect(addressItem("/projects/p/endpoints/air-quality")).toEqual({ itemName: "air-quality" });
    expect(addressItem("/projects/p/spaces/city/data")).toEqual({ itemName: "city" });
  });

  it("decodes a segment and keeps a broken escape as typed", () => {
    expect(addressItem("/projects/p/endpoints/a%20b")).toEqual({ itemName: "a b" });
    expect(addressItem("/projects/p/endpoints/a%zz")).toEqual({ itemName: "a%zz" });
  });

  it("names a static Context Spaces page in words, never as a space", () => {
    expect(addressItem("/projects/p/spaces/complete")).toEqual({ spacePage: "spaces.complete.title" });
    expect(addressItem("/projects/p/spaces/upload")).toEqual({ spacePage: "spaces.upload.title" });
    // Deeper, it is a space of that name; elsewhere, an item of that name.
    expect(addressItem("/projects/p/spaces/upload/data")).toEqual({ itemName: "upload" });
    expect(addressItem("/projects/p/endpoints/upload")).toEqual({ itemName: "upload" });
  });

  it("names nothing on a create form, a section list or outside a project", () => {
    expect(addressItem("/projects/p/endpoints/new")).toEqual({});
    expect(addressItem("/projects/p/endpoints")).toEqual({});
    expect(addressItem("/organization/people/x")).toEqual({});
  });
});
