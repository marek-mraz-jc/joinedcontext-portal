import { expect } from "@playwright/test";
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from "@playwright/test";

/**
 * The project sections the installation hides (`hiddenSections` of `/api/v1/branding`, T-2874):
 * a case over one is excused while it is hidden, and runs again the day it is shown.
 */
export async function hiddenSections(request: APIRequestContext): Promise<string[]> {
  const answer = await request.get("/api/v1/branding");
  const hidden = answer.ok() ? ((await answer.json()) as { hiddenSections?: unknown }).hiddenSections : undefined;
  return Array.isArray(hidden) ? hidden.filter((section): section is string => typeof section === "string") : [];
}

/** Whether a Portal address lies in one of the `hidden` sections. */
export function inHiddenSection(address: string, hidden: string[]): boolean {
  const section = address.split(/[?#]/)[0].split("/")[3];
  return section !== undefined && hidden.includes(section);
}

/** The two demo people of the Load journey: one proposes, the other approves (CC-34). */
export const STEWARD = { user: "demo.steward@hel.fi", password: process.env.PORTAL_PASSWORD ?? "" };
export const APPROVER = { user: "demo.approver@hel.fi", password: process.env.APPROVER_PASSWORD ?? "" };
/** A person who may read the projects and change nothing. */
export const VIEWER = { user: "demo.viewer@hel.fi", password: process.env.VIEWER_PASSWORD ?? "" };
/**
 * The person who proposes and decides nothing (T-2231): bound to `editor` alone, so their own
 * change is the plain CC-34 refusal rather than the PF-58 administrator exception the steward
 * gets, and a role they hand out may carry no verb they lack (PF-50).
 */
export const EDITOR = { user: "demo.editor@hel.fi", password: process.env.EDITOR_PASSWORD ?? "" };
/**
 * The residue sweep's approver (T-2627): bound to `janitor`, which approves and deletes only
 * journey- and take-named resources of helsinki, so the sweep needs no demo person's delete.
 */
export const JANITOR = { user: "demo.janitor@hel.fi", password: process.env.JANITOR_PASSWORD ?? "" };
/**
 * The seeded workload on the Portal's side (T-2245, PF-45, PF-49): ServiceAccount
 * `helsinki/pipeline-proposer`, whose Keycloak client `helsinki-pipeline-proposer` mints a
 * `portal-api` token and holds `pipeline-editor` (propose DataSource and Pipeline) without approve
 * (PF-58). Its secret is Secret `keycloak-client-helsinki-pipeline-proposer`, key `client-secret`.
 */
export const PROPOSER = { client: "helsinki-pipeline-proposer", secret: process.env.PROPOSER_CLIENT_SECRET ?? "" };

/**
 * A `client_credentials` token of the proposer account, found the way an MCP client finds it: the
 * Portal's protected-resource metadata names the authorization server (RFC 9728), whose discovery
 * document names the token endpoint. Plain `fetch`, never the Playwright request context: the
 * journey header of the live config is refused beside a bearer token.
 */
export async function serviceAccountToken(baseURL: string): Promise<string> {
  if (!PROPOSER.secret) {
    throw new Error(`no PROPOSER_CLIENT_SECRET in the environment for ${PROPOSER.client}`);
  }
  const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/api/v1/mcp", baseURL));
  expect(metadata.ok, "the Portal's protected-resource metadata").toBe(true);
  const issuer = ((await metadata.json()) as { authorization_servers?: string[] }).authorization_servers?.[0];
  if (!issuer) {
    throw new Error("the protected-resource metadata names no authorization server");
  }
  const discovery = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  expect(discovery.ok, `the discovery document of ${issuer}`).toBe(true);
  const { token_endpoint: tokenEndpoint } = (await discovery.json()) as { token_endpoint: string };
  const answer = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: PROPOSER.client,
      client_secret: PROPOSER.secret,
    }),
  });
  if (!answer.ok) {
    // Keycloak's error names the cause (unauthorized_client, invalid_client); the secret is not in it.
    throw new Error(`the token endpoint refused ${PROPOSER.client}: ${answer.status} ${await answer.text()}`);
  }
  return ((await answer.json()) as { access_token: string }).access_token;
}

/**
 * The App probe (T-2795, AP-136): a member of every App's default group who reads `App` and
 * nothing else, so what it sees is what an App's own people see.
 */
