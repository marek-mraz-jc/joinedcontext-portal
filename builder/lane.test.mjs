// node --test builder/lane.test.mjs (vite from sdk/node_modules for the bundle test)
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundleFunctions, functionEntries, refusedDependencies } from "./lane.mjs";

const template = { dependencies: { react: "^19", "@joinedcontext/sdk": "0.1.0" }, devDependencies: { vite: "^8" } };

test("the template's own packages pass, with any version asked for", () => {
  assert.deepEqual(refusedDependencies({ dependencies: { react: "18" }, devDependencies: { vite: "*" } }, template), []);
  assert.deepEqual(refusedDependencies({}, template), []);
});

test("a package the template does not install is refused by name", () => {
  assert.deepEqual(
    refusedDependencies({ dependencies: { react: "^19", "left-pad": "1" }, devDependencies: { "evil-postinstall": "1" } }, template),
    ["evil-postinstall", "left-pad"],
  );
});

function app(files) {
  const dir = mkdtempSync(join(tmpdir(), "lane-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("functions are the .ts files of functions/, tests and other files left out", () => {
  const dir = app({ "functions/summary.ts": "", "functions/bike-stats.ts": "", "functions/summary.test.ts": "", "functions/notes.md": "" });
  assert.deepEqual(functionEntries(join(dir, "functions")), ["bike-stats", "summary"]);
  assert.deepEqual(functionEntries(join(dir, "nothing-here")), []);
});

test("a function name the route cannot carry fails the build", () => {
  const dir = app({ "functions/Summary.ts": "" });
  assert.throws(() => functionEntries(join(dir, "functions")), /function name/);
});

test("the bundle exports each function by name and leaves the SDK server to the runtime", async () => {
  const dir = app({
    "functions/summary.ts": 'import { json } from "@joinedcontext/sdk/server";\nconst f = (r: unknown) => json({ ok: r !== null });\nexport default f;\n',
    "functions/bike-stats.ts": "export default (): number => 2;\n",
    "functions/summary.test.ts": "throw new Error('a test is never bundled');\n",
  });
  const out = join(dir, "dist");
  assert.equal(await bundleFunctions(dir, out), true);
  const bundle = readFileSync(join(out, "functions.js"), "utf8");
  assert.match(bundle, /from "@joinedcontext\/sdk\/server"/);
  assert.match(bundle, /as "bike-stats"/);
  assert.match(bundle, /as summary|summary as|summary\b.*export|export \{[^}]*summary/s);
  assert.doesNotMatch(bundle, /never bundled/);
});

test("an app with no functions gets no bundle", async () => {
  const dir = app({ "index.html": "<p>hi</p>" });
  assert.equal(await bundleFunctions(dir, join(dir, "dist")), false);
});
