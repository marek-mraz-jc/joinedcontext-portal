// node --test scripts/apps-ci.test.mjs (T-3373): which Apps a change makes the fast lane run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "apps-ci.sh");

/** A repository with two Apps and the SDK, one commit, then `files` changed in a second. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "apps-ci-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "ci@example.org");
  git("config", "user.name", "ci");
  for (const path of ["apps/a/src/x.ts", "apps/ab/src/x.ts", "sdk/src/y.ts", "README.md"]) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), "1\n");
  }
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts/apps-ci.sh"), execFileSync("cat", [SCRIPT]));
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  for (const path of files) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), "2\n");
  }
  git("add", "-A");
  git("commit", "-qm", "change", "--allow-empty");
  return { dir, base };
}

const touched = ({ dir, base }, path, env = {}) =>
  spawnSync("sh", ["scripts/apps-ci.sh", "touched", path], { cwd: dir, env: { ...process.env, APPS_BASE: base, APPS_ALL: "", ...env } }).status === 0;

test("a change inside one App runs that App alone, not one whose name starts the same", () => {
  const change = repo(["apps/a/src/x.ts"]);
  assert.equal(touched(change, "apps/a/"), true);
  assert.equal(touched(change, "apps/ab/"), false);
  assert.equal(touched(change, "sdk/examples/react-rust-wasm"), false);
});

test("a change to the SDK, the builder or the gate runs every App", () => {
  for (const path of ["sdk/src/y.ts", "builder/build-wasm.sh", "scripts/app-coverage-run.sh", "apps/coverage-thresholds.json", ".github/workflows/ci.yml"]) {
    assert.equal(touched(repo([path]), "apps/ab/"), true, path);
  }
});

test("a change elsewhere runs no App, and APPS_ALL or an unknown base runs them all", () => {
  const change = repo(["README.md"]);
  assert.equal(touched(change, "apps/a/"), false);
  assert.equal(touched(change, "apps/a/", { APPS_ALL: "1" }), true);
  assert.equal(touched({ ...change, base: "0000000000000000000000000000000000000000" }, "apps/a/"), true);
});
