import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

const run = promisify(execFile);

/** The forge organization of the configuration (PF-85); the bootstrap names it `joinedcontext`. */
export const FORGE_ORG = process.env.JC_FORGE_ORG ?? "joinedcontext";
/** The organization repository of layout 2 (PF-86): it kept the old repository's name. */
export const ORG_REPO = process.env.JC_FORGE_ORG_REPO ?? "configuration";

/** A person signed in to the forge with their own identity, and the forge token they made there. */
export interface ForgePerson {
  context: BrowserContext;
  page: Page;
  login: string;
  token: string;
  tokenName: string;
}

/**
 * Signs one browser context in to the forge through its Keycloak button, the way a person does
 * (PF-79), and has them make a repository token on their own settings page (PF-87: git runs over
 * HTTPS with the person's own forge credential). The token never reaches a log: it is handed to
 * git through the environment, never on a command line or in a URL.
 */
export async function forgeSignIn(browser: Browser, who: { user: string; password: string }, tokenName: string): Promise<ForgePerson> {
  if (!who.password) {
    throw new Error(`no password in the environment for ${who.user}`);
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/git/user/oauth2/keycloak", { waitUntil: "load" });
  if (await page.locator("#username").count()) {
    await page.fill("#username", who.user);
    await page.fill("#password", who.password);
    await Promise.all([page.waitForURL(/\/git\//, { waitUntil: "load" }), page.click("#kc-login")]);
  }
  await expect(page, `${who.user} is back in the forge after the Keycloak login`).toHaveURL(/\/git\//, { timeout: 60_000 });

  await page.goto("/git/user/settings/applications", { waitUntil: "load" });
  const csrfToken = await page.locator('meta[name="_csrf"]').getAttribute("content");
  if (!csrfToken) {
    throw new Error(`the forge's token page holds no _csrf for ${who.user}: the session did not complete`);
  }
  const made = await page.request.post("/git/user/settings/applications", {
    form: { _csrf: csrfToken, name: tokenName, scope: "write:repository" },
  });
  const html = await made.text();
  const token = /flash-info[^>]*>\s*<p>\s*([0-9a-f]{40})\s*<\/p>/.exec(html)?.[1];
  if (!token) {
    const said = /flash-(?:error|warning)[^>]*>\s*<p>([^<]+)</.exec(html)?.[1]?.trim();
    throw new Error(`the forge made no token for ${who.user}: ${said ?? `HTTP ${made.status()}`}`);
  }
  const user = await page.request.get("/git/api/v1/user", { headers: { authorization: `token ${token}` } });
  expect(user.ok(), `the forge reads ${who.user}'s own account with the new token`).toBe(true);
  const login = ((await user.json()) as { login: string }).login;
  return { context, page, login, token, tokenName };
}

/** Revokes the token the journey made and closes the session; nothing of the journey stays in the forge. */
export async function forgeSignOut(person: ForgePerson | null): Promise<void> {
  if (!person) return;
  try {
    await person.page.goto("/git/user/settings/applications", { waitUntil: "load" });
    const html = await person.page.content();
    const csrfToken = await person.page.locator('meta[name="_csrf"]').getAttribute("content");
    const escaped = person.tokenName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const id = new RegExp(`${escaped}[\\s\\S]*?data-id="(\\d+)"`).exec(html)?.[1];
    if (id && csrfToken) {
      await person.page.request.post("/git/user/settings/applications/delete", { form: { _csrf: csrfToken, id } });
    }
  } finally {
    await person.context.close();
  }
}

/** The forge's own answer to a person reading a repository over git's HTTP protocol: 200 or 404. */
export async function gitReadStatus(baseURL: string, person: ForgePerson, repo: string): Promise<number> {
  const answer = await fetch(new URL(`/git/${FORGE_ORG}/${repo}.git/info/refs?service=git-upload-pack`, baseURL), {
    headers: { authorization: `Basic ${Buffer.from(`${person.login}:${person.token}`).toString("base64")}` },
  });
  return answer.status;
}

/** Runs git with the person's forge credential in the environment (never argv, never a URL). */
export async function git(person: ForgePerson, cwd: string, args: string[]): Promise<string> {
  const header = `Authorization: Basic ${Buffer.from(`${person.login}:${person.token}`).toString("base64")}`;
  try {
    const { stdout } = await run("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: header,
        GIT_CONFIG_KEY_1: "user.name",
        GIT_CONFIG_VALUE_1: person.login,
        GIT_CONFIG_KEY_2: "user.email",
        GIT_CONFIG_VALUE_2: `${person.login}@journeys.joinedcontext.com`,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    // execFile's message repeats the command line, which holds no secret: the header is in env.
    const failed = error as { stderr?: string; message?: string };
    throw new Error(`git ${args[0]} failed: ${failed.stderr?.trim() || failed.message}`);
  }
}

/** A clone of one project repository in a directory of its own, removed by `done`. */
export async function cloneRepository(baseURL: string, person: ForgePerson, repo: string): Promise<{ dir: string; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), `t2647-${repo}-`));
  const url = new URL(`/git/${FORGE_ORG}/${repo}.git`, baseURL).toString();
  await git(person, dir, ["clone", "--quiet", url, "."]);
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

/** One forge API call in the person's name. */
export async function forgeApi(person: ForgePerson, method: "GET" | "POST" | "DELETE", path: string, data?: unknown) {
  return person.page.request.fetch(`/git/api/v1${path}`, {
    method,
    headers: { authorization: `token ${person.token}`, "content-type": "application/json" },
    data: data === undefined ? undefined : JSON.stringify(data),
  });
}
