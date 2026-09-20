/**
 * The workspace bar and the conflict chooser in a browser (T-1254, T-1255; UI-15, UI-61, UI-62).
 *
 * `tests/workspaces_a11y.test.tsx` reads their markup under jsdom, which has no layout and no
 * CSS: it cannot see a control pushed off the side of a phone, and axe cannot judge contrast
 * there at all. This spec is the run that can. The API is answered in the browser, so it needs
 * no Portal — `vite preview` serves the built bundle and nothing else.
 *
 * Sizes are the two a person actually meets and the repository already uses: a phone at 400 CSS
 * px, and a 1280 px window at 1.5× browser zoom, which is a viewport 853 CSS px wide. Nothing is
 * screenshotted: overflow, reachability and axe are judged, so there is no baseline to regenerate
 * in an environment with different fonts.
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

const API = "joinedcontext.com/v1alpha1";
const PROJECT = "helsinki";
const COPY = "air-v2";

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@hel.fi",
  roles: ["portal-editor"],
};

const WORKSPACE = {
  name: COPY,
  title: "Air cleanup before the winter season",
  project: PROJECT,
  owner: IDENTITY.email,
  branch: `workspace/${COPY}`,
  baseRevision: "base1",
  scope: { kind: "project" },
  previewState: "none",
  createdAt: "2026-09-18T09:00:00Z",
  expiresAt: "2026-12-25T09:00:00Z",
  changes: 3,
};

/** Two conflicting fields on one file: the widest thing the chooser ever has to lay out. */
const COMPARISON = {
  files: [
    {
      path: `projects/${PROJECT}/pipelines/air-quality-ingest/pipeline.yaml`,
      kind: "Pipeline",
      operation: "Update",
      lane: "red",
      fields: [{ path: "spec.schedule", from: "every 10 seconds", to: "every 30 seconds" }],
    },
  ],
  conflicts: [
    {
      path: `projects/${PROJECT}/pipelines/air-quality-ingest/pipeline.yaml`,
      fields: [
        {
          path: "spec.compute.mapping.window",
          ours: "root.observedAt = this.timestamp.ts_parse(\"2006-01-02T15:04:05Z\")",
          theirs: "root.observedAt = this.timestamp.ts_strptime(\"%Y-%m-%dT%H:%M:%SZ\")",
          base: "root.observedAt = this.timestamp",
        },
        { path: "spec.schedule", ours: "every 30 seconds", theirs: "every 60 seconds", base: "every 10 seconds" },
      ],
    },
  ],
};

async function stubApi(page: Page): Promise<void> {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) return json(IDENTITY);
    if (path === "/api/v1/projects") return json({ apiVersion: API, kind: "List", items: [{ name: PROJECT }] });
    if (path === `/api/v1/projects/${PROJECT}`) {
      return json({ apiVersion: API, kind: "Project", metadata: { name: PROJECT }, spec: {}, status: {} });
    }
    if (path.endsWith(`/workspaces/${COPY}/compare`)) return json(COMPARISON);
    if (path.endsWith(`/workspaces/${COPY}`)) return json(WORKSPACE);
    return json({ apiVersion: API, kind: "List", items: [] });
  });
}

/** How far the page can be scrolled sideways: anything above a rounding pixel is overflow. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
}

const SIZES = [
  { name: "a phone at 400px", viewport: { width: 400, height: 860 } },
  // 1280 px laid out at 1.5× browser zoom is a viewport 853 CSS px wide (UI-15).
  { name: "1280px at 1.5x zoom", viewport: { width: 853, height: 480 } },
];

test.describe("the copy bar and the conflict chooser", () => {
  for (const size of SIZES) {
    test.describe(size.name, () => {
      test.use({ viewport: size.viewport });

      test("the bar shows every control and pushes nothing off the side", async ({ page }) => {
        await stubApi(page);
        await page.goto(`/projects/${PROJECT}/spaces?workspace=${COPY}&lang=en`);

        const bar = page.getByRole("region", { name: "Copy" });
        await expect(bar).toBeVisible();
        // The title is long on purpose: the bar wraps rather than clipping or scrolling.
        await expect(bar.getByText("Air cleanup before the winter season")).toBeVisible();
        for (const control of ["Try it", "Compare", "Bring back", "Leave"]) {
          await expect(bar.getByRole(control === "Leave" ? "button" : "link", { name: control })).toBeVisible();
        }
        expect(await sidewaysOverflow(page)).toBe(0);
      });

      test("the conflict chooser answers both fields without a sideways scroll", async ({ page }) => {
        await stubApi(page);
        await page.goto(`/projects/${PROJECT}/workspaces/${COPY}/bring-back?lang=en`);

        const groups = page.getByRole("radiogroup");
        await expect(groups).toHaveCount(2);
        for (let index = 0; index < 2; index += 1) {
          const group = groups.nth(index);
          await expect(group.getByRole("radio")).toHaveCount(2);
          // Answering by click is what a mouse does; the keyboard path is in the unit tests.
          await group.getByRole("radio").first().check();
          await expect(group.getByRole("radio").first()).toBeChecked();
        }
        const update = page.getByRole("button", { name: "Update from the project" });
        await expect(update).toBeVisible();
        await expect(update).not.toHaveAttribute("aria-disabled", "true");
        expect(await sidewaysOverflow(page)).toBe(0);
      });
    });
  }

  test("the bar and the chooser have no axe violations", async ({ page }) => {
    await stubApi(page);

    await page.goto(`/projects/${PROJECT}/spaces?workspace=${COPY}&lang=en`);
    await expect(page.getByRole("region", { name: "Copy" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.goto(`/projects/${PROJECT}/workspaces/${COPY}/bring-back?lang=en`);
    await expect(page.getByRole("radiogroup").first()).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });

  test("the copy that is gone is announced, not only shown", async ({ page }) => {
    // A copy discarded by its owner while somebody else is reading a page of it: the line that
    // replaces the bar is a live region, so a screen reader says it without being asked
    // (T-1254). Its visibility is what this run can see; that it is `status` is the assertion.
    await page.route("**/api/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path.endsWith("/auth/me")) return json(IDENTITY);
      if (path === "/api/v1/projects") return json({ apiVersion: API, kind: "List", items: [{ name: PROJECT }] });
      if (path.endsWith(`/workspaces/${COPY}`)) return json({ title: "Not Found", status: 404 }, 404);
      return json({ apiVersion: API, kind: "List", items: [] });
    });
    await page.goto(`/projects/${PROJECT}/spaces?workspace=${COPY}&lang=en`);

    const notice = page.getByRole("status").filter({ hasText: "expired or was discarded" });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("button", { name: "Leave" })).toBeVisible();
  });
});
