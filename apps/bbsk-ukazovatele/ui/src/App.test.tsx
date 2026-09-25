/**
 * The screen, over the entities the pipelines of T-2307 produced (T-2308).
 *
 * `fetch` is what is stubbed and nothing below it, so every case goes through the SDK's own
 * endpoint source: the same URL building, the same NGSI-LD parsing and the same refusal handling
 * the published bundle uses. A card that renders here renders on the cluster.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { currentTokens, JcProvider } from "@joinedcontext/sdk";
import { stubClient } from "@joinedcontext/sdk/testing";
import App, { bodyColor } from "./App";
import region from "./fixtures/bbsk-kpi.json";
import city from "./fixtures/banskabystrica-kpi.json";
import { LOCALES } from "./locales";

const REGION_SLUG = "7u4ns3cdg2mqlx5gmxhk7rqai6pmokdj";
const CITY_SLUG = "qfhhh5no5wz4lk3rfjisdtx3chiyfig3";

const ENDPOINTS = [
  { name: "bbsk-kpi", slug: REGION_SLUG, space: "bbsk-kpi", types: ["KeyPerformanceIndicator"] },
  {
    name: "mesto-kpi",
    slug: CITY_SLUG,
    space: "banskabystrica-kpi",
    types: ["KeyPerformanceIndicator"],
  },
];

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: "Refused", status, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

/** Answers each slug with what that endpoint serves; anything else is a test that asked wrongly. */
function serving(bySlug: Record<string, () => Response>) {
  return vi.fn(async (path: string) => {
    const slug = /\/api\/endpoint\/([^/]+)\//.exec(path)?.[1];
    const reply = slug ? bySlug[slug] : undefined;
    if (!reply) throw new Error(`no stub for ${path}`);
    return reply();
  });
}

function show(
  bySlug: Record<string, () => Response>,
  options?: { language?: string; endpoints?: typeof ENDPOINTS },
) {
  vi.stubGlobal("fetch", serving(bySlug));
  const client = stubClient(undefined, {
    slug: REGION_SLUG,
    orgDomain: "bbsk.sk",
    space: "bbsk-kpi",
    transport: "origin",
    appName: "bbsk-ukazovatele",
    language: options?.language ?? "sk",
    endpoints: options?.endpoints ?? ENDPOINTS,
  });
  return render(
    <JcProvider client={client}>
      <App />
    </JcProvider>,
  );
}

const both = {
  [REGION_SLUG]: () => answer(region),
  [CITY_SLUG]: () => answer(city),
};

const sectionOf = (name: string | RegExp) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("both bodies, side by side", () => {
  it("shows each publisher's indicators under that publisher's own heading", async () => {
    show(both);

    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);

    await waitFor(() =>
      expect(within(bbsk).getByRole("heading", { name: LOCALES.sk.indicator["obyvatelstvo-stav"].title })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(within(mesto).getByRole("heading", { name: LOCALES.sk.indicator["pm10-24h"].title })).toBeInTheDocument(),
    );

    // The region's own section never carries a city indicator, and the city's never a regional one.
    expect(within(bbsk).queryByRole("heading", { name: LOCALES.sk.indicator["pm10-24h"].title })).toBeNull();
    expect(within(mesto).queryByRole("heading", { name: LOCALES.sk.indicator["obyvatelstvo-stav"].title })).toBeNull();
  });

  it("drops a row whose own id says it belongs to the other body", async () => {
    // An endpoint may only serve its own space, so a regional entity arriving on the city's
    // endpoint means something is wrong upstream. Showing it under the city's heading would put
    // a 600 000 figure under a 72 000 body, which is the one mistake this screen exists to stop.
    show({ [REGION_SLUG]: () => answer([]), [CITY_SLUG]: () => answer([...city, ...region]) });

    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);
    await waitFor(() => expect(within(mesto).getAllByRole("article").length).toBe(city.length));
    expect(
      within(mesto).queryByRole("heading", { name: LOCALES.sk.indicator["obyvatelstvo-stav"].title }),
    ).toBeNull();
  });

  it("names the territory on every card, never only in the page heading", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);

    await waitFor(() =>
      expect(within(bbsk).getAllByRole("article").length).toBe(region.length),
    );
    // Every card is named by a heading of its own, and that heading is the territory.
    const named = within(bbsk).getAllByRole("article").map((card) => {
      const id = card.getAttribute("aria-labelledby") ?? "";
      return document.getElementById(id)?.textContent ?? "";
    });
    expect(named.every((name) => Object.values(LOCALES.sk.territory).includes(name))).toBe(true);
    // Two regional indicators, so each of the fourteen territories is named twice.
    expect(named.filter((name) => name === LOCALES.sk.territory["okres-brezno"])).toHaveLength(2);
    expect(named.filter((name) => name === LOCALES.sk.territory.kraj)).toHaveLength(2);
  });

  it("reads a number with its unit, its window and when it was computed", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);

    const heading = await within(bbsk).findAllByRole("heading", { name: LOCALES.sk.territory.kraj });
    const card = heading
      .map((h) => h.closest("article"))
      .find((article) => article?.textContent?.includes(LOCALES.sk.indicator["obyvatelstvo-stav"].unit));
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("607 581".replace(/\s/g, " "));
    expect(card?.textContent).toContain(LOCALES.sk.indicator["obyvatelstvo-stav"].unit);
    expect(card?.textContent).toContain(LOCALES.sk.window);
    expect(card?.textContent).toContain(LOCALES.sk.computedAt);
    expect(card?.querySelector("time[datetime='2025-01-01T00:00:00Z']")).toBeTruthy();
  });
});

