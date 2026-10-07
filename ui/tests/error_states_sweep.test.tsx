/**
 * T-3244: every project page whose API fails shows the one failure panel: the API's sentence in
 * an alert, and Retry for a failure asking again can help. The pages are the project routes of
 * src/router.tsx that need no object name, and the lists of every section with a page of its own.
 */
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";
import { problem, renderRoute } from "./pageHarness";

const PAGES = [
  "activity",
  "approvals",
  "access",
  "settings/general",
  "settings/members",
  "settings/roles",
  "models",
  "explore",
  "ckan",
  "knowledge",
  "mcp",
  "workspaces",
  "assistant",
  "shared",
  "spaces",
  "endpoints",
  "pipelines",
  "policies",
  "subscriptions",
  "csrs",
  "datasources",
  "dashboards",
  "apps",
  "syncsources",
  "roles",
  "mappings",
];

const FAILURE = "The configuration store did not answer.";

describe("a project page whose API fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(PAGES)(
    "/projects/helsinki/%s says why and offers Retry",
    async (page) => {
      await renderRoute({
        path: `/projects/helsinki/${page}`,
        answer: (path) =>
          path.startsWith("/api/v1/projects/")
            ? problem(503, FAILURE)
            : undefined,
      });
      const alerts = await screen.findAllByRole(
        "alert",
        {},
        { timeout: 5_000 },
      );
      const failed = alerts.find((alert) =>
        alert.textContent?.includes(FAILURE),
      );
      expect(
        failed,
        `no alert carries the API's sentence: ${alerts.map((a) => a.textContent).join(" | ")}`,
      ).toBeDefined();
      // The page's panel says Retry; a picker's own line under its field says it in the form's words.
      const retry = within(failed as HTMLElement).queryAllByRole("button", {
        name: new RegExp(`^(${en.app.error.retry}|${en.form.listRetry})$`),
      });
      expect(
        retry.length,
        `no Retry beside: ${failed?.textContent}`,
      ).toBeGreaterThan(0);
    },
  );
});
