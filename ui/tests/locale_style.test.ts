/**
 * Plain copy (T-0755, UI-01, UI-45): the Portal speaks like a tool, not a chatbot. The English
 * bundle carries no first person, no filler adverbs or sales words, and no bundle shouts.
 */
import { describe, expect, it } from "vitest";
import cs from "../src/locales/cs.json";
import de from "../src/locales/de.json";
import en from "../src/locales/en.json";
import sk from "../src/locales/sk.json";

function strings(bundle: Record<string, unknown>, prefix = ""): [string, string][] {
  return Object.entries(bundle).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      return [[path, value]];
    }
    return value && typeof value === "object" ? strings(value as Record<string, unknown>, path) : [];
  });
}

const BANNED = [
  /\bI\b/,
  /\b(I'll|I've|I'm|I'd|let me|let's)\b/i,
  /\b(successfully|seamless(ly)?|powerful|effortless(ly)?|awesome|amazing|oops|sorry)\b/i,
];

describe("locale style", () => {
  it("keeps the English strings free of the assistant voice and filler", () => {
    const offending = strings(en).filter(([, text]) => BANNED.some((pattern) => pattern.test(text)));
    expect(offending).toEqual([]);
  });

  it.each([
    ["en", en],
    ["sk", sk],
    ["cs", cs],
    ["de", de],
  ])("puts no exclamation mark in the %s strings", (_, bundle) => {
    expect(strings(bundle).filter(([, text]) => text.includes("!"))).toEqual([]);
  });

  it.each([
    ["en", en],
    ["sk", sk],
    ["cs", cs],
    ["de", de],
  ])("writes every placeholder of the %s strings with the single braces ICU reads", (_, bundle) => {
    expect(strings(bundle).filter(([, text]) => /\{\{\w+\}\}/.test(text))).toEqual([]);
  });

  it("fails on the phrases it bans", () => {
    const bad = { a: { b: "I have stored it" }, c: "Let's continue where we left off.", d: "Saved successfully" };
    expect(strings(bad).filter(([, text]) => BANNED.some((pattern) => pattern.test(text)))).toHaveLength(3);
  });

  it.each([
    ["en", en],
    ["sk", sk],
    ["cs", cs],
    ["de", de],
  ])("keeps Git words off the %s copy strings (T-1252, UI-61)", (_, bundle) => {
    const git = /\b(git|branch|merge|commit|pull request|rebase)\b|vetv|větev|zweig/i;
    const copy = strings((bundle as Record<string, Record<string, unknown>>).workspaces, "workspaces");
    expect(copy.length).toBeGreaterThan(40);
    expect(copy.filter(([, text]) => git.test(text))).toEqual([]);
  });

  // One example per form (T-2882): an "e.g." on field after field drowns the one that helps. A
  // form's strings share a parent key, so a group holding two examples is a form holding two.
  const EXAMPLE_MARKERS: Record<string, RegExp> = {
    en: /\be\.g\.|\bfor example\b/i,
    sk: /\bnapr\.|\bnapríklad\b/i,
    cs: /\bnapř\.|\bnapříklad\b/i,
    de: /\bz\. ?B\.|\bzum Beispiel\b|\bbeispielsweise\b/i,
  };
  // Not forms: the model editor's first-steps tips each show their own step, and the assistant's
  // empty search answers suggest what to type instead.
  const NOT_A_FORM = new Set(["models.hints", "agentRun.catalog"]);

  function examplesPerGroup(bundle: Record<string, unknown>, marker: RegExp): Record<string, string[]> {
    const groups: Record<string, string[]> = {};
    for (const [key, text] of strings(bundle)) {
      const group = key.slice(0, key.lastIndexOf("."));
      if (marker.test(text) && !NOT_A_FORM.has(group)) {
        (groups[group] ??= []).push(key);
      }
    }
    return groups;
  }

  it.each([
    ["en", en],
    ["sk", sk],
    ["cs", cs],
    ["de", de],
  ])("gives no form of the %s strings more than one example (T-2882)", (lang, bundle) => {
    const crowded = Object.entries(examplesPerGroup(bundle, EXAMPLE_MARKERS[lang])).filter(([, keys]) => keys.length > 1);
    expect(crowded).toEqual([]);
  });

  it("counts two examples in one form as crowded", () => {
    const form = { form: { nameHint: "Lowercase, e.g. bikes-app.", typeHint: "Entity type, e.g. Vehicle", other: "Plain." } };
    expect(examplesPerGroup(form, EXAMPLE_MARKERS.en)).toEqual({ form: ["form.nameHint", "form.typeHint"] });
  });
});