describe("the states, and the ones there are none of", () => {
  it("says the state in words and a shape, never in colour alone", async () => {
    show(both);
    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);

    const pm10 = (await within(mesto).findAllByRole("article")).find((card) =>
      card.textContent?.includes("35,5"),
    );
    expect(pm10?.textContent).toContain(LOCALES.sk.state.amber);
    // The shape is decoration beside the word, so a reader who cannot see colour reads the word.
    expect(pm10?.querySelector(".shape")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives no state to an indicator no published limit covers", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);

    await waitFor(() => expect(within(bbsk).getAllByRole("article").length).toBe(region.length));
    for (const state of Object.values(LOCALES.sk.state)) {
      expect(within(bbsk).queryByText(new RegExp(state))).toBeNull();
    }
  });

  it("says not measured, never a zero and never a bare dash", async () => {
    const empty = [
      {
        id: "urn:ngsi-ld:KeyPerformanceIndicator:banskabystrica.sk:banskabystrica-kpi:pm10-24h-mesto",
        type: "KeyPerformanceIndicator",
        name: { type: "Property", value: "pm10-24h-mesto" },
        currentValue: { type: "Property", value: "not measured" },
        calculationPeriod: {
          type: "Property",
          value: { start: "2026-09-19T07:00:00Z", end: "2026-09-20T07:00:00Z" },
        },
        calculationFormula: { type: "Property", value: "avg(pm10) over AirQualityObserved" },
        updatedAt: { type: "Property", value: { "@type": "DateTime", "@value": "2026-09-20T07:01:00Z" } },
      },
    ];
    show({ [REGION_SLUG]: () => answer([]), [CITY_SLUG]: () => answer(empty) });

    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);
    const card = (await within(mesto).findAllByRole("article"))[0];
    expect(card.textContent).toContain(LOCALES.sk.notMeasured);
    expect(card.textContent).toContain(LOCALES.sk.notMeasuredWhy);
    expect(card.textContent).not.toMatch(/\b0\b/);
    // The window is still shown: the question was asked, and of this window.
    expect(card.querySelector("time[datetime='2026-09-20T07:00:00Z']")).toBeTruthy();
  });
});

describe("when one of the two does not answer", () => {
  it("says which half is missing and keeps the other half on screen", async () => {
    show({
      [REGION_SLUG]: () => answer(region),
      [CITY_SLUG]: () => problem(403, "the city has not shared its indicators with bbsk"),
    });

    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);
    const said = await within(mesto).findByRole("alert");
    expect(said).toHaveTextContent(LOCALES.sk.unavailable);
    expect(said).toHaveTextContent("the city has not shared its indicators with bbsk");

    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    await waitFor(() => expect(within(bbsk).getAllByRole("article").length).toBe(region.length));
  });

  it("says so when the configuration names no endpoint for a body, and asks for nothing", async () => {
    show(both, { endpoints: [ENDPOINTS[0]] });

    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);
    await waitFor(() => expect(within(mesto).getByRole("status")).toHaveTextContent(LOCALES.sk.noEndpoint));
    expect(within(mesto).queryAllByRole("article")).toHaveLength(0);
  });

  it("says a publisher published nothing, which is not the same as a refusal", async () => {
    show({ [REGION_SLUG]: () => answer([]), [CITY_SLUG]: () => answer(city) });

    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    await waitFor(() => expect(within(bbsk).getByRole("status")).toHaveTextContent(LOCALES.sk.empty));
    expect(within(bbsk).queryByRole("alert")).toBeNull();
  });
});

