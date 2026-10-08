// covers (T-2137, the module gate in gate_modules.test.ts): src/pages/policies/policySentence.ts.
/** T-3276: a Policy reads as a sentence built from the same values as its YAML. */
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/i18n";
import { policySentence } from "../src/pages/policies/policySentence";

const t = (key: string, options?: Record<string, unknown>): string => String(i18n.t(key, options as never));

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("a Policy in words (T-3276)", () => {
  it("says who may do what to which types and attributes, where, and for how long", () => {
    const sentence = policySentence(
      {
        contextSpaceRef: "ovzdusie",
        assignee: { kind: "group", id: "air-team" },
        operations: ["retrieveOps", "createEntity"],
        information: [{ entities: [{ type: "AirQualityObserved" }, { type: "Device" }], propertyNames: ["pm10"], relationshipNames: ["refDevice"] }],
        q: "pm10>20",
        validity: { from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" },
      },
      t,
      "en",
    );
    expect(sentence).toBe(
      "Members of the group air-team may read and create entity on AirQualityObserved and Device in the space ovzdusie, only the attributes pm10 and refDevice, where pm10>20, from Jan 1, 2026 until Dec 31, 2026.",
    );
  });

  it("says may not for a prohibition, every type when none is named, and nobody before a grantee is picked", () => {
    expect(policySentence({ effect: "prohibition", contextSpaceRef: "s", assignee: { kind: "role", id: "viewer" }, operations: ["deleteEntity"] }, t, "en")).toBe(
      "Holders of the role viewer may not delete entity on every type in the space s.",
    );
    expect(policySentence({}, t, "en")).toBe("Nobody yet may nothing yet on every type in the space —.");
  });

  it("speaks the person's language", async () => {
    await i18n.changeLanguage("sk");
    const sentence = policySentence(
      { contextSpaceRef: "ovzdusie", assignee: { kind: "role", id: "editor" }, operations: ["retrieveOps"], validity: { to: "2026-12-31T00:00:00Z" } },
      t,
      "sk",
    );
    expect(sentence).toMatch(/^Držitelia roly editor smú .* v priestore ovzdusie, do /);
  });
});
