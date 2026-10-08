// node --test scripts/bundle-budget.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { entryScripts, weightKb } from "./bundle-budget.mjs";

test("the entry and its preloads are what every page loads, a lazy chunk is not", () => {
  const html = `<script type="module" crossorigin src="/assets/index-abc.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-def.js">
<link rel="stylesheet" href="/assets/index.css">`;
  assert.deepEqual(entryScripts(html), ["assets/index-abc.js", "assets/vendor-def.js"]);
});

test("the weight is gzipped kilobytes", () => {
  assert.equal(weightKb(Buffer.alloc(0)), 0);
  assert.ok(weightKb(Buffer.from("a".repeat(200_000))) < 5, "a repeated byte compresses away");
});
