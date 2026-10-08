import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// T-3273: the inbox, answered from the browser like the approvals journey: one change waits, its
// diff opens in the list, and Approve decides it without leaving the page.

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@banskabystrica.sk",
  roles: ["portal-approver"],
};

const PROJECTS = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ProjectList",
  items: [{ name: "helsinki" }],
};

const PROPOSAL = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "ChangeProposal",
  metadata: { name: "chg-1a2b3c4d", namespace: "helsinki" },
  summary: {
    key: "change.summary.update",
    params: { kind: "Endpoint", name: "air-quality", fields: 2 },
  },
  author: { name: "Marek Mráz", email: "marek@banskabystrica.sk" },
  createdAt: "2026-03-03T12:00:00Z",
  status: {
    lane: "yellow",
    phase: "PendingApproval",
    plan: { update: 1 },
    mergeRequest: "https://gitea.example/city/city-config/pulls/7",
  },
  planFields: [
    { path: "spec.audience", from: "public", to: "internal" },
    { path: "spec.credentials.token", from: "[REDACTED]", to: "[REDACTED]" },
  ],
};

const APPROVED = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: PROPOSAL.metadata,
  status: { lane: "yellow", phase: "Deploying", plan: { update: 1 } },
};

async function stubApi(page: Page): Promise<{ approvals: string[] }> {
  const approvals: string[] = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname.endsWith("/auth/me")) {
      return json(IDENTITY);
    }
    if (url.pathname.endsWith("/approve")) {
      approvals.push(url.pathname);
      return json(APPROVED, 202);
    }
    if (url.pathname === "/api/v1/projects") {
      return json(PROJECTS);
    }
    if (url.pathname.endsWith("/changes")) {
      return json({
        apiVersion: "joinedcontext.com/v1alpha1",
        kind: "ChangeList",
        items: [PROPOSAL],
      });
    }
    if (url.pathname === "/api/v1/notifications") {
      return json({ unread: 0, items: [] });
    }
    if (url.pathname.endsWith(`/changes/${PROPOSAL.metadata.name}`)) {
      return json(PROPOSAL);
    }
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  return { approvals };
}

test.describe("the inbox", () => {
  test("an approver decides a waiting change from the inbox, with its diff, without opening another page", async ({ page }) => {
    const { approvals } = await stubApi(page);
    await page.goto("/projects/helsinki/inbox?lang=en");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const waiting = page.getByTestId("inbox-decisions").getByRole("listitem");
    await expect(waiting).toHaveCount(1);
    await waiting.getByRole("button", { name: "Show what it changes" }).click();
    await expect(waiting.getByRole("cell", { name: "internal", exact: true })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
    await waiting.getByRole("button", { name: "Approve" }).click();
    await expect(waiting.getByRole("status")).toHaveText("Approved: it is being deployed.");
    expect(approvals).toEqual(["/api/v1/projects/helsinki/changes/chg-1a2b3c4d/approve"]);
    await expect(page).toHaveURL(/\/projects\/helsinki\/inbox/);
  });
});
