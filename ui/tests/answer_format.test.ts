import { describe, expect, it } from "vitest";
import { label, markdown, sources } from "../src/pages/knowledge/answerFormat";

// T-3325, AG-117: the same reading of an answer as the public widget's (platform
// crates/assistant/widget/render.test.js).
const upTo = (max: number) => (n: number) => n >= 1 && n <= max;

describe("an answer's Markdown", () => {
  it("keeps a paragraph's breaks and starts the next at a blank line", () => {
    expect(markdown("one\ntwo\n\nthree")).toEqual([
      { tag: "p", children: ["one", { tag: "br" }, "two"] },
      { tag: "p", children: ["three"] },
    ]);
  });

  it("reads bullet and numbered lists, an indented line staying with its item", () => {
    expect(markdown("- a\n* b\n  more\n1. c\n2) d")).toEqual([
      { tag: "ul", children: [{ tag: "li", children: ["a"] }, { tag: "li", children: ["b", { tag: "br" }, "more"] }] },
      { tag: "ol", children: [{ tag: "li", children: ["c"] }, { tag: "li", children: ["d"] }] },
    ]);
  });

  it("reads bold, italic and code, a heading as bold, and leaves snake_case alone", () => {
    expect(markdown("## Events\n**Workshop for _Families_** at `10:00`, *noon*, query_entities_tool")).toEqual([
      { tag: "p", children: [{ tag: "strong", children: ["Events"] }] },
      {
        tag: "p",
        children: [
          { tag: "strong", children: ["Workshop for ", { tag: "em", children: ["Families"] }] },
          " at ",
          { tag: "code", children: ["10:00"] },
          ", ",
          { tag: "em", children: ["noon"] },
          ", query_entities_tool",
        ],
      },
    ]);
  });

  it("links http(s) only and keeps HTML as text", () => {
    expect(markdown("[city](https://hel.fi/x) [bad](javascript:alert(1)) <script>alert(1)</script>")).toEqual([
      {
        tag: "p",
        children: [{ tag: "a", href: "https://hel.fi/x", children: ["city"] }, " [bad](javascript:alert(1)) <script>alert(1)</script>"],
      },
    ]);
  });

  it("turns markers into citations and drops an unknown number", () => {
    expect(markdown("x [2, 3] y [9] z [1, 9]", upTo(3))).toEqual([
      { tag: "p", children: ["x ", { tag: "cite", numbers: [2, 3] }, " y ", " z ", { tag: "cite", numbers: [1] }] },
    ]);
  });
});

describe("an answer's sources", () => {
  it("lists one per address by title, and live data never by its tool", () => {
    const { list, position } = sources([
      { n: 1, url: "https://data.dev.joinedcontext.com/dataset/helsinki-events", title: "Helsinki events" },
      { n: 2, url: "https://data.dev.joinedcontext.com/dataset/helsinki-events" },
      { n: 3, tool: "query_entities", endpoint: "helsinki-events" },
      { n: 4, url: "javascript:alert(1)" },
    ]);
    expect(list).toEqual([
      { url: "https://data.dev.joinedcontext.com/dataset/helsinki-events", title: "Helsinki events", live: false, endpoint: null, domain: "data.dev.joinedcontext.com", numbers: [1, 2] },
      { url: null, title: null, live: true, endpoint: "helsinki-events", domain: "", numbers: [3] },
    ]);
    expect(position).toEqual({ 1: 1, 2: 1, 3: 2 });
    expect(label(list[1])).toBe("helsinki-events");
    expect(label({ url: "https://www.hel.fi/en/events/", title: null, endpoint: null })).toBe("www.hel.fi/en/events");
    expect(JSON.stringify(list)).not.toMatch(/query_entities/);
  });
});
