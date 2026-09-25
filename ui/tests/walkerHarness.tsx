/**
 * T-2730: the page walker's address book and its walk, shared by the three walker files
 * (`walker_pages`, `walker_forms`, `walker_details`), which vitest runs side by side
 * (UI-01, UI-15, UI-16, UI-84).
 *
 * The live walker (`e2e/live/walker.spec.ts`) asks the same of dev at 1440 and 2560 px with real
 * data. This one runs in the fast suite on every push, so a page that loses its purpose line, an
 * empty state that stops saying what to do, a field without its hint or a raw i18n key is red
 * before it is deployed. Layout (overflow, form columns) needs a browser and is left to the live
 * walk. What is broken today is in `walker.allow.json`, each entry with the task that fixes it;
 * the list only shrinks, and an entry whose page is clean now is itself a failure.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "@testing-library/react";
import axe from "axe-core";
import { expect } from "vitest";
import en from "../src/locales/en.json";
import { NAV_SECTIONS } from "../src/components/layout/navigation";
import { ORGANIZATION_TABS } from "../src/pages/organization/OrganizationPage";
import { PROJECT_SETTINGS_TABS } from "../src/pages/projectSettings/ProjectSettingsPage";
import { pageFindings, unexcused } from "./pageChecks";
import type { Excused } from "./pageChecks";
import { jsonResponse, problem, renderRoute } from "./pageHarness";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const P = "/projects/helsinki";

/** The sections `/$plural/new` and `/$plural/$name/edit` open a form in (`NEW_FORMS`, src/agents/change.rs). */
const FORMS = ["spaces", "endpoints", "pipelines", "policies", "subscriptions", "csrs", "datasources", "syncsources"];
/** The kinds with a page of their own (`DETAIL_PAGES`, src/router.tsx). */
const DETAILS = ["spaces", "endpoints", "apps"];

/** Every route of the router, as the addresses a person opens it by. */
export const ADDRESSES: Record<string, string[]> = {
  "/login": ["/login"],
  "/": ["/"],
  "/endpoints": ["/endpoints"],
  "/catalogue": ["/catalogue"],
  "/catalogue/$name": ["/catalogue/air"],
  "/playground": ["/playground"],
  "/organization": ["/organization"],
  "/organization/$tab": ORGANIZATION_TABS.map((tab) => `/organization/${tab}`),
  "/organization/$tab/$": ["/organization/people/new", "/organization/people/p-1", "/organization/groups/new", "/organization/groups/stewards"],
  "/projects/$project/workspaces": [`${P}/workspaces`],
  "/projects/$project/workspaces/new": [`${P}/workspaces/new`],
  "/projects/$project/workspaces/$name/compare": [`${P}/workspaces/air-v2/compare`],
  "/projects/$project/workspaces/$name/try-it": [`${P}/workspaces/air-v2/try-it`],
  "/projects/$project/workspaces/$name/bring-back": [`${P}/workspaces/air-v2/bring-back`],
  "/projects/$project/activity": [`${P}/activity`],
  "/projects/$project/approvals": [`${P}/approvals`],
  "/projects/$project/approvals/$id": [`${P}/approvals/chg-0a1b2c3d`],
  "/projects/$project/access": [`${P}/access`],
  "/projects/$project/settings": [`${P}/settings`],
  "/projects/$project/settings/$tab": PROJECT_SETTINGS_TABS.map((tab) => `${P}/settings/${tab}`),
  "/projects/$project/settings/$tab/$": [`${P}/settings/members/new`, `${P}/settings/roles/new`, `${P}/settings/service-accounts/new`],
  "/projects/$project/models": [`${P}/models`],
  "/projects/$project/models/$name": [`${P}/models/helsinki`],
  "/projects/$project/explore": [`${P}/explore`],
  "/projects/$project/ckan": [`${P}/ckan`],
  "/projects/$project/import": [`${P}/import`],
  "/projects/$project/federation": [`${P}/federation`],
  "/projects/$project/spaces/complete": [`${P}/spaces/complete`],
  "/projects/$project/assistant": [`${P}/assistant`],
  "/projects/$project/shared": [`${P}/shared`],
  "/projects/$project/$plural": NAV_SECTIONS.map(({ plural }) => `${P}/${plural}`).concat(`${P}/csrs`),
  "/projects/$project/$plural/new": FORMS.map((plural) => `${P}/${plural}/new`),
  "/projects/$project/$plural/$name/edit": FORMS.map((plural) => `${P}/${plural}/air/edit`),
  "/projects/$project/$plural/$name": DETAILS.map((plural) => `${P}/${plural}/air`),
  // A published App inside the Portal (AP-122); only `apps` has it.
  "/projects/$project/$plural/$name/open": [`${P}/apps/air/open`],
};

