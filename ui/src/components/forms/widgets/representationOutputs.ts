/**
 * `spec.representations.ical` and `spec.representations.feed` as the Endpoint form edits them:
 * each a list of named outputs (API/11 EP-159, owner 2026-10-22T09:30Z). The rules that refuse an
 * output (slug, duplicate name, 20 at most, a role naming a slot the model lacks, a filter the
 * broker would refuse) are jc-core's: the form's dry run answers them per member, with a 422 on
 * propose. This file holds what the editor draws and writes.
 */
import type { IcalMapping } from "./icalMapping";

export type Format = "ical" | "feed";

/** An output's query on top of the view: it narrows, never widens (EP-157). */
export interface OutputFilter {
  q?: string;
  scopeQ?: string;
}

export interface FeedSource {
  type: string;
  preset?: string;
  mapping?: Record<string, string | string[]>;
}

export interface Output<S> {
  name: string;
  title?: Record<string, string>;
  description?: Record<string, string>;
  sources: S[];
  filter?: OutputFilter;
  [member: string]: unknown;
}

export type IcalOutput = Output<IcalMapping>;
export type FeedOutput = Output<FeedSource>;

export interface Outputs {
  ical: IcalOutput[];
  feed: FeedOutput[];
}

/** The most outputs of one format an Endpoint lists (jc-core MAX_OUTPUTS). */
export const MAX_OUTPUTS = 20;

/** The name the deprecated single calendar object loads as (jc-core LEGACY_OUTPUT). */
const LEGACY_OUTPUT = "events";

export const FEED_PRESETS = ["event", "article", "generic"] as const;

/** The roles of a feed entry in table order; title and updated are required. */
export const FEED_ROLES: { role: string; required: boolean }[] = [
  { role: "title", required: true },
  { role: "updated", required: true },
  { role: "published", required: false },
  { role: "summary", required: false },
  { role: "content", required: false },
  { role: "link", required: false },
  { role: "author", required: false },
  { role: "category", required: false },
  { role: "image", required: false },
];

/** What a feed preset maps each role from, first path that has a value (jc-core preset_roles). */
const FEED_PRESET_ROLES: Record<string, Record<string, string[]>> = {
  event: {
    title: ["name"],
    updated: ["modifiedAt"],
    published: ["createdAt"],
    summary: ["description"],
    link: ["url"],
    author: ["organizer"],
    category: ["category"],
    image: ["image"],
  },
  article: {
    title: ["headline", "name"],
    updated: ["dateModified", "modifiedAt"],
    published: ["datePublished", "dateCreated"],
    summary: ["description"],
    content: ["articleBody"],
    link: ["url"],
    author: ["author"],
    category: ["category"],
    image: ["image"],
  },
  generic: { title: ["name"], updated: ["modifiedAt"], summary: ["description"], link: ["url"] },
};

export function feedPresetRoles(preset: string | undefined): Record<string, string[]> {
  return (preset && FEED_PRESET_ROLES[preset]) || {};
}

/**
 * The lists an Endpoint holds; the single calendar object of version 1 reads as one output named
 * `events`, which is what the platform loads it as and what `events.ics` keeps serving.
 */
export function outputsOf(value: unknown): Outputs {
  const block = (value ?? {}) as { ical?: unknown; feed?: unknown };
  const ical = Array.isArray(block.ical)
    ? (block.ical as IcalOutput[])
    : block.ical && typeof block.ical === "object"
      ? [{ name: LEGACY_OUTPUT, sources: [block.ical as IcalMapping] }]
      : [];
  const feed = Array.isArray(block.feed) ? (block.feed as FeedOutput[]) : [];
  return { ical, feed };
}

/** What the form writes back: the members it does not edit kept, an empty list left out. */
export function written(previous: unknown, next: Outputs): Record<string, unknown> | undefined {
  const rest = { ...((previous ?? {}) as Record<string, unknown>) };
  delete rest.ical;
  delete rest.feed;
  const out: Record<string, unknown> = { ...rest };
  if (next.ical.length > 0) out.ical = next.ical;
  if (next.feed.length > 0) out.feed = next.feed;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A slug the platform accepts: a-z, 0-9 and -, starting with a letter or digit. */
export function isSlug(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(name);
}

/** The first `{base}`, `{base}-2`, … no output of the format holds yet. */
export function freeName(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** A new output of `format` over `type`, from the preset that fits it. */
export function newOutput(format: Format, taken: string[], type: string): IcalOutput | FeedOutput {
  if (format === "ical") {
    return { name: freeName(taken, "kalendar"), sources: [{ type, preset: "sdm-event" }] };
  }
  return { name: freeName(taken, "novinky"), sources: [{ type, preset: type === "Event" ? "event" : "generic" }] };
}

/** Names that occur more than once, which the save refuses. */
export function duplicateNames(outputs: { name: string }[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const { name } of outputs) (seen.has(name) ? twice : seen).add(name);
  return [...twice];
}

/** A text per language with `lang` set to `text`, the key dropped when emptied. */
export function withText(texts: Record<string, string> | undefined, lang: string, text: string): Record<string, string> | undefined {
  const next = { ...(texts ?? {}) };
  if (text.trim() === "") delete next[lang];
  else next[lang] = text;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A feed role set to one attribute, or back to the preset's when emptied. */
export function withRole(source: FeedSource, role: string, attribute: string): FeedSource {
  const mapping = { ...(source.mapping ?? {}) };
  if (attribute === "") delete mapping[role];
  else mapping[role] = attribute;
  const next: FeedSource = { ...source, mapping };
  if (Object.keys(mapping).length === 0) delete next.mapping;
  return next;
}

/** The required roles neither the preset nor the mapping fills; the server says the rest. */
export function unmappedRoles(source: FeedSource): string[] {
  const preset = feedPresetRoles(source.preset);
  return FEED_ROLES.filter(({ required }) => required)
    .map(({ role }) => role)
    .filter((role) => source.mapping?.[role] === undefined && preset[role] === undefined);
}
