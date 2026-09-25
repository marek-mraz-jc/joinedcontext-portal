/**
 * T-2730 — every page and every form of the Portal on dev, at 1440 and 2560 px, as the steward
 * and as the viewer (UI-01, UI-15, UI-16, UI-44, UI-84).
 *
 * The walker opens every route of the router with one real item for each name in it, and every
 * create and edit form at its own address. It is read-only: it never presses a write control, so
 * a form is judged as it opens. Per page and width it asks what `tests/pageChecks.ts` asks (one
 * h1, a purpose line, an empty state that says what to do, a hint on every field, no raw i18n
 * key, JSON or bare URN where words belong, nothing overflowing sideways, three form columns on a
 * big screen), plus what only a real browser on a real Portal can tell: no console error, no
 * request answered >= 400 the person should not meet, axe with no serious or critical
 * violation. For the viewer, every write control is disabled and says why (UI-44).
 *
 * A screenshot is saved per page, width and person. The findings are attached as JSON; what is
 * known and owed is in `walker.allow.json`, each entry naming its task, and only shrinks. The
 * mocked copy of the same checks runs in the fast suite (`tests/walker_pages.test.tsx`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page, Response } from "@playwright/test";
import { axeViolations } from "../axe";
import { pageFindings, unexcused } from "../../tests/pageChecks";
import type { Excused } from "../../tests/pageChecks";
import { STEWARD, VIEWER, signIn } from "./portal";

const here = dirname(fileURLToPath(import.meta.url));
const NAMESPACES = Object.keys(JSON.parse(readFileSync(join(here, "../../src/locales/en.json"), "utf8")) as object);
const allow = JSON.parse(readFileSync(join(here, "walker.allow.json"), "utf8")) as { excused: Excused[] };

const PROJECT = "helsinki";
const P = `/projects/${PROJECT}`;
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 2560, height: 1300 },
];
/** The sections that open a create and an edit form at their own address (`NEW_FORMS`). */
const FORMS = ["spaces", "endpoints", "pipelines", "policies", "subscriptions", "csrs", "datasources", "syncsources"];
const SECTIONS = ["flows", "spaces", "endpoints", "subscriptions", "datasources", "pipelines", "dashboards", "apps", "syncsources", "policies", "csrs"];
const ORGANIZATION_TABS = ["settings", "people", "members", "roles", "groups", "service-accounts", "projects"];
const SETTINGS_TABS = ["general", "members", "roles", "service-accounts", "access", "danger"];

/** One visit: the route it stands for (the key of the allow list) and the address opened. */
interface Visit {
  route: string;
  address: string;
}

