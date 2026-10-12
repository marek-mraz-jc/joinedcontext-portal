import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { axeViolations } from "./axe";
import { greenVerdict, isCheck } from "./verdict";

// `vite preview` has no portal API behind it, so the API is answered in the browser and
// everything above it — routing, polling, the pause button — is the real thing.

const IDENTITY = {
  subject: "b7c1e0f4",
  username: "jana.kovacova",
  name: "Jana Kováčová",
  email: "jana.kovacova@banskabystrica.sk",
  roles: ["portal-editor"],
};

const PIPELINES = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "List",
  items: [
    {
      apiVersion: "joinedcontext.com/v1alpha1",
      kind: "Pipeline",
      metadata: {
        name: "aq-mqtt-ingest",
        namespace: "banskabystrica",
        title: { sk: "Ovzdušie MQTT", en: "Air quality MQTT" },
      },
      spec: {
        class: "resident",
        secretRefs: [{ name: "mqtt-credentials", key: "password", envVar: "MQTT_PASSWORD" }],
      },
      status: { phase: "Live" },
    },
  ],
};

const CHANGE = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "Change",
  metadata: { name: "chg-77aa11bb", namespace: "banskabystrica" },
  status: { lane: "yellow", phase: "PendingApproval", plan: { update: 1 } },
};

async function stubApi(page: Page): Promise<{ writes: string[] }> {
  const writes: string[] = [];
  let received = 128_400;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/auth/me")) {
      return json(IDENTITY);
    }
    // Pause checks the manifest it is about to write, and a check is a dry run whatever verb it
    // uses: a `PUT …?dryRun=All` is not a write (PF-57, T-2264).
    if (isCheck(request.method(), request.url())) {
      return json(greenVerdict(request.postData()));
    }
    if (request.method() !== "GET") {
      writes.push(`${request.method()} ${path} ${request.postData() ?? ""}`);
      return json(CHANGE, 202);
    }
    if (path.endsWith("/metrics")) {
      // A counter that grows between polls, the way a running stream's does.
      received += 25;
      return json({
        pipeline: "aq-mqtt-ingest",
        scrapedAt: new Date().toISOString(),
        received,
        sent: received - 3,
        errors: 3,
        bufferDepth: 340,
      });
    }
    if (path.endsWith("/pipelines")) {
      return json(PIPELINES);
    }
    if (path.endsWith("/pipelines/aq-mqtt-ingest")) {
      return json(PIPELINES.items[0]);
    }
    return json({ apiVersion: "joinedcontext.com/v1alpha1", kind: "List", items: [] });
  });
  return { writes };
}

test.describe("pipelines", () => {
  test("the resident stream's counter moves while the view is open (DEMO step 3)", async ({
    page,
  }) => {
    await stubApi(page);

    await page.goto("/projects/banskabystrica/pipelines?lang=en");
    const row = page.getByRole("row").filter({ hasText: "Air quality MQTT" });
    await expect(row.getByText("resident")).toBeVisible();
    await expect(row.getByText("128,425")).toBeVisible();
    // The next poll is five seconds out; the number has to change on its own.
    await expect(row.getByText("128,450")).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("mqtt-credentials/password → $MQTT_PASSWORD")).toBeVisible();
  });

  // The buffer depth the metrics route answers is the queue on the wire into the output, amber
  // past the limit, as NiFi shows a connection's queue (T-3973).
  test("the canvas shows the queue before the output", async ({ page }) => {
    await stubApi(page);

    await page.goto("/projects/banskabystrica/pipelines/aq-mqtt-ingest/edit?lang=en");
    const dialog = page.getByTestId("form-page");
    await dialog.getByText("More options").click();
    await dialog.getByText("Advanced editor").click();
    const queue = page.getByTestId("flow-queue");
    await expect(queue).toContainText("340 queued");
    await expect(queue).toHaveAttribute("data-high", "true");
  });

  // A pipeline moves between projects as a file: the download holds the manifest with its
  // references, a file with a secret written out is refused, and one from another project is
  // read into this one and proposed only once checked (T-3977).
  test("downloads the pipeline as YAML and reads one back from a file", async ({ page }) => {
    const { writes } = await stubApi(page);

    await page.goto("/projects/banskabystrica/pipelines/aq-mqtt-ingest/edit?lang=en");
    const dialog = page.getByTestId("form-page");
    await dialog.getByRole("tab", { name: "YAML" }).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      dialog.getByTestId("yaml-download").click(),
    ]);
    expect(download.suggestedFilename()).toBe("aq-mqtt-ingest.yaml");
    const saved = readFileSync(await download.path(), "utf8");
    expect(saved).toContain("name: aq-mqtt-ingest");
    expect(saved).toContain("name: mqtt-credentials");
    expect(saved).not.toMatch(/^\s*password:/m);

    const upload = dialog.getByLabel("Upload YAML");
    await upload.setInputFiles({
      name: "leak.yaml",
      mimeType: "application/yaml",
      buffer: Buffer.from(saved.replace("spec:\n", "spec:\n  token: s3cr3t\n")),
    });
    await expect(dialog.getByRole("alert").filter({ hasText: "secret written out" })).toContainText("(token)");

    await upload.setInputFiles({
      name: "moved.yaml",
      mimeType: "application/yaml",
      // The stub's pipeline names no target yet; the file gives it one, as a full pipeline does.
      buffer: Buffer.from(
        saved
          .replace("namespace: banskabystrica", "namespace: zvolen")
          .replace("spec:\n", "spec:\n  targetEndpoint: urn:ngsi-ld:Endpoint:banskabystrica.sk:ovzdusie:air\n"),
      ),
    });
    await expect(dialog.getByTestId("yaml-upload-note")).toContainText("project zvolen");
    await dialog.getByRole("button", { name: "Check", exact: true }).click();
    await dialog.getByRole("button", { name: "Propose change" }).click();
    await expect(page.getByText("chg-77aa11bb")).toBeVisible();
    const proposed = writes.find((write) => write.includes("/pipelines/aq-mqtt-ingest"));
    expect(proposed, writes.join("\n")).toContain('"namespace":"banskabystrica"');
    expect(writes.join("\n")).not.toContain("zvolen");
  });

  test("pausing a pipeline proposes a change", async ({ page }) => {
    const { writes } = await stubApi(page);

    await page.goto("/projects/banskabystrica/pipelines?lang=en");
    await page.getByRole("button", { name: "Pause" }).click();

    await expect(page.getByText("chg-77aa11bb")).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("PUT /api/v1/projects/banskabystrica/pipelines/aq-mqtt-ingest");
    expect(writes[0]).toContain('"enabled":false');
  });

  test("the pipelines route has no axe violations", async ({ page }) => {
    await stubApi(page);

    await page.goto("/projects/banskabystrica/pipelines?lang=sk");
    await expect(page.getByRole("table")).toBeVisible();
    expect(await axeViolations(page)).toEqual([]);
  });
});