describe("the two languages", () => {
  it("is Slovak by default and by an unknown language tag", async () => {
    show(both, { language: undefined });
    expect(await screen.findByRole("heading", { level: 1, name: LOCALES.sk.title })).toBeInTheDocument();
  });

  it("shows English when the served configuration asks for it, with no Slovak left behind", async () => {
    show(both, { language: "en" });

    expect(await screen.findByRole("heading", { level: 1, name: LOCALES.en.title })).toBeInTheDocument();
    const bbsk = sectionOf(LOCALES.en.body.bbsk);
    await waitFor(() => expect(within(bbsk).getAllByRole("article").length).toBe(region.length));
    expect(document.body.textContent).not.toContain(LOCALES.sk.window);
    expect(document.body.textContent).not.toContain(LOCALES.sk.computedAt);
    expect(document.body.textContent).toContain(LOCALES.en.territory["okres-brezno"]);
  });
});

describe("what a screen reader and an audit find", () => {
  it("has no axe violation", async () => {
    const { container } = show(both);
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(0));

    const results = await axe.run(container, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });

  it("gives every section and every card a name of its own", async () => {
    show(both);
    await waitFor(() => expect(screen.getAllByRole("article").length).toBeGreaterThan(0));

    for (const card of screen.getAllByRole("article")) {
      const id = card.getAttribute("aria-labelledby");
      expect(id && document.getElementById(id)?.textContent).toBeTruthy();
    }
    expect(sectionOf(LOCALES.sk.body.bbsk)).toBeInTheDocument();
    expect(sectionOf(LOCALES.sk.body.banskabystrica)).toBeInTheDocument();
  });
});

describe("colour, charts and the details a reader opens (T-2922)", () => {
  const measured = (key: string) =>
    region.filter(
      (entity) =>
        String(entity.name.value).startsWith(`${key}-okres-`) &&
        typeof (entity as { currentValue?: { value?: unknown } }).currentValue?.value === "number",
    ).length;

  it("charts each region indicator's districts, one bar per measured district", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    await waitFor(() => expect(within(bbsk).getAllByRole("figure")).toHaveLength(2));

    for (const key of ["obyvatelstvo-stav", "emisie-tuhe-km2"]) {
      const title = LOCALES.sk.indicator[key].title;
      const chart = within(bbsk).getByRole("figure", { name: `${LOCALES.sk.districtsCompared}: ${title}` });
      const bars = within(chart).getAllByRole("listitem");
      expect(bars).toHaveLength(measured(key));
      // Every bar says its district and its number with the written unit, not only a length.
      expect(bars[0].textContent).toContain(LOCALES.sk.indicator[key].unit);
      expect(
        bars.every((bar) =>
          Object.values(LOCALES.sk.territory).some((name) => bar.textContent?.startsWith(name)),
        ),
      ).toBe(true);
    }
  });

  it("draws no chart where a body publishes only its whole territory", async () => {
    show(both);
    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);
    await waitFor(() => expect(within(mesto).getAllByRole("article").length).toBe(city.length));
    expect(within(mesto).queryAllByRole("figure")).toHaveLength(0);
  });

  it("colours each body from the design tokens, never from what an entity says", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    const mesto = sectionOf(LOCALES.sk.body.banskabystrica);
    const tokens = currentTokens();
    expect(bbsk.style.getPropertyValue("--body")).toBe(tokens.color.accent);
    expect(mesto.style.getPropertyValue("--body")).toBe(tokens.chart.palette[1]);
    expect(bodyColor("bbsk")).not.toBe(bodyColor("banskabystrica"));
  });

  it("keeps the window and the formula in a disclosure, off the main view", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    await waitFor(() => expect(within(bbsk).getAllByRole("article").length).toBe(region.length));
    for (const card of within(bbsk).getAllByRole("article")) {
      const details = card.querySelector("details");
      expect(details).toBeTruthy();
      expect(details?.open).toBe(false);
      expect(details?.querySelector("summary")?.textContent).toBe(LOCALES.sk.details);
      expect(card.querySelector(".formula")?.closest("details")).toBe(details);
    }
  });

  it("marks the whole region as the headline card of its indicator", async () => {
    show(both);
    const bbsk = sectionOf(LOCALES.sk.body.bbsk);
    await waitFor(() => expect(within(bbsk).getAllByRole("article").length).toBe(region.length));
    const whole = within(bbsk)
      .getAllByRole("article")
      .filter((card) => card.classList.contains("whole"));
    expect(whole).toHaveLength(2);
    for (const card of whole) {
      expect(card.textContent).toContain(LOCALES.sk.territory.kraj);
    }
  });
});
