import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { journeyMarkerOnPortalOnly } from "./live/portal";

// The live config marks every request as a journey (`X-JC-Run-Origin`, AG-93). A Portal page that
// reads another origin (the API host's MCP route on /connect) failed that origin's CORS preflight
// on the marker, and the walker filed a console error no person meets (T-5025).

async function listen(handle: (headers: IncomingHttpHeaders, method: string, res: import("node:http").ServerResponse) => void): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => handle(req.headers, req.method ?? "", res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("the journey marker reaches the Portal's host and no other origin", async ({ browser }) => {
  const portalSaw: (string | undefined)[] = [];
  const otherSaw: (string | undefined)[] = [];
  // Another origin that allows a cross-origin read with content-type, as api.<domain> does.
  const other = await listen((headers, method, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (method === "OPTIONS") return res.writeHead(204).end();
    otherSaw.push(headers["x-jc-run-origin"] as string | undefined);
    res.writeHead(200, { "content-type": "text/plain" }).end("read");
  });
  const portal = await listen((headers, _method, res) => {
    portalSaw.push(headers["x-jc-run-origin"] as string | undefined);
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Portal</title>");
  });
  const context = await browser.newContext({ extraHTTPHeaders: { "X-JC-Run-Origin": "journey" } });
  try {
    await journeyMarkerOnPortalOnly(context, new URL(portal.origin).host);
    const page = await context.newPage();
    await page.goto(portal.origin);
    const read = await page.evaluate(
      (url) => fetch(url, { headers: { "content-type": "text/plain" } }).then((answer) => answer.text(), (error: Error) => `blocked: ${error.message}`),
      `${other.origin}/api/mcp/helsinki/otvorene-data`,
    );
    expect(read, "the other origin's read is not blocked by the marker").toBe("read");
    expect(otherSaw).toEqual([undefined]);
    expect(portalSaw).toEqual(["journey"]);
  } finally {
    await context.close();
    portal.server.close();
    other.server.close();
  }
});

test.describe("a stranger's context under the live config's marker", () => {
  test.use({ extraHTTPHeaders: { "X-JC-Run-Origin": "journey" } });

  // The App probe's anonymous visit stands for a stranger, who sends no marker (T-5416).
  test("carries the marker by default and none when it clears the headers", async ({ browser }) => {
    const saw: (string | undefined)[] = [];
    const server = await listen((headers, _method, res) => {
      saw.push(headers["x-jc-run-origin"] as string | undefined);
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>App</title>");
    });
    try {
      for (const options of [{}, { extraHTTPHeaders: {} }]) {
        const context = await browser.newContext(options);
        await (await context.newPage()).goto(server.origin);
        await context.close();
      }
      expect(saw).toEqual(["journey", undefined]);
    } finally {
      server.server.close();
    }
  });
});
