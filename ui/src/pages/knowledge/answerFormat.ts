/**
 * What the chat shows of an answer (T-3325, AG-117): a small, safe part of Markdown read into a
 * plain tree that React renders as elements, so text the model writes stays text, and the
 * answer's citations grouped into its sources. The public widget reads answers with the same
 * rules (platform `crates/assistant/widget/render.js`), so both channels look alike.
 */
import type { Citation } from "./knowledge";

export type Inline =
  | string
  | { tag: "strong" | "em" | "code"; children: Inline[] }
  | { tag: "a"; href: string; children: Inline[] }
  | { tag: "cite"; numbers: number[] }
  | { tag: "br" };

export type Block = { tag: "p"; children: Inline[] } | { tag: "ul" | "ol"; children: { tag: "li"; children: Inline[] }[] };

// Bold, italic, inline code, an http(s) link, and a citation marker `[1]` or `[1, 2]`.
const INLINE =
  /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)|\[(\d+(?:\s*,\s*\d+)*)\]|\*(?=\S)(.+?)\*|(^|[^\w])_(?=\S)(.+?)_(?!\w)/g;

function inline(text: string, known: (n: number) => boolean): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const re = new RegExp(INLINE.source, "g");
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    // `_em_` takes the character before it, so a snake_case name stays one word.
    out.push(text.slice(last, match.index) + (match[8] ?? ""));
    if (match[1] !== undefined || match[2] !== undefined) {
      out.push({ tag: "strong", children: inline(match[1] ?? match[2], known) });
    } else if (match[3] !== undefined) {
      out.push({ tag: "code", children: [match[3]] });
    } else if (match[4] !== undefined) {
      out.push({ tag: "a", href: match[5], children: inline(match[4], known) });
    } else if (match[6] !== undefined) {
      const numbers = match[6]
        .split(",")
        .map((n) => Number(n.trim()))
        .filter(known);
      // A marker no citation stands behind is dropped, never shown as typed.
      if (numbers.length > 0) out.push({ tag: "cite", numbers });
    } else {
      out.push({ tag: "em", children: inline(match[7] ?? match[9], known) });
    }
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return out.filter((node) => node !== "");
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/**
 * The answer as blocks: paragraphs (lines joined by line breaks), bullet and numbered lists,
 * headings read as bold paragraphs. `known(n)` says whether citation n exists.
 */
export function markdown(text: string, known: (n: number) => boolean = () => false): Block[] {
  const blocks: Block[] = [];
  let paragraph: { tag: "p"; children: Inline[] } | null = null;
  let list: { tag: "ul" | "ol"; children: { tag: "li"; children: Inline[] }[] } | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const item = BULLET.exec(line) ?? NUMBERED.exec(line);
    const tag = BULLET.test(line) ? "ul" : "ol";
    const heading = HEADING.exec(line);
    if (item) {
      if (!list || list.tag !== tag) {
        list = { tag, children: [] };
        blocks.push(list);
      }
      list.children.push({ tag: "li", children: inline(item[1], known) });
      paragraph = null;
    } else if (line.trim() === "") {
      paragraph = null;
      list = null;
    } else if (heading) {
      blocks.push({ tag: "p", children: [{ tag: "strong", children: inline(heading[1], known) }] });
      paragraph = null;
      list = null;
    } else if (list && /^\s{2,}\S/.test(line)) {
      // An indented line goes on with the list item above it.
      const last = list.children[list.children.length - 1];
      last.children = [...last.children, { tag: "br" }, ...inline(line.trim(), known)];
    } else {
      list = null;
      if (!paragraph) {
        paragraph = { tag: "p", children: [] };
        blocks.push(paragraph);
      } else {
        paragraph.children.push({ tag: "br" });
      }
      paragraph.children.push(...inline(line.trim(), known));
    }
  }
  return blocks;
}

export interface Source {
  url: string | null;
  title: string | null;
  live: boolean;
  endpoint: string | null;
  domain: string;
  numbers: number[];
}

function domain(url: string): string {
  return /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1].replace(/^www\./, "") ?? "";
}

/**
 * The citations as the sources a person reads: one per address, the numbers that share it
 * merged, each with its title and domain; live data never by its tool's name. `position[n]` is
 * the 1-based place of citation n in `list`.
 */
export function sources(citations: Citation[]): { list: Source[]; position: Record<number, number> } {
  const list: Source[] = [];
  const byKey = new Map<string, number>();
  const position: Record<number, number> = {};
  for (const citation of citations) {
    const url = citation.url && /^https?:\/\//i.test(citation.url) ? citation.url : null;
    const live = Boolean(citation.tool);
    const key = url ?? (live ? `live:${citation.endpoint ?? ""}` : null);
    if (!key) continue;
    const title = citation.title?.trim() || null;
    let at = byKey.get(key);
    if (at === undefined) {
      at = list.length;
      byKey.set(key, at);
      list.push({ url, title, live, endpoint: citation.endpoint ?? null, domain: url ? domain(url) : "", numbers: [] });
    }
    const entry = list[at];
    entry.title ??= title;
    entry.numbers.push(citation.n);
    position[citation.n] = at + 1;
  }
  return { list, position };
}

/** What a source's link says: its title, else the address without its scheme. */
export function label(source: Pick<Source, "url" | "title" | "endpoint">): string {
  if (source.title) return source.title;
  if (source.url) return source.url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return source.endpoint ?? "";
}