export const PROBE = { user: "demo.probe@hel.fi", password: process.env.PROBE_PASSWORD ?? "" };

/**
 * Signs one browser context in through the edge: the Portal's /login button, Keycloak's form
 * (`#username`, `#password`, `#kc-login`), back to the page asked for. Mirrors
 * joinedcontext-presentation/record/acts/_portal.py so a spec and a recording take one path.
 */
export async function signIn(browser: Browser, who: { user: string; password: string }, path: string): Promise<{ context: BrowserContext; page: Page }> {
  if (!who.password) {
    throw new Error(
      `no password in the environment for ${who.user} ` +
        "(PORTAL_PASSWORD / APPROVER_PASSWORD / VIEWER_PASSWORD / EDITOR_PASSWORD / JANITOR_PASSWORD / PROBE_PASSWORD)",
    );
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await goSignedIn(page, who, path);
  return { context, page };
}

/** The Portal's own landmark: what every Portal page has once the sign-in is over. */
export const portalReady = (page: Page): Locator => page.getByRole("navigation", { name: "Main navigation" });

/**
 * Opens `url` and walks whatever sign-in stands in the way — the Portal's /login button, Keycloak's
 * form — until `ready` is visible. An application page has no Portal navigation, so a journey into
 * one names its own landmark (the app's heading) rather than waiting for one that never comes
 * (T-2309).
 */
export async function goSignedIn(
  page: Page,
  who: { user: string; password: string },
  url: string,
  ready: (page: Page) => Locator = portalReady,
): Promise<void> {
  // `load`, never `networkidle`: the Portal holds an activity stream and a drafts stream open
  // (`src/api/activity.ts`, `src/api/drafts.ts`, both `EventSource`) and polls a pending list
  // every ten seconds, so the network is never idle on any signed-in page. Waiting for it spent
  // the whole test budget on the login hop and every journey read as a timeout on whatever came
  // next (T-2452). Each step below waits for the thing it actually needs instead.
  await page.goto(url, { waitUntil: "load" });
  for (let step = 0; step < 4; step += 1) {
    if (await page.locator("#username").count()) {
      await page.fill("#username", who.user);
      await page.fill("#password", who.password);
      await Promise.all([page.waitForURL(() => true, { waitUntil: "load" }), page.click("#kc-login")]);
      continue;
    }
    const signInButton = page.getByRole("button", { name: "Sign in" });
    if (page.url().includes("/login") && (await signInButton.count())) {
      await Promise.all([
        page.waitForURL(() => true, { waitUntil: "load" }),
        signInButton.first().click(),
      ]);
      continue;
    }
    break;
  }
  await expect(ready(page)).toBeVisible({ timeout: 60_000 });
}

/** Asks in the docked assistant: its first composer, or the conversation's once one is running. */
export async function ask(page: Page, text: string): Promise<void> {
  const bubble = page.getByRole("button", { name: "Open the assistant" });
  if (await bubble.count()) {
    await bubble.first().click();
  }
  const composer = page
    .getByLabel(/^(Ask the assistant|Tell the assistant what to build or change…)$/)
    .first();
  await composer.fill(text);
  await composer.press("Enter");
}

/** The change a proposal answered with, read off the notice the page shows (UI-23). */
export async function proposedChange(page: Page): Promise<string> {
  const review = page.getByRole("link", { name: "Review it in Approvals" });
  try {
    await expect(review).toBeVisible({ timeout: 60_000 });
  } catch (err) {
    // What the page says instead of the notice: a verdict, a refusal, a dialog still open.
    const said = await page.locator("[data-testid=form-page], [role=dialog], [role=alert], [role=status]").allInnerTexts();
    throw new Error(`no proposal notice; the page says: ${JSON.stringify(said)}\n${String(err)}`);
  }
  const href = (await review.getAttribute("href")) ?? "";
  const id = href.split("/approvals/")[1]?.split(/[?#]/)[0];
  if (!id) {
    throw new Error(`the notice links nowhere useful: ${href}`);
  }
  return id;
}

/**
 * Approves one change as the approver. A Yellow lane needs no typed confirmation; a Red one
 * (a public Endpoint, CC-19) asks for the resource name, typed as a person would.
 */
export async function approve(page: Page, project: string, change: string, confirm?: string): Promise<void> {
  await page.goto(`/projects/${project}/approvals/${change}?lang=en`, { waitUntil: "load" });
  const button = page.getByRole("button", { name: "Approve", exact: true });
  // Only a Red lane asks for the name typed back (CC-19). A caller that knows the name passes it
  // and this types it when the page asks; a Yellow change has no such field, and waiting for one
  // would fail on a change that needed no confirmation.
  const input = page.locator("#confirm-resource-name");
  // The lane arrives with the change's plan, after the load: wait until the page has either
  // enabled Approve (Yellow) or rendered the name field (Red), then answer the field if it is there.
  await expect(button.and(page.locator(":enabled")).or(input).first()).toBeVisible({ timeout: 60_000 });
  if (confirm && (await input.count())) {
    await expect(input).toBeEnabled({ timeout: 60_000 });
    await input.pressSequentially(confirm, { delay: 60 });
  }
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  await expect(page.getByText(/Deploying|Merged|Applied|Live/).first()).toBeVisible({ timeout: 90_000 });
}

/**
 * Rejects one change as the approver, so a proposal a spec made leaves dev as it was.
 *
 * Reject opens a dialog and its confirmation stays disabled until a reason is typed: the proposer
 * reads that reason on the change. A helper that only clicked Reject left the dialog open and the
 * change PendingApproval — which is how this journey left changes behind on dev (T-1597).
 */
export async function reject(
  page: Page,
  project: string,
  change: string,
  reason = "Rejected by a live journey: this change was proposed only to prove the form.",
): Promise<void> {
  await page.goto(`/projects/${project}/approvals/${change}?lang=en`, { waitUntil: "load" });
  const button = page.getByRole("button", { name: "Reject", exact: true });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Why are you rejecting this?").fill(reason);
  await dialog.getByRole("button", { name: "Reject the change" }).click();
  await expect(page.getByText(/Rejected/).first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Proposes the deletion of one resource the way a person does (a Red Change, CC-19): its row's
 * menu on the kind's list, Remove, the name typed back, Propose removal; returns the change's id.
 * The row offers no "Delete …" button: the removal is one item of "More actions for …"
 * (`ResourceRowActions`), and the old selector matched nothing (T-2729).
 */
export async function proposeDelete(page: Page, project: string, plural: string, name: string): Promise<string> {
  await page.goto(`/projects/${project}/${plural}?lang=en`);
  const row = page.locator("tr, li").filter({ hasText: name }).first();
  await row.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  await dialog.getByRole("button", { name: "Propose removal" }).click();
  const id = dialog.getByText(/^chg-[0-9a-f]{8}$/);
  await expect(id, `delete ${plural}/${name}`).toBeVisible({ timeout: 30_000 });
  return (await id.textContent()) ?? "";
}

/**
 * Deletes every draft of this journey and proves none is left (AG-61, T-2249).
 *
 * A journey that opens forms leaves drafts behind: the Portal keeps what a form holds so the person
 * can come back to it. Left on dev they are not harmless — 44 of them answered 2.3 MB on the drafts
 * route and the docked assistant could then answer nothing at all (T-2248). A deletion needs the
 * CSRF header like every other write, and the check afterwards is the point: without it the sweep
 * answers 403 and cleans nothing, which is what the first run of `hostile-names` did (T-1591).
 */
export async function sweepDrafts(
  context: BrowserContext,
  page: Page,
  project: string,
  mine: RegExp,
  also: { kind: string; name: string }[] = [],
): Promise<void> {
  const token = await csrf(context);
  const named = (draft: { name?: string; metadata?: { name?: string } }) =>
    draft.name ?? draft.metadata?.name ?? "";
  const left = new Map<string, { kind: string; name: string }>();
  const listed = await page.request.get(`/api/v1/projects/${project}/drafts`);
  if (listed.ok()) {
    for (const draft of ((await listed.json()).items ?? []) as {
      kind?: string;
      name?: string;
      metadata?: { name?: string };
    }[]) {
      const name = named(draft);
      if (mine.test(name)) {
        left.set(`${draft.kind ?? ""}/${name}`, { kind: draft.kind ?? "ContextSpace", name });
      }
    }
  }
  for (const one of also) {
    left.set(`${one.kind}/${one.name}`, one);
  }
  for (const { kind, name } of left.values()) {
    await page.request.delete(
      `/api/v1/projects/${project}/drafts/${kind}/${encodeURIComponent(name)}`,
      { headers: { "x-csrf-token": token } },
    );
  }
  const after = await page.request.get(`/api/v1/projects/${project}/drafts`);
  if (!after.ok()) {
    return;
  }
  const remaining = ((await after.json()).items ?? [])
    .map(named)
    .filter((name: string) => mine.test(name));
  expect(remaining, "a draft of this journey is still in the project").toEqual([]);
}

/** The names of a project's resources of one kind, as the list route answers them. */
export async function listedNames(page: Page, project: string, plural: string): Promise<string[]> {
  const answer = await page.request.get(`/api/v1/projects/${project}/${plural}`);
  expect(answer.ok(), `list ${plural}`).toBe(true);
  const body = (await answer.json()) as { items?: { metadata: { name: string } }[] };
  return (body.items ?? []).map((item) => item.metadata.name);
}

/**
 * The CSRF token of a signed-in context, so a spec's own API call goes through the same door the
 * page's calls go through. A request without it is refused by the middleware, and a spec that
 * reads that refusal as the rule it meant to test proves nothing (T-1585).
 */
export async function csrf(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((each) => each.name === "jc_csrf");
  if (!cookie) {
    throw new Error("no jc_csrf cookie in this context: the session did not complete");
  }
  return cookie.value;
}

/**
 * The check a manifest proposed without a draft needs first (PF-57, T-0956): the verdict gate
 * refuses an unchecked one on every door with `verdict_required`. The check records its verdict
 * under the manifest's own kind and name, fresh for these exact bytes; a proposal that became a
 * Change forgets it, so each door checks again (T-2631).
 */
export async function checkManifest(page: Page, context: BrowserContext, project: string, manifest: { kind: string } & Record<string, unknown>): Promise<void> {
  const [op, field] =
    manifest.kind === "Pipeline"
      ? ["jc_pipeline_test", "pipeline"]
      : manifest.kind === "DataSource"
        ? ["jc_datasource_check", "manifest"]
        : ["jc_manifest_dry_run", "manifest"];
  const answer = await page.request.post(`/api/v1/projects/${project}/ops/${op}`, {
    headers: { "x-csrf-token": await csrf(context), "content-type": "application/json" },
    data: { [field]: manifest },
  });
  const text = await answer.text();
  if (!answer.ok()) {
    throw new Error(`${op} of ${manifest.kind}: ${answer.status()} ${text}`);
  }
  const verdict = (JSON.parse(text) as { verdict?: { ok?: boolean } }).verdict;
  if (verdict?.ok !== true) {
    throw new Error(`${op} of ${manifest.kind} is not green: ${text.slice(0, 500)}`);
  }
}

/**
 * Removes a resource a journey created, all the way: the removal is itself a Change, so it is
 * proposed and then approved. A journey that only sent the DELETE left the resource standing and the
 * change open — which is how three spaces were found on dev on 2026-09-18 (T-2236).
 *
 * The **owner** approves it, not the approver: approving a removal needs `delete` on the kind
 * (`an_approver_approves_a_grant_only_within_their_own_rights_and_a_removal_only_with_delete`), which
 * the `approver` role does not carry and `demo.steward` does through `org-admin`. A steward
 * approving their own removal is the administrator exception of CC-34, the one
 * `roles-refusals.spec.ts` plays.
 */
export async function removeCompletely(
  owner: { context: BrowserContext; page: Page },
  project: string,
  plural: string,
  name: string,
): Promise<void> {
  const token = await csrf(owner.context);
  const answer = await owner.page.request.delete(`/api/v1/projects/${project}/${plural}/${name}`, {
    headers: { "x-csrf-token": token },
    data: { confirm: name },
  });
  if (answer.status() === 404) {
    return;
  }
  if (answer.status() !== 202) {
    throw new Error(`removal of ${plural}/${name} was refused: ${await answer.text()}`);
  }
  const change = ((await answer.json()) as { metadata?: { name?: string } }).metadata?.name ?? "";
  if (!change) {
    throw new Error(`the removal of ${plural}/${name} named no change`);
  }
  await approve(owner.page, project, change, name);
}

