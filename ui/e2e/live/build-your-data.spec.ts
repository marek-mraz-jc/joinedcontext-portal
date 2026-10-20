/**
 * The User Guide's "Build Your Data" walk (T-4821, docs User-Guide/15-build-your-data.md), end to
 * end on dev: the steward builds one feed in creation order (data model, context space, endpoint
 * with its policies, data source, pipeline), approves each change, and reads the entities back
 * through the new endpoint with their own session. With `GUIDE_SHOTS=1` it takes the page's
 * screenshots on the way. Each manifest goes through the door every form uses (check, then
 * propose); the guide prints the same manifests and says which form field writes each line.
 *
 * Everything it makes is named `guide-bikes*`. A passing run removes it all again in `afterAll`,
 * newest first. A failing run leaves it, because dev applies an approved change up to ten minutes
 * late and a removal landing under the next run would break that run; the next run goes on from
 * the first step not yet done, and removes everything once it passes.
 */
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { guideShot } from "./guide";
import { STEWARD, approve, checkManifest, csrf, removeCompletely, signIn } from "./portal";

const PROJECT = "helsinki";
const NAME = "guide-bikes";
const TYPE = "BikeHireDockingStation";
const SLUG = "guidebikesstationsdemoabcd";
const meta = (name: string, title: string) => ({ name, namespace: PROJECT, title: { en: title } });
const API = "joinedcontext.com/v1alpha1";
const FEED = "https://gbfs.theta.fifteen.eu/gbfs/2.2/helsinki/en/station_information.json";

const LINKML = `id: https://hel.fi/models/helsinki/guide-bikes
name: guide-bikes
description: The types of the guide-bikes space, one class per entity type (DM-61).
prefixes:
  linkml: https://w3id.org/linkml/
  ngsi-ld: https://uri.etsi.org/ngsi-ld/
  helsinki: https://hel.fi/models/helsinki/guide-bikes/
default_prefix: helsinki
default_range: string
imports:
  - linkml:types
  - ngsi-ld-core
slots:
  name:
    description: The station's name as the operator writes it.
    required: true
  totalSlotNumber:
    description: How many bikes the station docks when full.
    range: integer
    minimum_value: 0
classes:
  ${TYPE}:
    description: A city bike station.
    is_a: Entity
    slots:
      - name
      - totalSlotNumber
`;

const BLOBLANG = `root = this.data.stations.map_each(s -> {
  "id": "urn:ngsi-ld:${TYPE}:station-" + s.station_id.string(),
  "type": "${TYPE}",
  "name": { "type": "Property", "value": s.name },
  "totalSlotNumber": { "type": "Property", "value": s.capacity },
  "location": { "type": "GeoProperty", "value": { "type": "Point", "coordinates": [ s.lon, s.lat ] } }
})
`;

