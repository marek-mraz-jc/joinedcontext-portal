/**
 * The UI's data client is the Portal API's own contract (UI-06, UI-07).
 *
 * `ui/openapi.json` is held to the routes the Portal serves by `tests/openapi_tests.rs`
 * (`committed_openapi_spec_is_current`). This file holds the other half: the TypeScript types
 * every call is checked against are what `openapi-typescript` makes of that document, so a
 * route or a field that changed in the API cannot keep compiling in the UI against a copy that
 * did not.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ui = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The command `pnpm generate:api` runs, from package.json, so the two cannot drift apart. */
function generateCommand(): string[] {
  const scripts = (JSON.parse(readFileSync(join(ui, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }).scripts;
  return scripts["generate:api"].split(/\s+/);
}

describe("the generated API client (UI-06)", () => {
  // UI-06: the committed types are exactly what openapi-typescript generates from openapi.json.
  it("is what openapi-typescript makes of the committed OpenAPI document", () => {
    const [bin, input, flag, output] = generateCommand();
    expect([bin, flag]).toEqual(["openapi-typescript", "-o"]);
    const scratch = mkdtempSync(join(tmpdir(), "jc-schema-"));
    try {
      const fresh = join(scratch, "schema.d.ts");
      execFileSync(join(ui, "node_modules/.bin", bin), [input, flag, fresh], {
        cwd: ui,
        stdio: "pipe",
      });
      expect(
        readFileSync(join(ui, output), "utf8"),
        "src/api/schema.d.ts is stale: run `pnpm generate:api` in ui/",
      ).toBe(readFileSync(fresh, "utf8"));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  // UI-06: the client is typed by those paths, so a call to a route the document lacks fails tsc.
  it("types the client by the generated paths", () => {
    const client = readFileSync(join(ui, "src/api/client.ts"), "utf8");
    expect(client).toMatch(/import type \{[^}]*\bpaths\b[^}]*\} from "\.\/schema"/);
    expect(client).toMatch(/createClient<paths>\(/);
  });
});
