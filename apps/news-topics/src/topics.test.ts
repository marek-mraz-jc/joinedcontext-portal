import { describe, expect, it } from "vitest";
import type { Row } from "@joinedcontext/sdk";
import { toInput } from "./topics";

describe("toInput", () => {
  it("converts SDK rows with complete attributes to article inputs", () => {
    const rows: Row[] = [
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-1",
        type: "NewsArticle",
        name: "School opening in Kalasatama",
        description: "Modern facilities for children",
        datePublished: "2026-10-05T08:00:00Z",
        url: "https://www.hel.fi/en/news/school-opening",
      },
    ];

    const input = toInput(rows, 5);

    expect(input.k).toBe(5);
    expect(input.seed).toBe(1);
    expect(input.articles).toEqual([
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-1",
        title: "School opening in Kalasatama",
        summary: "Modern facilities for children",
        published: "2026-10-05T08:00:00Z",
      },
    ]);
  });

  it("omits summary when description is missing, undefined, null, or empty", () => {
    const rows: Row[] = [
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-no-desc",
        type: "NewsArticle",
        name: "Brief announcement",
        datePublished: "2026-10-06T10:00:00Z",
      },
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-null-desc",
        type: "NewsArticle",
        name: "Another notice",
        description: null,
        datePublished: "2026-10-06T11:00:00Z",
      },
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-empty-desc",
        type: "NewsArticle",
        name: "Notice with blank summary",
        description: "   ",
        datePublished: "2026-10-06T12:00:00Z",
      },
    ];

    const input = toInput(rows, 3);

    expect(input.articles[0].summary).toBeUndefined();
    expect(input.articles[1].summary).toBeUndefined();
    expect(input.articles[2].summary).toBeUndefined();
    expect(input.articles[0].title).toBe("Brief announcement");
    expect(input.articles[0].published).toBe("2026-10-06T10:00:00Z");
  });

  it("omits published when datePublished is missing, undefined, null, or empty", () => {
    const rows: Row[] = [
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-no-date",
        type: "NewsArticle",
        name: "Undated story",
        description: "Some summary",
      },
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-null-date",
        type: "NewsArticle",
        name: "Another undated story",
        datePublished: null,
      },
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-empty-date",
        type: "NewsArticle",
        name: "Story with blank date",
        datePublished: "   ",
      },
    ];

    const input = toInput(rows, 4);

    expect(input.articles[0].published).toBeUndefined();
    expect(input.articles[1].published).toBeUndefined();
    expect(input.articles[2].published).toBeUndefined();
    expect(input.articles[0].title).toBe("Undated story");
    expect(input.articles[0].summary).toBe("Some summary");
  });

  it("handles rows with both description and datePublished missing", () => {
    const rows: Row[] = [
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-minimal",
        type: "NewsArticle",
        name: "Only title",
      },
    ];

    const input = toInput(rows, 2);

    expect(input.articles).toEqual([
      {
        id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-minimal",
        title: "Only title",
      },
    ]);
  });

  it("supports custom seed and handles empty rows array", () => {
    const emptyInput = toInput([], 5, 42);
    expect(emptyInput).toEqual({
      articles: [],
      k: 5,
      seed: 42,
    });
  });
});
