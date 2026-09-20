/**
 * UI-15, UI-16 (T-2137): the name a typed manifest carries, which is what keeps Propose
 * disabled until the author has actually named something (T-1492, PF-57).
 *
 * The access dialogs open on an example. `manifestName` is the one question they ask of it —
 * "is there a name yet?" — so everything this function can get wrong is a Change proposed from
 * an untouched example, or a Propose button that stays grey over a manifest that is ready.
 */
import { describe, expect, it } from "vitest";
import { manifestName } from "../src/pages/access/manifestName";

describe("the name a manifest carries", () => {
  it("reads metadata.name out of a manifest", () => {
    expect(manifestName("metadata:\n  name: steward\n")).toBe("steward");
    expect(manifestName("kind: Role\nmetadata:\n  name: air-quality-steward\n")).toBe(
      "air-quality-steward",
    );
  });

  it("has no name for what has none", () => {
    for (const source of [
      "",
      "   \n",
      "kind: Role\n",
      "metadata: {}\n",
      "metadata:\n  name:\n",
      "metadata:\n  name: '   '\n",
    ]) {
      expect(manifestName(source), source).toBe("");
    }
  });

  it("has no name for a value that is not one", () => {
    // A name is a string. A list, a map or a number under `name` is a manifest the platform
    // would refuse, and Propose must stay disabled rather than send it.
    expect(manifestName("metadata:\n  name: [a, b]\n")).toBe("");
    expect(manifestName("metadata:\n  name:\n    en: Steward\n")).toBe("");
    expect(manifestName("metadata:\n  name: 42\n")).toBe("");
    expect(manifestName("metadata:\n  name: true\n")).toBe("");
  });

  it("has no name while the document does not parse", () => {
    // Half-typed YAML is the normal state of an open editor, not an error to show.
    expect(manifestName("metadata: [\n")).toBe("");
    expect(manifestName("\tname: steward")).toBe("");
    expect(manifestName("metadata:\n  name: steward\n   name: other\n")).toBe("");
  });

  it("reads a name that only looks like another one exactly as typed", () => {
    // Two names a person cannot tell apart are two names, and the platform decides whether the
    // second one may exist. This function must not fold them together, or the dialog would
    // enable Propose for a name nobody meant to write: `Steward` is not `steward`, and the
    // Cyrillic `е` of `stеward` is not the Latin one.
    expect(manifestName("metadata:\n  name: Steward\n")).toBe("Steward");
    expect(manifestName("metadata:\n  name: stеward\n")).toBe("stеward");
    expect(manifestName("metadata:\n  name: stеward\n")).not.toBe("steward");
    expect(manifestName("metadata:\n  name: steward​\n")).toBe("steward​");
    expect(manifestName("metadata:\n  name: org\n")).toBe("org");
  });

  it("keeps a name the surrounding whitespace hid", () => {
    expect(manifestName("metadata:\n  name: '  steward  '\n")).toBe("steward");
    expect(manifestName('metadata:\n  name: "steward\\n"\n')).toBe("steward");
  });

  it("ignores everything else the document says", () => {
    const source = [
      "apiVersion: joinedcontext.com/v1alpha1",
      "kind: Group",
      "metadata:",
      "  name: air-quality-stewards",
      "  namespace: org",
      "spec:",
      "  members: [jana, peter]",
      "",
    ].join("\n");
    expect(manifestName(source)).toBe("air-quality-stewards");
  });
});
