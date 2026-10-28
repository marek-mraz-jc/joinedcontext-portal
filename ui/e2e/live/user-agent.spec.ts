/**
 * T-5981 — the user agent on dev: a model plays a scenario's persona in a real browser and tries to
 * finish it alone (e2e/agent/run.ts). One test per scenario x width x language; each run's JSON and
 * shots land in `$AGENT_OUT/<scenario>-<persona>-<lang>-<width>-<model>/`.
 *
 *   AGENT_SCENARIOS=S-56,S-61,S-62 AGENT_MODEL=anthropic/claude-haiku-5.5 AGENT_WIDTHS=1440,400 \
 *   AGENT_LANGS=en,sk AGENT_OUT=/workspace/evidence/ui-agent/<run> EDITOR_PASSWORD=… \
 *     node node_modules/@playwright/test/cli.js test -c playwright.live.config.ts user-agent
 *
 * Without AGENT_SCENARIOS every case skips: a sweep of e2e/live spends no model money.
 * Personas: `citizen` (and every persona starting with it) walks anonymously from the
 * installation's front door; a steward walks the Portal as demo.editor, who proposes and decides
 * nothing (the steward demo person signs in with a TOTP seed only the cluster holds); `viewer`
 * as demo.viewer. No run opens a Change: holdWrites stops every write but a dry run or a draft.
 */
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { holdWrites, loadScenario, openRouterModel, runScenario } from "../agent/run";
import { EDITOR, VIEWER, goSignedIn, journeyMarkerOnPortalOnly } from "./portal";

const PORTAL = new URL(process.env.PORTAL_URL ?? "https://portal.dev.joinedcontext.com");
const DOMAIN = PORTAL.hostname.replace(/^portal\./, "");
const HOSTS = [PORTAL.host, DOMAIN, `opendata.${DOMAIN}`, `api.${DOMAIN}`];
const list = (value: string | undefined, fallback: string) => (value ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
const SCENARIOS = list(process.env.AGENT_SCENARIOS, "");
const WIDTHS = list(process.env.AGENT_WIDTHS, "1440,400").map(Number);
const LANGS = list(process.env.AGENT_LANGS, "en");
const MODEL = process.env.AGENT_MODEL ?? "anthropic/claude-haiku-5.5";
const OUT = process.env.AGENT_OUT ?? "test-results/ui-agent";

/** Who signs in for a persona, and where the run starts. */
function who(persona: string): { person?: { user: string; password: string }; start: string } {
  if (persona.startsWith("citizen") || persona === "journalist") return { start: `https://${DOMAIN}/` };
  if (persona === "viewer" || persona === "analyst") return { person: VIEWER, start: "/" };
  return { person: EDITOR, start: "/" };
}

test.describe("user agent", () => {
  test.skip(SCENARIOS.length === 0, "set AGENT_SCENARIOS to run the user agent (it spends model tokens)");
  for (const id of SCENARIOS) {
    for (const lang of LANGS) {
      for (const width of WIDTHS) {
        test(`${id} ${lang} ${width}`, async ({ browser }) => {
          test.setTimeout(30 * 60_000);
          const scenario = loadScenario(id);
          const persona = scenario.as;
          const { person, start } = who(persona);
          const context = await browser.newContext({
            viewport: { width, height: width < 600 ? 860 : 900 },
            locale: lang === "sk" ? "sk-SK" : "en-GB",
            isMobile: width < 600,
            hasTouch: width < 600,
          });
          await journeyMarkerOnPortalOnly(context, PORTAL.host);
          const held: string[] = [];
          await holdWrites(context, HOSTS, held);
          const page = await context.newPage();
          const first = `${start}${start.includes("?") ? "&" : "?"}lang=${lang}`;
          // An anonymous "/" answers the catalogue, which has no /login hop: sign in through the demo
          // people's project helsinki, then start where the persona starts.
          if (person) await goSignedIn(page, person, `/projects/helsinki/explore?lang=${lang}`);
          await page.goto(first, { waitUntil: "load" });
          const dir = join(OUT, `${id}-${persona}-${lang}-${width}-${MODEL.replace(/[^a-z0-9.]+/gi, "_")}`);
          const run = await runScenario({ page, scenario, persona, width, lang, model: openRouterModel(MODEL), dir, hosts: HOSTS, held });
          console.log(`${id} ${lang} ${width} ${MODEL}: ${run.outcome} in ${run.steps.length} steps, ${run.ms} ms, USD ${run.costUsd}: ${run.answer}`);
          expect(run.secretsHidden, "credential-shaped text on a page the model read").toBe(0);
          await context.close();
        });
      }
    }
  }
});
