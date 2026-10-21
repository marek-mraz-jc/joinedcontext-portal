/**
 * Source vs space on dev (T-4892, PL-97, PL-100). For each project the walk reads every pipeline
 * whose `spec.sourceDeletes.mode` is `snapshot`, opens its page and checks the panel shows the
 * same counts the API answers: the last complete run's read, the entities in the space, the
 * orphans and the records missing from the space. On a pipeline with no orphan and no hold a
 * steward's "keep" changes nothing (every miss is already 0), so the walk sends it and checks the
 * report is the same afterwards. A dev without a snapshot pipeline fails: the feature has nothing
 * to show there.
 */
import { expect, test } from "@playwright/test";
import { STEWARD, signIn } from "./portal";

const PROJECTS = ["helsinki", "bbsk", "banskabystrica"];

interface Pipeline {
  metadata: { name: string };
  spec?: { sourceDeletes?: { mode?: string } };
}

interface Report {
  ledger: number;
  orphans: number;
  missing: number;
  hold?: unknown;
  lastComplete?: { run: string; read: number } | null;
}

test("a steward reads each snapshot pipeline's source vs space and a keep on a clean one changes nothing", async ({
  browser,
}) => {
  test.setTimeout(15 * 60_000);
  const { context, page } = await signIn(browser, STEWARD, `/projects/${PROJECTS[0]}/pipelines?lang=en`);
  try {
    let seen = 0;
    for (const project of PROJECTS) {
      const listed = await page.request.get(`/api/v1/projects/${project}/pipelines`);
      if (!listed.ok()) continue;
      const { items } = (await listed.json()) as { items: Pipeline[] };
      for (const name of items.filter((p) => p.spec?.sourceDeletes?.mode === "snapshot").map((p) => p.metadata.name)) {
        seen += 1;
        const url = `/api/v1/projects/${project}/pipelines/${name}/source-deletes`;
        const answer = await page.request.get(url);
        expect(answer.status(), await answer.text()).toBe(200);
        const report = (await answer.json()) as Report;

        await page.goto(`/projects/${project}/pipelines/${name}?lang=en#source`);
        const panel = page.getByTestId("source-report");
        await expect(panel).toBeVisible();
        await expect(panel.getByText("In the space", { exact: true }).locator("..")).toContainText(String(report.ledger));
        await expect(panel.getByText("Orphans", { exact: true }).locator("..")).toContainText(String(report.orphans));
        await expect(panel.getByText("Missing", { exact: true }).locator("..")).toContainText(String(report.missing));
        if (report.lastComplete) {
          await expect(panel.getByText("At the source", { exact: true }).locator("..")).toContainText(
            String(report.lastComplete.read),
          );
        }

        if (report.orphans === 0 && !report.hold) {
          const kept = await page.request.post(url, { data: { decision: "keep" } });
          expect(kept.status(), await kept.text()).toBe(202);
          const after = (await (await page.request.get(url)).json()) as Report;
          expect([after.ledger, after.orphans]).toEqual([report.ledger, 0]);
        }
      }
    }
    expect(seen, "dev holds a snapshot pipeline in helsinki, bbsk or banskabystrica (T-4891)").toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
