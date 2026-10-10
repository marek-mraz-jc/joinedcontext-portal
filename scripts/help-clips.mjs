// The help panel's clips (T-3308): each main page's live journey records its main action
// (`helpClipStart` in ui/e2e/live/guide.ts, with HELP_CLIPS=1), and this script turns the
// recordings into ui/public/help/{key}.webm of 10-20 s, then holds them to the repository's budget.
//
//   node scripts/help-clips.mjs publish <ui/test-results/help> [ui/public/help]
//     fails before converting anything when a journey's recording is missing; needs ffmpeg on PATH
//   node scripts/help-clips.mjs check [ui/public/help]
//     the CI budget: 1 MB per clip, 12 MB in all, a WebM named after a page that has a journey
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The pages whose live journeys record a clip; each one's recording must be there to publish. */
export const JOURNEY_CLIPS = [
  "spaces",
  "approvals",
  "models",
  "datasources",
  "pipelines",
  "endpoints",
  "policies",
  "ckan",
  "dashboards",
  "apps",
];

export const MAX_CLIP_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const MIN_SECONDS = 10;
export const MAX_SECONDS = 20;
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * The part of a recording a clip keeps, in seconds: the marked action, run on to 10 s when it was
 * shorter (into its result, never back into the sign-in before it) and cut to its last 20 s when
 * longer, so the clip ends on what the action did.
 */
export function clipWindow(startMs, endMs) {
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs > startMs)) {
    throw new Error(`a clip needs 0 <= start < end, got ${startMs}..${endMs} ms`);
  }
  const span = (endMs - startMs) / 1000;
  const length = Math.min(Math.max(span, MIN_SECONDS), MAX_SECONDS);
  const start = span > MAX_SECONDS ? endMs / 1000 - MAX_SECONDS : startMs / 1000;
  return { start: Number(start.toFixed(3)), length: Number(length.toFixed(3)) };
}

/** The journeys among `required` that left no mark in `results`. */
export function missingClips(results, required = JOURNEY_CLIPS) {
  return required.filter((key) => !existsSync(join(results, `${key}.json`)));
}

/** ffmpeg's arguments for one clip: no sound, VP9 at a quality that keeps 20 s under 1 MB. */
export function ffmpegArgs(video, { start, length }, out) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", video, "-t", String(length),
    "-an", "-vf", "scale=1280:-2,fps=15", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "45", "-row-mt", "1", out];
}

/** What is wrong with the clips in `dir`, as lines; none when there is no `dir` yet. */
export function budgetProblems(dir, known = JOURNEY_CLIPS) {
  if (!existsSync(dir)) return [];
  const problems = [];
  let total = 0;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const key = name.replace(/\.webm$/, "");
    if (!name.endsWith(".webm") || !known.includes(key)) {
      problems.push(`${path}: not a clip of a page with a journey (${known.join(", ")})`);
      continue;
    }
    const size = statSync(path).size;
    total += size;
    if (size > MAX_CLIP_BYTES) problems.push(`${path}: ${size} bytes, over ${MAX_CLIP_BYTES}`);
    if (!readFileSync(path).subarray(0, 4).equals(WEBM_MAGIC)) problems.push(`${path}: not a WebM file`);
  }
  if (total > MAX_TOTAL_BYTES) problems.push(`${dir}: ${total} bytes in all, over ${MAX_TOTAL_BYTES}`);
  return problems;
}

function publish(results, out) {
  const missing = missingClips(results);
  if (missing.length) {
    console.error(`no recording for ${missing.join(", ")} in ${results}: run those journeys with HELP_CLIPS=1`);
    return 1;
  }
  mkdirSync(out, { recursive: true });
  for (const key of JOURNEY_CLIPS) {
    const mark = JSON.parse(readFileSync(join(results, `${key}.json`), "utf8"));
    if (!existsSync(mark.video)) {
      console.error(`${key}: the recording ${mark.video} is gone; close the journey's context before publishing`);
      return 1;
    }
    const run = spawnSync("ffmpeg", ffmpegArgs(mark.video, clipWindow(mark.start, mark.end), join(out, `${key}.webm`)), { stdio: "inherit" });
    if (run.error || run.status !== 0) {
      console.error(`${key}: ffmpeg failed${run.error ? ` (${run.error.message}; is ffmpeg on PATH?)` : ""}`);
      return 1;
    }
  }
  return check(out);
}

function check(dir) {
  const problems = budgetProblems(dir);
  for (const problem of problems) console.error(problem);
  const count = existsSync(dir) ? readdirSync(dir).length : 0;
  console.log(`help clips: ${count} in ${dir}, ${problems.length} problems`);
  return problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [verb, first, second] = process.argv.slice(2);
  if (verb === "publish" && first) process.exit(publish(first, second ?? "ui/public/help"));
  else if (verb === "check") process.exit(check(first ?? "ui/public/help"));
  console.error("usage: node scripts/help-clips.mjs publish <results> [out] | check [dir]");
  process.exit(2);
}
