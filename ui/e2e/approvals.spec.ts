import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";

// `vite preview` serves the built bundle with no portal API behind it, so this journey answers
// the API from the browser. The clicks, the routing and the rendering are the real ones; only
// the Rust process is absent (its own journey arrives with the ci-full task that runs the binary).
// The project is `helsinki`: the root route redirects to the first project `GET /api/v1/projects`
// lists (PF-05), so a journey that starts at `/` lands there once the stub answers that list.

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
    if (url.pathname.endsWith(`/changes/${PROPOSAL.metadata.name}`)) {
      return json(PROPOSAL);
    }
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  return { approvals };
}

test.describe("approvals", () => {
  test("an approver reviews a change and approves it", async ({ page }) => {
    const { approvals } = await stubApi(page);

    await page.goto("/?lang=en");
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", {
      name: "Approvals",
    }).click();

    await expect(page).toHaveURL(/\/projects\/helsinki\/approvals$/);
    const summary = 'Update Endpoint "air-quality" (2 fields changed)';
    await expect(page.getByRole("link", { name: summary })).toBeVisible();
    // `exact`, because the lane word is also inside the glossary tooltip the badge carries
    // since T-1609 — without it the locator matches the badge and the definition (T-2409).
    await expect(page.getByText("Yellow", { exact: true })).toBeVisible();
    await expect(page.getByText("Marek Mráz")).toBeVisible();

    await page.getByRole("link", { name: summary }).click();

    await expect(page).toHaveURL(/\/approvals\/chg-1a2b3c4d$/);
    await expect(page.getByRole("heading", { name: summary })).toBeVisible();
    // The field in words with its path underneath, the value as text (T-1385).
    await expect(page.getByRole("cell", { name: "Audience spec.audience" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "internal", exact: true })).toBeVisible();
    // The token appears only as the redaction marker, never as its value.
    await expect(page.getByText("Redacted").first()).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByText("Deploying")).toBeVisible();
    expect(approvals).toEqual(["/api/v1/projects/helsinki/changes/chg-1a2b3c4d/approve"]);
  });

  test("at 400 px a long merge-request link and file path wrap inside the page (T-4976)", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 900 });
    // The walker found 101-126 px of sideways scroll on dev: Gitea's login-redirect link and a
    // policy path are each one unbroken word wider than a phone.
    const long = {
      ...PROPOSAL,
      status: {
        ...PROPOSAL.status,
        mergeRequest:
          "https://dev.joinedcontext.com/git/user/oauth2/keycloak?redirect_to=%2Fgit%2Fjoinedcontext%2Fhelsinki%2Fpulls%2F185",
      },
      files: [
        { path: "projects/helsinki/spaces/helsinki/policies/t4843-hro7z1-write.yaml", kind: "Policy", lane: "red", operation: "Create" },
        { path: "projects/helsinki/spaces/helsinki/endpoints/air-quality-measurements-v2.yaml", kind: "Endpoint", lane: "yellow", operation: "Update", fields: PROPOSAL.planFields },
      ],
    };
    await stubApi(page);
    await page.route(`**/changes/${PROPOSAL.metadata.name}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(long) }),
    );

    await page.goto(`/projects/helsinki/approvals/${PROPOSAL.metadata.name}?lang=en`);
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(page.getByTestId("change-file")).toHaveCount(2);
    const sideways = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sideways).toBe(0);
    await page.screenshot({ path: test.info().outputPath("approval-detail-400.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: test.info().outputPath("approval-detail-1440.png"), fullPage: true });
  });

  test("the approvals routes have no axe violations", async ({ page }) => {
    await stubApi(page);

    await page.goto("/projects/helsinki/approvals?lang=sk");
    await expect(page.getByRole("table")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);

    await page.goto("/projects/helsinki/approvals/chg-1a2b3c4d?lang=sk");
    await expect(page.getByRole("button", { name: "Schváliť" })).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
