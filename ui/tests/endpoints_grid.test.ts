/**
 * T-6645: an OData row of the Endpoints set maps back to the page's own row, so the row menu acts
 * on the manifest the page read: an own row by its name, a shared row by `{source}/{name}`, a
 * reference whose Endpoint went away by the reference's name.
 */
import { describe, expect, it } from "vitest";
import type { Manifest } from "../src/api/manifest";
import { pageRow } from "../src/pages/endpoints/EndpointsGrid";

const manifest = (kind: string, name: string, namespace: string): Manifest =>
  ({ apiVersion: "joinedcontext.com/v1alpha1", kind, metadata: { name, namespace }, spec: {} }) as Manifest;

const air = manifest("Endpoint", "air", "helsinki");
const parking = manifest("Endpoint", "parking", "espoo");
const usesParking = manifest("SharedSpaceReference", "uses-parking", "helsinki");
const gone = manifest("SharedSpaceReference", "uses-gone", "helsinki");
const manifests = {
  own: new Map([["air", air]]),
  shared: new Map([["espoo/parking", parking]]),
  references: new Map([
    ["uses-parking", usesParking],
    ["uses-gone", gone],
  ]),
};

describe("an OData row of the Endpoints set", () => {
  it("is the project's own Endpoint by its name", () => {
    expect(pageRow("helsinki", { id: "air", name: "air", kind: "own" }, manifests)).toEqual({
      key: "helsinki/air",
      source: "helsinki",
      own: true,
      endpoint: air,
      reference: null,
    });
  });

  it("is a shared Endpoint by its source and name, with the reference that uses it", () => {
    const row = pageRow("helsinki", { id: "espoo/parking", name: "parking", kind: "shared", source: "espoo", reference: "uses-parking" }, manifests);
    expect(row).toEqual({ key: "espoo/parking", source: "espoo", own: false, endpoint: parking, reference: usesParking });
  });

  it("is a reference whose Endpoint went away, with no Endpoint", () => {
    const row = pageRow("helsinki", { id: "reference:uses-gone", name: "uses-gone", kind: "gone", reference: "uses-gone" }, manifests);
    expect(row).toEqual({ key: "gone/uses-gone", source: null, own: false, endpoint: null, reference: gone });
  });

  it("has no manifest for a row the page's lists do not hold", () => {
    expect(pageRow("helsinki", { id: "new", name: "new", kind: "own" }, manifests).endpoint).toBeNull();
  });
});
