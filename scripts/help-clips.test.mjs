import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JOURNEY_CLIPS, MAX_CLIP_BYTES, budgetProblems, clipWindow, ffmpegArgs, missingClips } from "./help-clips.mjs";

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]);
const dir = () => mkdtempSync(join(tmpdir(), "help-clips-"));

test("a clip keeps 10 to 20 s of the marked action and ends on its result", () => {
  assert.deepEqual(clipWindow(4000, 19000), { start: 4, length: 15 });
  assert.deepEqual(clipWindow(30000, 33000), { start: 30, length: 10 }, "short: runs on, never back into the sign-in");
  assert.deepEqual(clipWindow(2000, 60000), { start: 40, length: 20 }, "long: its last 20 s");
  assert.throws(() => clipWindow(5000, 5000), /start < end/);
  assert.throws(() => clipWindow(-1, 5000), /start < end/);
  assert.throws(() => clipWindow(undefined, 5000), /start < end/);
});

test("a journey without its recording is named before anything is converted", () => {
  const results = dir();
  writeFileSync(join(results, "spaces.json"), "{}");
  assert.deepEqual(missingClips(results, ["spaces", "models"]), ["models"]);
  const run = spawnSync(process.execPath, ["scripts/help-clips.mjs", "publish", results, join(results, "out")], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, new RegExp(`no recording for ${JOURNEY_CLIPS.filter((k) => k !== "spaces").join(", ")}`));
});

test("ffmpeg gets its arguments as a list, without sound", () => {
  const args = ffmpegArgs("a b;rm.webm", { start: 2, length: 10 }, "out/spaces.webm");
  assert.equal(args[args.indexOf("-i") + 1], "a b;rm.webm");
  assert.ok(args.includes("-an"));
  assert.equal(args.at(-1), "out/spaces.webm");
});

test("the budget: no directory is fine, and size, name and format are held", () => {
  assert.deepEqual(budgetProblems(join(dir(), "absent")), []);
  const clips = dir();
  writeFileSync(join(clips, "spaces.webm"), WEBM);
  assert.deepEqual(budgetProblems(clips), []);
  writeFileSync(join(clips, "models.webm"), Buffer.concat([WEBM, Buffer.alloc(MAX_CLIP_BYTES)]));
  writeFileSync(join(clips, "apps.webm"), Buffer.from("<html>"));
  writeFileSync(join(clips, "nowhere.webm"), WEBM);
  writeFileSync(join(clips, "spaces.mp4"), WEBM);
  const said = budgetProblems(clips).join("\n");
  assert.match(said, /models\.webm: \d+ bytes, over/);
  assert.match(said, /apps\.webm: not a WebM/);
  assert.match(said, /nowhere\.webm: not a clip of a page/);
  assert.match(said, /spaces\.mp4: not a clip of a page/);
});

test("the budget fails above 12 MB in all", () => {
  const clips = dir();
  for (const key of JOURNEY_CLIPS) writeFileSync(join(clips, `${key}.webm`), Buffer.concat([WEBM, Buffer.alloc(MAX_CLIP_BYTES - 10)]));
  assert.deepEqual(budgetProblems(clips), [], "every journey's clip at nearly 1 MB fits");
  const big = dir();
  const keys = Array.from({ length: 13 }, (_, i) => `k${i}`);
  for (const key of keys) writeFileSync(join(big, `${key}.webm`), Buffer.concat([WEBM, Buffer.alloc(MAX_CLIP_BYTES - 10)]));
  assert.match(budgetProblems(big, keys).join("\n"), /in all, over 12582912/);
});
