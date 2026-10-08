import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JcProvider } from "@joinedcontext/sdk";
import type { Row } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App from "../App";
import type { AnalysisOutput as TopicsOutput, TopicsHookResult as UseTopicsResult } from "../topics";

type Click = (params: { name?: string }) => void;
const charts: Array<{ element: HTMLElement; setOption: ReturnType<typeof vi.fn>; click?: Click }> = [];
vi.mock("echarts", () => ({
  init: vi.fn((element: HTMLElement) => {
    const chart: (typeof charts)[number] = { element, setOption: vi.fn() };
    const api = {
      setOption: chart.setOption,
      resize: vi.fn(),
      dispose: vi.fn(),
      on: vi.fn((event: string, handler: Click) => {
        if (event === "click") chart.click = handler;
      }),
    };
    charts.push(chart);
    return api;
  }),
}));

const FIXED_TOPICS: TopicsOutput = {
  topics: [
    {
      id: 0,
      keywords: [
        { term: "school", weight: 0.8 },
        { term: "education", weight: 0.6 },
        { term: "pupils", weight: 0.5 },
      ],
      articles: [
        "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-1",
        "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-2",
      ],
      share: 0.6,
    },
    {
      id: 1,
      keywords: [
        { term: "traffic", weight: 0.7 },
        { term: "tram", weight: 0.5 },
        { term: "construction", weight: 0.4 },
      ],
      articles: [
        "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-3",
      ],
      share: 0.4,
    },
  ],
  weeks: [
    {
      week: "2026-W40",
      shares: [0.5, 0.5],
    },
    {
      week: "2026-W41",
      shares: [0.7, 0.3],
    },
  ],
  unassigned: [],
};

let mockTopicsState: UseTopicsResult = {
  status: "ready",
  result: FIXED_TOPICS,
  error: null,
};

// The worker and its module are the WASM tests' (src/wasm.test.ts); here the page is given an answer.
vi.mock("../topics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../topics")>()),
  useTopics: vi.fn(() => mockTopicsState),
}));

const ARTICLES: Row[] = [
  {
    id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-1",
    type: "NewsArticle",
    name: "New school opens in Kalasatama",
    description: "Modern learning spaces for 700 pupils in Kalasatama.",
    url: "https://www.hel.fi/en/news/new-school-kalasatama",
    datePublished: "2026-10-05T08:00:00Z",
    source: "https://www.hel.fi/en/news/rss",
  },
  {
    id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-2",
    type: "NewsArticle",
    name: "Education budget approved for next year",
    description: "City council approved funding for digital learning tools.",
    url: "https://www.hel.fi/en/news/education-budget",
    datePublished: "2026-10-06T10:00:00Z",
    source: "https://www.hel.fi/en/news/rss",
  },
  {
    id: "urn:ngsi-ld:NewsArticle:hel.fi:helsinki:news-3",
    type: "NewsArticle",
    name: "Tram line extension starts construction",
    description: "Work on Crown Bridges tram connection advances to Hakaniemi.",
    url: "https://www.hel.fi/en/news/tram-construction",
    datePublished: "2026-10-12T09:00:00Z",
    source: "https://www.hel.fi/en/news/rss",
  },
];

const READ = {
  permissions: [{ resource: { type: "NewsArticle" }, actions: ["queryEntity", "retrieveEntity"], attributes: "*" as const }],
  prohibitions: [],
};

function renderTopics(entities: Row[] = ARTICLES, refuse?: () => { status: number; body: unknown } | null) {
  const client = stubClient({ entities, access: READ, refuse }, { appName: "news-topics" });
  render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
  return client;
}