/** The six manifests in the order the guide creates them, each with the plural it is proposed under. */
const STEPS: { plural: string; manifest: { kind: string } & Record<string, unknown> }[] = [
  {
    plural: "spaces",
    manifest: {
      apiVersion: API,
      kind: "ContextSpace",
      metadata: meta(NAME, "City bike stations"),
      spec: { defaultLocale: "en", isSandbox: false },
    },
  },
  {
    plural: "datamodels",
    manifest: {
      apiVersion: API,
      kind: "DataModel",
      // Written as its source, LINKML above: the Portal derives the rest of the manifest.
      metadata: meta(NAME, "City bike stations"),
    },
  },
  {
    plural: "policies",
    manifest: {
      apiVersion: API,
      kind: "Policy",
      metadata: meta(`${NAME}-pipelines-write`, "The pipeline writes the bike stations"),
      spec: {
        contextSpaceRef: { kind: "ContextSpace", name: NAME },
        assigner: "did:web:{orgDomain}",
        assignee: { kind: "serviceAccount", id: "pipelines" },
        operations: ["upsertBatch", "createBatch", "queryBatch"],
      },
    },
  },
  {
    plural: "policies",
    manifest: {
      apiVersion: API,
      kind: "Policy",
      metadata: meta(`${NAME}-read`, "The project's members read the bike stations"),
      spec: {
        contextSpaceRef: { kind: "ContextSpace", name: NAME },
        assigner: "did:web:{orgDomain}",
        assignee: { kind: "group", id: PROJECT },
        operations: ["retrieveOps"],
        information: [{ entities: [{ type: TYPE }] }],
      },
    },
  },
  {
    plural: "endpoints",
    manifest: {
      apiVersion: API,
      kind: "Endpoint",
      metadata: meta(NAME, "City bike stations"),
      spec: { contextSpaceRef: NAME, slug: SLUG, audience: "organization", enabledRepresentations: ["ngsi-ld", "csv"] },
    },
  },
  {
    plural: "datasources",
    manifest: {
      apiVersion: API,
      kind: "DataSource",
      metadata: meta(`${NAME}-stations`, "City bike stations (GBFS)"),
      spec: {
        type: "http",
        http: {
          url: FEED,
          verb: "GET",
          headers: { Accept: "application/json" },
          timeout: "15s",
        },
      },
    },
  },
  {
    plural: "pipelines",
    manifest: {
      apiVersion: API,
      kind: "Pipeline",
      metadata: meta(`${NAME}-stations`, "City bike stations from GBFS"),
      spec: {
        class: "auto",
        period: "15m",
        source: { dataSourceRef: { kind: "DataSource", name: `${NAME}-stations` } },
        compute: { kind: "bloblang", bloblang: BLOBLANG },
        output: { mode: "upsert", type: TYPE },
        targetEndpoint: `urn:ngsi-ld:Endpoint:hel.fi:${PROJECT}-${NAME}:${NAME}`,
        quotas: { maxMemoryMb: 64, cpuMillicores: 100 },
      },
    },
  },
];

/** The page a person checks each step on, and the shot the guide shows of it. */
const SHOTS: Record<string, { path: string; shot: string }> = {
  ContextSpace: { path: `/projects/${PROJECT}/spaces/${NAME}`, shot: "build-1-context-space" },
  DataModel: { path: `/projects/${PROJECT}/models/${NAME}`, shot: "build-2-data-model" },
  Endpoint: { path: `/projects/${PROJECT}/endpoints/${NAME}`, shot: "build-3-endpoint" },
  DataSource: { path: `/projects/${PROJECT}/datasources/${NAME}-stations`, shot: "build-4-data-source" },
  Pipeline: { path: `/projects/${PROJECT}/pipelines/${NAME}-stations`, shot: "build-5-pipeline" },
};

let steward: { context: BrowserContext; page: Page } | undefined;
let passed = false;

test.afterAll(async () => {
  test.setTimeout(3_600_000);
  if (!steward) return;
  if (!passed) {
    await steward.context.close();
    return;
  }
  // Newest first, and the model after its space: a space's own model goes only once the space has.
  const order = [...STEPS].reverse().sort((a, b) => Number(a.plural === "datamodels") - Number(b.plural === "datamodels"));
  for (const step of order) {
    const name = String((step.manifest.metadata as { name: string }).name);
    // Each removal waits until the one before it has left: a space with policies cannot go.
    await removeCompletely(steward, PROJECT, step.plural, name)
      .then(() => expect.poll(() => done(steward!.page, step.plural, name), { timeout: 900_000, intervals: [5_000] }).toBe(false))
      .catch((err) => console.warn(`cleanup of ${step.plural}/${name}: ${String(err)}`));
  }
  await steward.context.close();
});

/**
 * Whether a step's resource is in the Portal's mirror, so the next step's references resolve; the
 * model counts once its source declares the type, since the space already made it empty. Dev
 * applies a merged change within a minute, and takes up to ten while the Portal rolls out.
 */
async function done(page: Page, plural: string, name: string): Promise<boolean> {
  const path = plural === "datamodels" ? `${plural}/${name}/source` : `${plural}/${name}`;
  const answer = await page.request.get(`/api/v1/projects/${PROJECT}/${path}`);
  return answer.ok() && (plural !== "datamodels" || (await answer.text()).includes(`${TYPE}:`));
}

