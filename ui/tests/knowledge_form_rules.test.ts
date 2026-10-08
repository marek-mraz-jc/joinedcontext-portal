/**
 * T-3220: what a new user meets on the knowledge assistant's two forms before anything is sent.
 * A channel nobody signs in to needs its origins, a rate limit and a budget (MF-52), and the form
 * says so at those fields instead of jc-core refusing the proposal; the formats a person types
 * by hand are refused in words that name the format.
 */
import { describe, expect, it } from "vitest";
import validator from "../src/components/forms/validator";
import { errorMessageKey } from "../src/components/forms/errorMessages";
import { CRON, HEX_COLOR, HTTPS_URL, LANGUAGE, ORIGIN, SITE_PATH, assistantDeploymentSchema } from "../src/schemas/knowledge";
import en from "../src/locales/en.json";

const t = (key: string) => key;

const base = { name: "town-help", publicId: "town-help" };
const errorsOf = (form: Record<string, unknown>) =>
  validator
    .validateFormData(form, assistantDeploymentSchema(t))
    .errors.filter((e) => e.name !== "if")
    .map((e) => `${String(e.property).replace(/^\./, "")}:${e.name}`);

describe("an assistant deployment's channel", () => {
  it("a public, catalogue or embedded channel without origins, rate limit or budget is refused at those fields", () => {
    for (const channel of ["public", "ckan", "iframe"]) {
      const errors = errorsOf({ ...base, channel });
      expect(errors, channel).toEqual(
        expect.arrayContaining(["allowedOrigins:required", "rateLimit:required", "budget:required"]),
      );
      const partial = errorsOf({ ...base, channel, allowedOrigins: [], rateLimit: { requestsPerMinute: 30 }, budget: { tokensPerDay: 1000 } });
      expect(partial, channel).toEqual(
        expect.arrayContaining(["allowedOrigins:minItems", "rateLimit.perClientPerMinute:required", "budget.tokensPerConversation:required"]),
      );
    }
  });

  it("a public channel with all three, and an internal channel with none, pass", () => {
    expect(
      errorsOf({
        ...base,
        channel: "public",
        allowedOrigins: ["https://www.example.org"],
        rateLimit: { requestsPerMinute: 30, perClientPerMinute: 6 },
        budget: { tokensPerDay: 300000, tokensPerConversation: 40000 },
      }),
    ).toEqual([]);
    expect(errorsOf({ ...base, channel: "internal" })).toEqual([]);
  });
});

describe("the formats typed by hand", () => {
  it("are refused in words that name the format", () => {
    const of = (pattern: string) =>
      errorMessageKey(
        { name: "pattern", schemaPath: "#/properties/x/pattern" } as never,
        { type: "object", properties: { x: { type: "string", pattern } } } as never,
      );
    expect(of(HTTPS_URL)).toBe("form.httpsUrl");
    expect(of(CRON)).toBe("form.cron");
    expect(of(ORIGIN)).toBe("form.origin");
    expect(of(LANGUAGE)).toBe("form.language");
    expect(of(SITE_PATH)).toBe("form.sitePath");
    expect(of(HEX_COLOR)).toBe("form.color");
    for (const key of ["cron", "origin", "language", "sitePath", "color"] as const) {
      expect(en.form[key], key).toMatch(/such as/);
    }
  });
});