describe("the topics page", () => {
  beforeEach(() => {
    charts.length = 0;
    window.history.replaceState(null, "", "/");
    mockTopicsState = {
      status: "ready",
      result: FIXED_TOPICS,
      error: null,
    };
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("renders the first screen without a click: topics list, chart, articles of selected topic, and text alternative table", async () => {
    renderTopics(ARTICLES);
    await screen.findByRole("list", { name: /topics of the period/i });

    expect(screen.getByRole("heading", { level: 1, name: "Helsinki news topics" })).toBeInTheDocument();

    expect(screen.getByRole("region", { name: /topics in the news/i })).toBeInTheDocument();
    const topicsRegion = screen.getByRole("list", { name: /topics of the period/i });
    expect(within(topicsRegion).getByText(/school/i)).toBeInTheDocument();
    expect(within(topicsRegion).getByText(/traffic/i)).toBeInTheDocument();
    expect(within(topicsRegion).getByText(/60\s*%/)).toBeInTheDocument();
    expect(within(topicsRegion).getByText(/40\s*%/)).toBeInTheDocument();

    const chartFigure = screen.getByRole("figure");
    expect(chartFigure).toBeInTheDocument();
    expect(within(chartFigure).getByRole("img")).toBeInTheDocument();

    const altTable = screen.getByRole("table", { name: /topic share/i });
    expect(altTable).toBeInTheDocument();
    expect(within(altTable).getByText("2026-W40")).toBeInTheDocument();
    expect(within(altTable).getByText("2026-W41")).toBeInTheDocument();

    const articlesList = screen.getByRole("list", { name: /articles of topic/i });
    expect(within(articlesList).getByRole("heading", { name: "New school opens in Kalasatama" })).toBeInTheDocument();
    expect(within(articlesList).getByRole("heading", { name: "Education budget approved for next year" })).toBeInTheDocument();
    expect(within(articlesList).queryByRole("heading", { name: "Tram line extension starts construction" })).toBeNull();
  });

  it("topic selection updates the hash and displays articles of the selected topic", async () => {
    renderTopics(ARTICLES);

    const topic2Card = await screen.findByRole("button", { name: /traffic/i });
    fireEvent.click(topic2Card);

    expect(window.location.hash).toContain("topic=1");

    await waitFor(() => {
      const articlesList = screen.getByRole("list", { name: /articles of topic/i });
      expect(within(articlesList).getByRole("heading", { name: "Tram line extension starts construction" })).toBeInTheDocument();
      expect(within(articlesList).queryByRole("heading", { name: "New school opens in Kalasatama" })).toBeNull();
    });
  });

  it("respects initial topic selection from the URL hash", async () => {
    window.history.replaceState(null, "", "/#topics?topic=1");
    renderTopics(ARTICLES);

    await waitFor(() => {
      const articlesList = screen.getByRole("list", { name: /articles of topic/i });
      expect(within(articlesList).getByRole("heading", { name: "Tram line extension starts construction" })).toBeInTheDocument();
      expect(within(articlesList).queryByRole("heading", { name: "New school opens in Kalasatama" })).toBeNull();
    });
  });

  it("renders empty state when there are no news articles in the period", async () => {
    mockTopicsState = {
      status: "ready",
      result: { topics: [], weeks: [], unassigned: [] },
      error: null,
    };
    renderTopics([]);

    await waitFor(() => {
      expect(screen.getByText(/no news in this period/i)).toBeInTheDocument();
    });
  });

  it("renders error alert with retry button when endpoint fails", async () => {
    let fail = true;
    renderTopics(ARTICLES, () => (fail ? { status: 503, body: { title: "Service Unavailable" } } : null));

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();

    fail = false;
    const retryBtn = within(alert).getByRole("button", { name: /retry/i });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("renders error alert when worker fails", async () => {
    mockTopicsState = {
      status: "error",
      result: null,
      error: new Error("WASM clustering worker crashed"),
    };
    renderTopics(ARTICLES);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("WASM clustering worker crashed");
  });

  it("renders Finnish UI strings when URL has ?lang=fi", async () => {
    window.history.replaceState(null, "", "/?lang=fi");
    renderTopics(ARTICLES);

    expect(screen.getByRole("heading", { level: 1, name: "Helsingin uutisaiheet" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /uutisaiheet/i })).toBeInTheDocument();
  });

  it("renders Finnish empty state when there are no articles", async () => {
    window.history.replaceState(null, "", "/?lang=fi");
    mockTopicsState = {
      status: "ready",
      result: { topics: [], weeks: [], unassigned: [] },
      error: null,
    };
    renderTopics([]);

    await waitFor(() => {
      expect(screen.getByText(/ei uutisia tällä ajanjaksolla/i)).toBeInTheDocument();
    });
  });

  it("satisfies accessibility role checks and proper links", async () => {
    renderTopics(ARTICLES);
    await screen.findByRole("list", { name: /topics of the period/i });

    expect(screen.getByRole("search", { name: /filter/i })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /search/i })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /topics/i })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /topic share/i })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: /articles of topic/i })).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Read on hel.fi: New school opens in Kalasatama" });
    expect(link).toHaveAttribute("href", "https://www.hel.fi/en/news/new-school-kalasatama");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("links an article only to a web address, never to what else a feed entry may hold", async () => {
    const hostile = { ...ARTICLES[0], url: "javascript:alert(1)" };
    renderTopics([hostile, ARTICLES[1], ARTICLES[2]]);
    await screen.findByRole("list", { name: /topics of the period/i });
    const articles = screen.getByRole("list", { name: /articles of topic/i });
    expect(within(articles).getByRole("heading", { name: "New school opens in Kalasatama" })).toBeInTheDocument();
    expect(within(articles).queryByRole("link", { name: /New school opens in Kalasatama/ })).toBeNull();
    expect(within(articles).getByRole("link", { name: /Education budget approved/ })).toHaveAttribute("href", "https://www.hel.fi/en/news/education-budget");
  });
});