/** Waits until the page shows its heading and has stopped loading, so a shot shows the page. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[class*="animate-pulse"]')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(/^Loading/)).toHaveCount(0, { timeout: 60_000 });
}

/** Checks one step's manifest and proposes it through the door its form uses; the Change it opened. */
async function propose(
  page: Page,
  context: BrowserContext,
  step: (typeof STEPS)[number],
): Promise<{ metadata: { name: string }; status: { phase: string } }> {
  let answer;
  if (step.manifest.kind === "DataModel") {
    // The new space came with an empty model of its own name (DM-61); its classes are written as
    // the LinkML source, the text the model editor sends, and the Portal derives the manifest (DM-56).
    const source = `/api/v1/projects/${PROJECT}/datamodels/${NAME}/source`;
    const yaml = { "x-csrf-token": await csrf(context), "content-type": "text/yaml; charset=utf-8" };
    const checked = await page.request.put(`${source}?dryRun=All`, { headers: yaml, data: LINKML });
    expect(checked.ok(), `model check: ${await checked.text()}`).toBe(true);
    answer = await page.request.put(source, { headers: yaml, data: LINKML });
  } else {
    if (step.manifest.kind === "Pipeline") {
      // The studio's test run, the check a pipeline needs: its mapping on what the feed answers now.
      const tested = await page.request.post(`/api/v1/projects/${PROJECT}/ops/jc_pipeline_test`, {
        headers: { "x-csrf-token": await csrf(context) },
        data: { pipeline: step.manifest, sample: { url: FEED, format: "json" } },
      });
      const verdict = await tested.text();
      const ok = tested.ok() && (JSON.parse(verdict) as { verdict?: { ok?: boolean } }).verdict?.ok === true;
      expect(ok, `pipeline test: ${verdict.slice(0, 800)}`).toBe(true);
    } else {
      await checkManifest(page, context, PROJECT, step.manifest);
    }
    answer = await page.request.post(`/api/v1/projects/${PROJECT}/${step.plural}`, {
      headers: { "x-csrf-token": await csrf(context) },
      data: step.manifest,
    });
  }
  // A run that died before its approval left the change open: approve that one.
  const open = /already open: (chg-[0-9a-f]+)/.exec(await answer.text());
  if (answer.status() === 409 && open) return { metadata: { name: open[1] }, status: { phase: "PendingApproval" } };
  expect([200, 201, 202], `${step.manifest.kind}: ${await answer.text()}`).toContain(answer.status());
  return (await answer.json()) as { metadata: { name: string }; status: { phase: string } };
}

test("build a feed end to end: model, space, endpoint, source, pipeline, then read it", async ({ browser }) => {
  test.setTimeout(7_200_000);
  steward = await signIn(browser, STEWARD, `/projects/${PROJECT}/spaces?lang=en`);
  const { page, context } = steward;

  for (const step of STEPS) {
    const name = String((step.manifest.metadata as { name: string }).name);
    // A run that died after an approval left that step done: it goes on from the next one.
    if (!(await done(page, step.plural, name))) {
      const change = await propose(page, context, step);
      // A grant (a Policy) is a Red change: the approver types its name back (CC-19).
      if (change.status.phase === "PendingApproval") await approve(page, PROJECT, change.metadata.name, name);
      await expect.poll(() => done(page, step.plural, name), { timeout: 900_000, intervals: [5_000] }).toBe(true);
    }
    const shown = SHOTS[step.manifest.kind];
    if (shown) {
      await page.goto(`${shown.path}?lang=en`, { waitUntil: "load" });
      await settled(page);
      await guideShot(page, shown.shot);
    }
  }

  // The steward's own session reads the new endpoint: the stations the pipeline wrote.
  const read = `/api/endpoint/${SLUG}/ngsi-ld/v1/entities?type=${TYPE}&limit=5`;
  await expect
    .poll(
      async () => {
        const answer = await page.request.get(read, { headers: { Accept: "application/json" } });
        return answer.ok() ? ((await answer.json()) as unknown[]).length : -answer.status();
      },
      { timeout: 900_000, intervals: [10_000] },
    )
    .toBeGreaterThan(0);
  // The space's page counts what the pipeline wrote.
  await page.goto(`/projects/${PROJECT}/spaces/${NAME}?lang=en`, { waitUntil: "load" });
  await settled(page);
  await expect(page.getByText(/The space holds [1-9]/)).toBeVisible({ timeout: 120_000 });
  await guideShot(page, "build-6-read-back");
  passed = true;
});
