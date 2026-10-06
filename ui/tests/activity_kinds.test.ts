import { describe, expect, it } from "vitest";
import cs from "../src/locales/cs.json";
import de from "../src/locales/de.json";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";
import { ACTIVITY_KINDS } from "../src/api/activity";

/** The label `activity.kinds.<kind>` names in one locale, or nothing. */
function label(locale: unknown, kind: string): unknown {
  return ["activity", "kinds", ...kind.split(".")].reduce<unknown>(
    (node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined),
    locale,
  );
}

describe("ACTIVITY_KINDS", () => {
  // T-3065: the live tail listens for these kinds alone and the filter offers them alone, so a
  // kind missing here (person.changed was) never reaches the feed as it happens.
  it("holds the person and model key kinds the Portal writes to the org project", () => {
    expect(ACTIVITY_KINDS).toContain("person.changed");
    expect(ACTIVITY_KINDS).toContain("model.key");
    expect(new Set(ACTIVITY_KINDS).size).toBe(ACTIVITY_KINDS.length);
  });

  it("names every kind in every language", () => {
    for (const [name, locale] of Object.entries({ cs, de, en, sk })) {
      for (const kind of ACTIVITY_KINDS) {
        expect(typeof label(locale, kind), `${name}: activity.kinds.${kind}`).toBe("string");
      }
    }
  });
});