/** Built only by the dev server (T-1729); a deployed Portal never serves it. */
export const DEVELOPMENT_ONLY = ["/__gallery"];

export const allow = JSON.parse(readFileSync(join(ui, "tests/walker.allow.json"), "utf8")) as { excused: Excused[] };
const NAMESPACES = Object.keys(en);

/** The names the addresses above make up: nothing on the mocked instance holds them. */
const MADE_UP = new Set(["p-1", "stewards", "air", "air-v2", "chg-0a1b2c3d", "helsinki"]);

/**
 * A read of one made-up resource answers 404, as the Portal does for a name nobody holds; every
 * list answers empty. So a detail page is walked in its not-found state and a list in its empty
 * one, which are the two states a page is most often left untested in.
 */
function answer(path: string): Response | undefined {
  // The catalogue is a page of its own shape, not a list: empty, as an installation with no
  // published dataset answers it.
  if (path === "/api/v1/catalogue") {
    const none = { publisher: [], theme: [], format: [], licence: [], spatial: [], year: [] };
    return jsonResponse({ total: 0, page: 1, pageSize: 20, datasets: [], facets: none, unavailable: [] });
  }
  const last = decodeURIComponent(path.split("/").pop() ?? "");
  return MADE_UP.has(last) && path !== "/api/v1/projects/helsinki" ? problem(404, `${last} was not found`) : undefined;
}

/** How long a page must stay the same to count as settled: three of `waitFor`'s intervals. */
const SETTLED_MS = 450;

/** What one address shows once it has settled: the page's findings, and axe's serious ones. */
export async function walk(address: string): Promise<string[]> {
  await renderRoute({ path: address, answer });
  // A page has settled when its heading is there, nothing says it is still loading, and two
  // readings a moment apart agree: a routed form opens an effect or two after the list answers, and
  // its fields after their own reads: a reading taken in between sees a page nobody is shown.
  // `waitFor` also reads on every DOM mutation, so "a moment" is measured in time, not in
  // readings: three mutations of one render are microseconds apart, and between the spinner
  // going and the form arriving they agree on a page with no field at all (T-2850). A reading
  // is the findings and the page's shape, so a page that is still growing is not settled.
  let findings: string[] = [];
  let reading = "";
  let since = Date.now();
  await waitFor(
    () => {
      findings = pageFindings({ namespaces: NAMESPACES, layout: false });
      const now = JSON.stringify([findings, document.body.querySelectorAll("*").length]);
      if (now !== reading) {
        reading = now;
        since = Date.now();
      }
      const settled = Date.now() - since >= SETTLED_MS;
      expect(document.querySelector("h1")).not.toBeNull();
      expect(document.querySelector("[aria-busy='true']")).toBeNull();
      expect(settled).toBe(true);
    },
    { timeout: 6000, interval: 150 },
  ).catch(() => undefined);
  const results = await axe.run(document.body, { resultTypes: ["violations"] });
  for (const violation of results.violations) {
    if (violation.impact === "serious" || violation.impact === "critical") {
      findings.push(`axe: ${violation.id} (${violation.nodes.map((node) => node.target.join(" ")).join(", ").slice(0, 120)})`);
    }
  }
  return findings;
}

/** Every address, and which of the three walker files walks it. */
export function addresses(part: "forms" | "details" | "pages"): string[] {
  const all = Object.values(ADDRESSES).flat();
  const form = (address: string) => /\/(new|edit)$/.test(address);
  const detail = (address: string) => !form(address) && /^\/(projects\/helsinki\/[^/]+|organization\/[^/]+)\/.+/.test(address);
  return all.filter((address) => (part === "forms" ? form(address) : part === "details" ? detail(address) : !form(address) && !detail(address)));
}

/** One address walked: nothing unexcused, and no entry excusing what is clean now. */
export async function expectWalked(address: string): Promise<void> {
  const findings = await walk(address);
  expect(unexcused(address, findings, allow.excused)).toEqual([]);
  const stale = allow.excused.filter(
    (entry) => entry.route === address && !findings.some((finding) => finding.startsWith(`${entry.check}:`)),
  );
  expect(stale.map((entry) => `${entry.check} (${entry.task}) is clean now: remove it from walker.allow.json`)).toEqual([]);
}
