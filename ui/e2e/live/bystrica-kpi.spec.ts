/**
 * The Banská Bystrica demonstration, walked end to end on dev (T-2309, OPS-46, TS-19).
 *
 * Two public bodies, each ingesting its own published open data into its own Context Space, each
 * computing its own indicators into its own KPI space with its own pipeline, and one application
 * in `bbsk` showing both. The journey opens each space, then the application, and then does the
 * one check a viewer cannot do for themselves: it reads the indicators straight out of each KPI
 * space and asserts the cards show those numbers and no others.
 *
 * Two failures this exists to catch, both invisible on screen:
 *
 * - a card whose number is not the number in the space it names — a dashboard drifting from its
 *   source looks exactly like a dashboard;
 * - a card of one body carrying the other's value. The region has roughly 607 581 inhabitants and
 *   the city 72 123; either number under the other's heading reads as a fact.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { STEWARD, signIn } from "./portal";

const APP = "bbsk-ukazovatele";

/** What each body publishes, and where. `Development/10` §1, §2 and §4 are the contract. */
const BODIES = [
  {
    body: "bbsk",
    project: "bbsk",
    raw: { space: "bbsk-kraj", type: "StatisticalObservation" },
    kpi: { space: "bbsk-kpi", count: 28 },
    domain: "bbsk.sk",
  },
  {
    body: "banskabystrica",
    project: "banskabystrica",
    raw: { space: "banskabystrica-mesto", type: "StatisticalObservation" },
    kpi: { space: "banskabystrica-kpi", count: 3 },
    domain: "banskabystrica.sk",
  },
] as const;

/**
 * The digits of a number as any locale would print it with at most two decimals.
 *
 * The application formats with `Intl` in whichever language the served configuration asks for, so
 * the separators differ — `607 581` or `607,581`, `35,5` or `35.5`. Comparing digit sequences
 * compares the number and nothing else, and still fails on a different number, a rounded-away
 * decimal or a transposition.
 */
function digits(value: number): string {
  return String(Math.round(value * 100) / 100).replace(/\D/g, "");
}

/** A `KeyPerformanceIndicator` as the gateway serialises it: only the parts this journey reads. */
interface NgsiEntity {
  id: string;
  currentValue?: { value: number | string; unitCode?: string };
}

/** Every indicator one KPI space holds, read through the Portal's own session (`/cs/…`). */
async function indicatorsInSpace(
  page: Page,
  space: string,
): Promise<Map<string, { value: number | string; unitCode?: string }>> {
  const url = `/cs/${encodeURIComponent(space)}/ngsi-ld/v1/entities?type=KeyPerformanceIndicator&limit=200`;
  const response = await page.request.get(url, { headers: { Accept: "application/ld+json" } });
  expect(
    response.ok(),
    `${url} answered ${response.status()}; the demonstration needs this space readable by the demo person`,
  ).toBe(true);
  const entities = (await response.json()) as NgsiEntity[];
  expect(Array.isArray(entities), `${url} did not answer a list of entities`).toBe(true);
  return new Map(
    entities.map((entity) => [
      String(entity.id),
      { value: entity.currentValue?.value, unitCode: entity.currentValue?.unitCode },
    ]),
  );
}

test("both bodies ingest, compute and publish their own indicators, and one application shows both", async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const { context, page } = await signIn(browser, STEWARD, "/projects/bbsk/spaces?lang=en");

  const inSpace = new Map<string, Map<string, { value: number | string; unitCode?: string }>>();

  for (const body of BODIES) {
    // The project selector says which body's spaces are on screen; a figure read under the wrong
    // one is the mistake the whole demonstration is arranged against.
    await page.goto(`/projects/${body.project}/spaces?lang=en`, { waitUntil: "load" });
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page.getByText(body.project, { exact: true }).first()).toBeVisible();

    // The raw space: what the publisher published, ingested by the pipelines of T-2305.
    await page.goto(`/projects/${body.project}/spaces/${body.raw.space}?lang=en`, {
      waitUntil: "load",
    });
    const rawRow = page.getByRole("row").filter({ hasText: body.raw.type });
    await expect(
      rawRow,
      `${body.raw.space} shows no ${body.raw.type}: nothing was ingested`,
    ).toBeVisible({ timeout: 60_000 });
    expect(
      Number((await rawRow.innerText()).replace(/\D/g, "")),
      `${body.raw.space} holds no ${body.raw.type} entity`,
    ).toBeGreaterThan(0);

    // The KPI space: one entity per indicator per territory, and nothing else.
    await page.goto(`/projects/${body.project}/spaces/${body.kpi.space}?lang=en`, {
      waitUntil: "load",
    });
    const kpiRow = page.getByRole("row").filter({ hasText: "KeyPerformanceIndicator" });
    await expect(kpiRow, `${body.kpi.space} shows no indicator`).toBeVisible({ timeout: 60_000 });

    const held = await indicatorsInSpace(page, body.kpi.space);
    expect(held.size, `${body.kpi.space} holds ${held.size} indicators, not ${body.kpi.count}`).toBe(
      body.kpi.count,
    );
    for (const id of held.keys()) {
      // The territory is the id's last segment, and the body is the fourth: both are in the id
      // because the published schema has no attribute for either (PF-54).
      expect(id.split(":"), id).toHaveLength(6);
      expect(id, `${id} is in ${body.kpi.space} but names another body`).toContain(
        `:${body.domain}:${body.kpi.space}:`,
      );
    }
    inSpace.set(body.body, held);
  }

  // The application, in the region's project, reading both bodies.
  await page.goto(`/apps/${APP}/`, { waitUntil: "load" });

  for (const body of BODIES) {
    // The section and the cards are found by the ids the application mints, not by their words,
    // so the journey does not depend on which language the served configuration asks for.
    const section = page.locator(`section[aria-labelledby="body-${body.body}"]`);
    await expect(section, `the application shows no section for ${body.body}`).toBeVisible({
      timeout: 60_000,
    });

    const cards = section.locator("article[aria-labelledby^='card-urn:']");
    const held = inSpace.get(body.body)!;
    await expect(cards).toHaveCount(held.size, { timeout: 60_000 });

    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const id = (await card.getAttribute("aria-labelledby"))!.replace(/^card-/, "");

      // A card of one body carrying the other's indicator.
      expect(id, `a card under ${body.body} shows ${id}`).toContain(`:${body.domain}:`);
      const entity = held.get(id);
      expect(entity, `the card shows ${id}, which is not in ${body.kpi.space}`).toBeDefined();

      const reading = (await card.locator(".reading").innerText()).trim();
      if (typeof entity!.value === "number") {
        // The number on the card is the number in the space.
        expect(
          reading.replace(/\D/g, ""),
          `${id}: the card reads "${reading}" and the space holds ${entity!.value}`,
        ).toBe(digits(entity!.value));
        // And it is never a number without its unit.
        await expect(card.locator(".unit"), `${id} shows no unit`).not.toBeEmpty();
      } else {
        // "not measured": the words, and no zero standing in for a missing reading.
        expect(reading, `${id} holds no number but the card reads "${reading}"`).not.toMatch(/\d/);
        expect(entity!.unitCode, `${id} has no value but carries a unit`).toBeUndefined();
      }
    }
  }

  await context.close();
});