/** The first link on a list page that opens one of its items, as a person would find it. */
async function firstItem(page: Page, list: string, pattern: RegExp): Promise<string | undefined> {
  await page.goto(`${list}?lang=en`, { waitUntil: "load" });
  await page.locator("main h1:visible").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  const hrefs = await page.locator("main a[href]").evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
  return hrefs.find((href) => pattern.test(href.split(/[?#]/)[0]));
}

/** The first stored item of a section, through the same API the list reads. */
async function firstName(page: Page, section: string): Promise<string | undefined> {
  const answer = await page.request.get(`/api/v1${P}/${section}`);
  if (!answer.ok()) return undefined;
  const items = ((await answer.json()) as { items?: { metadata?: { name?: string } }[] }).items ?? [];
  return items[0]?.metadata?.name;
}

/**
 * Every route of the router, with a real item for each name it takes. The Organization page's
 * Endpoints tab is an administration view (PF-61, T-2877): the steward, who administers the
 * organization on dev, visits it; the viewer is checked not to reach it (`endpointsRefused`).
 */
async function visits(page: Page, who: string): Promise<Visit[]> {
  const found: Visit[] = [
    { route: "/", address: "/" },
    { route: "/endpoints", address: "/endpoints" },
    { route: "/organization", address: "/organization" },
    ...[...ORGANIZATION_TABS, ...(who === "steward" ? ["endpoints"] : [])].map((tab) => ({
      route: "/organization/$tab",
      address: `/organization/${tab}`,
    })),
    { route: "/organization/$tab/$", address: "/organization/people/new" },
    { route: "/organization/$tab/$", address: "/organization/groups/new" },
    ...["workspaces", "activity", "approvals", "settings", "models", "explore", "ckan", "import", "assistant"].map((page) => ({
      route: `/projects/$project/${page}`,
      address: `${P}/${page}`,
    })),
    { route: "/projects/$project/workspaces/new", address: `${P}/workspaces/new` },
    { route: "/projects/$project/spaces/complete", address: `${P}/spaces/complete` },
    ...SETTINGS_TABS.map((tab) => ({ route: "/projects/$project/settings/$tab", address: `${P}/settings/${tab}` })),
    ...["members", "roles", "service-accounts"].map((tab) => ({
      route: "/projects/$project/settings/$tab/$",
      address: `${P}/settings/${tab}/new`,
    })),
    ...SECTIONS.map((section) => ({ route: "/projects/$project/$plural", address: `${P}/${section}` })),
    ...FORMS.map((section) => ({ route: "/projects/$project/$plural/new", address: `${P}/${section}/new` })),
  ];
  const items: [string, string, RegExp][] = [
    ["/projects/$project/$plural/$name", `${P}/spaces`, new RegExp(`^${P}/spaces/(?!complete$)[^/]+$`)],
    ["/projects/$project/$plural/$name", `${P}/endpoints`, new RegExp(`^${P}/endpoints/[^/]+$`)],
    ["/projects/$project/$plural/$name", `${P}/apps`, new RegExp(`^${P}/apps/[^/]+$`)],
    ["/projects/$project/models/$name", `${P}/models`, new RegExp(`^${P}/models/[^/]+$`)],
    ["/projects/$project/approvals/$id", `${P}/approvals`, new RegExp(`^${P}/approvals/chg-[0-9a-f]+$`)],
    ["/projects/$project/workspaces/$name/compare", `${P}/workspaces`, new RegExp(`^${P}/workspaces/[^/]+/compare$`)],
    ["/organization/$tab/$", "/organization/people", /^\/organization\/people\/(?!new$)[^/]+$/],
    ["/organization/$tab/$", "/organization/groups", /^\/organization\/groups\/(?!new$)[^/]+$/],
  ];
  for (const [route, list, pattern] of items) {
    const address = await firstItem(page, list, pattern);
    if (address) found.push({ route, address });
  }
  const copy = found.find((visit) => visit.route.endsWith("/compare"))?.address.replace(/\/compare$/, "");
  if (copy) {
    found.push({ route: "/projects/$project/workspaces/$name/try-it", address: `${copy}/try-it` });
    found.push({ route: "/projects/$project/workspaces/$name/bring-back", address: `${copy}/bring-back` });
  }
  for (const section of FORMS) {
    const name = await firstName(page, section);
    if (name) found.push({ route: "/projects/$project/$plural/$name/edit", address: `${P}/${section}/${encodeURIComponent(name)}/edit` });
  }
  return found;
}

/**
 * PF-61, T-2877: what a person who does not administer the organization meets at the
 * cross-project Endpoints — both addresses land on Settings, no tab and no menu entry offers it,
 * and the API answers `404`. Each line returned is a finding.
 */
async function endpointsRefused(page: Page): Promise<string[]> {
  const found: string[] = [];
  for (const address of ["/endpoints", "/organization/endpoints"]) {
    await page.goto(`${address}?lang=en`, { waitUntil: "load" });
    await page.waitForURL(/\/organization\/settings/, { timeout: 30_000 }).catch(() => undefined);
    if (!new URL(page.url()).pathname.endsWith("/organization/settings")) {
      found.push(`admin-only: ${address} stayed at ${new URL(page.url()).pathname}`);
    }
    if ((await page.getByRole("table", { name: "All endpoints" }).count()) > 0) {
      found.push(`admin-only: ${address} shows the table`);
    }
  }
  if ((await page.getByRole("tab", { name: "All endpoints" }).count()) > 0) found.push("admin-only: the tab is offered");
  if ((await page.getByRole("link", { name: "All endpoints" }).count()) > 0) found.push("admin-only: a link is offered");
  const answer = await page.request.get("/api/v1/endpoints");
  if (answer.status() !== 404) found.push(`admin-only: GET /api/v1/endpoints answered ${answer.status()}`);
  return found;
}

/** A 4xx a person may meet with nothing wrong (the same rule as `walk.spec.ts`). */
function expected(who: string, response: Response): boolean {
  const status = response.status();
  if (status === 403 && who === "viewer") return true;
  if (status === 404 && /\/cs\/[^/]+\/ngsi-ld\/v1\/entities\?/.test(response.url())) return true;
  return status === 410 || (status === 404 && /\/agent-runs\/[^/]+\/(preview|events)/.test(response.url()));
}

/** A write control the viewer can press, or one refused without a reason (UI-44). */
async function viewerWrites(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    for (const button of document.querySelectorAll("main button, main a[role='button']")) {
      const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!/^(New|Edit|Remove|Delete|Propose|Add|Create|Publish|Approve)\b/.test(name)) continue;
      if (button.getClientRects().length === 0 || button.closest("[hidden], [inert]")) continue;
      const refused = button.getAttribute("aria-disabled") === "true" || (button as HTMLButtonElement).disabled;
      const reason = (button.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .some((id) => (document.getElementById(id)?.textContent ?? "").trim().length > 0);
      if (!refused) found.push(`viewer-write: "${name}" can be pressed`);
      else if (!reason) found.push(`viewer-write: "${name}" is refused without a reason`);
    }
    return found;
  });
}

for (const [who, person] of [
  ["steward", STEWARD],
  ["viewer", VIEWER],
] as const) {
  test(`every page and form, at 1440 and 2560 px, for the ${who}`, async ({ browser }) => {
    test.setTimeout(2_400_000);
    const { context, page } = await signIn(browser, person, `${P}/spaces?lang=en`);
    const report: { route: string; address: string; width: number; findings: string[]; screenshot: string }[] = [];
    let current: string[] = [];
    let refused: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
        current.push(`console: ${message.text().slice(0, 200)}`);
      }
    });
    page.on("pageerror", (error) => current.push(`console: ${error.message.slice(0, 200)}`));
    page.on("response", (response) => {
      if (response.url().includes("/api/") && response.status() >= 400 && !expected(who, response)) {
        current.push(`http: ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
      }
    });

    try {
      const all = await visits(page, who);
      for (const size of WIDTHS) {
        await page.setViewportSize(size);
        for (const visit of all) {
          current = [];
          await page.goto(`${visit.address}${visit.address.includes("?") ? "&" : "?"}lang=en`, { waitUntil: "load" });
          await page.locator("h1:visible").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
          // The lists and forms read after the first paint; judge the page a person looks at.
          await page.waitForTimeout(1500);
          const findings = [
            ...current,
            ...(await page.evaluate(pageFindings, { namespaces: NAMESPACES, layout: true })),
            ...(await axeViolations(page))
              .filter((violation) => /\((serious|critical)\)/.test(violation))
              .map((violation) => `axe: ${violation.slice(0, 200)}`),
            ...(who === "viewer" ? await viewerWrites(page) : []),
          ];
          const screenshot = test.info().outputPath(`${who}-${size.width}${visit.address.replace(/[^a-z0-9]+/gi, "-")}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          report.push({ ...visit, width: size.width, findings: unexcused(visit.route, findings, allow.excused), screenshot });
        }
      }
      if (who === "viewer") refused = await endpointsRefused(page);
    } finally {
      await test.info().attach(`walker-${who}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
      await context.close();
    }
    expect(refused, "the cross-project Endpoints reach no one but an administrator").toEqual([]);
    expect(report.length, "the walker opened the pages").toBeGreaterThan(40);
    expect(report.filter((entry) => entry.findings.length > 0).map(({ address, width, findings }) => ({ address, width, findings }))).toEqual([]);
  });
}
