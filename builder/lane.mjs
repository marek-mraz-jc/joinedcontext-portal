// The build lane's checks, its functions bundle, its SBOM and its proposal (AP-80, AP-82, AP-84,
// AP-101, ADR-N-028).
//
//   node lane.mjs deps <app-dir>       refuses a package the template does not install (SDK-12)
//   node lane.mjs vitest-config <app-dir>  writes the config the tests run with, the app's own plus the SDK inlined
//   node lane.mjs functions <app-dir> <out-dir>
//                                      bundles functions/*.ts into <out-dir>/functions.js
//   node lane.mjs app <owner/repo>     prints "{project} {app}" of an application repository
//   node lane.mjs sbom <node_modules> <out-file>
//                                      the CycloneDX SBOM of the packages the build linked
//   node lane.mjs image <layer.tar> <dir>
//                                      writes a fullstack App's OCI image layout from its one
//                                      layer and prints the manifest digest (AP-105)
//   node lane.mjs upload <build-dir>   uploads bundle-{commit} and sbom-{commit} as the run's
//                                      artifacts and writes the build to $GITHUB_OUTPUT
//   node lane.mjs seed <from> <to>     starts a fullstack build's target/ from the image's
//                                      precompiled dependencies (AP-106), never failing a build
//   node lane.mjs propose <owner/repo> proposes status.build as the lane, from the build job's
//                                      outputs (JC_DIGEST, JC_COMMIT, JC_SDK_VERSION, JC_BUILT_AT)
//                                      to JC_PORTAL_URL with JC_LANE_TOKEN
//   node lane.mjs test-project <project.json.gz> <work-dir>
//                                      a run's sandbox (SDK-38): writes the version's files, links
//                                      the template, runs vitest as the lane does and prints one
//                                      line `JC-TESTS {json}` the Portal reads from the pod's log
//
// Lives beside /opt/template/node_modules in the image, so `vite` resolves to the template's.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const TEMPLATE = new URL("./package.json", import.meta.url);
// The name a function is called by, the same rule the Portal applies to a run's functions.
const FUNCTION = /^[a-z][a-z0-9-]{0,39}$/;

// A project and an application name as the forge repository `{project}_{app}` carries them (AP-75).
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const names = (pkg) =>
  Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });

/** Every package the app asks for that the template does not install. */
export function refusedDependencies(app, template) {
  const allowed = new Set(names(template));
  return names(app).filter((name) => !allowed.has(name)).sort();
}

/** The lane's vitest config, beside the app's so its root is the app (T-2649). */
export const VITEST_CONFIG = ".jc-vitest.config.mjs";

/**
 * Writes the config the lane runs an app's tests with: the app's own `vite.config`, if it has
 * one, with the packed SDK inlined. The app's packages are links into the template's store
 * outside the app, so vitest externalises the SDK and Node would import the stylesheet the SDK
 * imports, which it cannot (SDK-24, AP-82). The template's config says the same; this holds it
 * for an app whose config does not.
 */
export function vitestConfig(appDir) {
  const own = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"].find((name) =>
    existsSync(join(appDir, name)),
  );
  const lines = [
    "// Written by the build lane (T-2649), removed before the next build.",
    'import { mergeConfig } from "vitest/config";',
    ...(own ? [`import app from "./${own}";`] : []),
    'const lane = { test: { server: { deps: { inline: ["@joinedcontext/sdk"] } } } };',
    own
      ? "export default typeof app === \"function\" ? async (env) => mergeConfig(await app(env), lane) : mergeConfig(app, lane);"
      : "export default lane;",
  ];
  const path = join(appDir, VITEST_CONFIG);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

/** A path of a run's project: relative, plain segments, never `node_modules` (SDK-11, SDK-38). */
const PROJECT_PATH = /^[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*(\/[A-Za-z0-9_@+-][A-Za-z0-9_.@+-]*)*$/;

/**
 * Writes a run's version into `dir` (SDK-38). The files are untrusted: a path that is absolute,
 * climbs out with `..`, hides in a dot folder or names `node_modules` is refused before anything
 * is written, so the sandbox links nothing the model chose.
 */
export function writeProject(files, dir) {
  if (files === null || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("the project is not an object of paths to file contents");
  }
  const entries = Object.entries(files);
  for (const [path, content] of entries) {
    if (!PROJECT_PATH.test(path) || path.split("/")[0] === "node_modules") {
      throw new Error(`${JSON.stringify(path)} is not a path a project may hold`);
    }
    if (typeof content !== "string") throw new Error(`${path} is not text`);
  }
  for (const [path, content] of entries) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/**
 * The template's installed packages linked into `dir/node_modules`, as `build-app` links them: a
 * writable folder of links, since Vite writes its cache there (AP-82).
 */
export function linkTemplate(dir, store = join(dirname(new URL(import.meta.url).pathname), "node_modules")) {
  const modules = join(dir, "node_modules");
  rmSync(modules, { recursive: true, force: true });
  mkdirSync(modules);
  for (const entry of readdirSync(store)) {
    symlinkSync(join(store, entry), join(modules, entry));
  }
}

const MAX_FAILURES = 20;
const MAX_MESSAGE = 2000;
const ANSI = /\u001b\[[0-9;]*m/g;
const cut = (text, limit) => {
  const plain = String(text ?? "").replace(ANSI, "").trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
};

/**
 * What vitest's JSON report says, as the Portal reads it (SDK-38, API/04 §4): the counts, and up
 * to 20 failures with the file relative to the project, the test's full name and its message cut
 * at 2,000 characters. A file that fails before any test runs (a syntax error, an import the SDK
 * does not have) is a failure of its own.
 */
export function testSummary(report, appDir) {
  const failures = [];
  let passed = 0;
  let failed = 0;
  for (const file of report?.testResults ?? []) {
    const name = typeof file.name === "string" ? relative(appDir, file.name) : "";
    const tests = file.assertionResults ?? [];
    for (const one of tests) {
      if (one.status === "passed") passed += 1;
      if (one.status !== "failed") continue;
      failed += 1;
      failures.push({ file: name, name: cut(one.fullName ?? one.title, 300), message: cut((one.failureMessages ?? []).join("\n"), MAX_MESSAGE) });
    }
    if (file.status === "failed" && !tests.some((one) => one.status === "failed")) {
      failed += 1;
      failures.push({ file: name, name: "(the file did not load)", message: cut(file.message, MAX_MESSAGE) });
    }
  }
  return {
    outcome: failed > 0 ? "failed" : "passed",
    passed,
    failed,
    failures: failures.slice(0, MAX_FAILURES),
  };
}

/**
 * One run of a version's tests in the sandbox (SDK-38): the project from the Portal's gzipped
 * JSON, the template linked, the lane's vitest config, one `vitest run` with a JSON report. The
 * answer is the summary, or `{outcome: "error", reason}` when the tests could not run at all.
 */
export function testProject(input, work, { store, timeoutMs = 100_000 } = {}) {
  const started = Date.now();
  let files;
  try {
    files = JSON.parse(gunzipSync(readFileSync(input)).toString("utf8"));
  } catch (err) {
    return { outcome: "error", reason: `the project could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    writeProject(files, work);
  } catch (err) {
    return { outcome: "error", reason: err instanceof Error ? err.message : String(err) };
  }
  const packageJson = join(work, "package.json");
  if (existsSync(packageJson)) {
    const refused = refusedDependencies(JSON.parse(readFileSync(packageJson, "utf8")), JSON.parse(readFileSync(TEMPLATE, "utf8")));
    if (refused.length > 0) return { outcome: "error", reason: `the SDK template installs no ${refused.join(", ")} (SDK-12)` };
  }
  linkTemplate(work, store);
  const config = vitestConfig(work);
  const report = join(work, ".jc-tests.json");
  const run = spawnSync(join(work, "node_modules", ".bin", "vitest"), ["run", "--config", config, "--reporter=json", `--outputFile=${report}`, "--passWithNoTests"], {
    cwd: work,
    // Nothing of the pod's environment reaches the model's code beyond what node needs.
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: work, CI: "true", NODE_ENV: "test" },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  if (run.error?.code === "ETIMEDOUT" || run.signal) {
    return { outcome: "error", reason: `the tests did not finish within ${Math.round(timeoutMs / 1000)} s`, durationMs };
  }
  if (!existsSync(report)) {
    return { outcome: "error", reason: `vitest wrote no report: ${cut(run.stderr || run.stdout, MAX_MESSAGE)}`, durationMs };
  }
  try {
    return { ...testSummary(JSON.parse(readFileSync(report, "utf8")), work), durationMs };
  } catch (err) {
    return { outcome: "error", reason: `the report could not be read: ${err instanceof Error ? err.message : String(err)}`, durationMs };
  }
}

/** The functions of `functions/`, by name; a test file is not a function. */
export function functionEntries(dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith(".ts") || file.name.endsWith(".test.ts")) continue;
    const name = file.name.slice(0, -".ts".length);
    if (!FUNCTION.test(name)) {
      throw new Error(
        `functions/${file.name}: a function name is lowercase letters, digits and '-', at most 40, starting with a letter`,
      );
    }
    entries.push(name);
  }
  return entries.sort();
}

/** One ES module exporting every function under its name, `@joinedcontext/sdk/server` left to the runtime. */
export async function bundleFunctions(appDir, outDir) {
  const dir = join(appDir, "functions");
  const entries = functionEntries(dir);
  if (entries.length === 0) return false;
  const entry = join(appDir, ".jc-functions-entry.ts");
  writeFileSync(
    entry,
    entries
      .map((name) => `export { default as ${JSON.stringify(name)} } from ${JSON.stringify(join(dir, `${name}.ts`))};`)
      .join("\n") + "\n",
  );
  const { build } = await import("vite");
  await build({
    configFile: false,
    logLevel: "warn",
    root: appDir,
    build: {
      outDir: resolve(outDir),
      emptyOutDir: false,
      minify: false,
      target: "es2022",
      lib: { entry, formats: ["es"], fileName: () => "functions.js" },
      rollupOptions: { external: ["@joinedcontext/sdk/server"] },
    },
  });
  return true;
}

/** The project and the application a repository `owner/{project}_{app}` belongs to (AP-75). */
export function appOf(repository) {
  const name = String(repository).split("/").pop() ?? "";
  const cut = name.indexOf("_");
  const project = name.slice(0, cut);
  const app = name.slice(cut + 1);
  if (cut < 1 || !LABEL.test(project) || !LABEL.test(app)) {
    throw new Error(`${name}: an application repository is named {project}_{app}`);
  }
  return { project, app };
}

/** One package of pnpm's store folder, `@scope+name@1.2.3_peer…` → `@scope/name`, `1.2.3`. */
function storePackage(folder) {
  const plain = folder.split("_")[0];
  const at = plain.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: plain.slice(0, at).replace("+", "/"), version: plain.slice(at + 1) };
}

/** The CycloneDX 1.5 SBOM of the packages in pnpm's store folders, sorted, without a timestamp. */
export function sbomOf(folders) {
  const seen = new Map();
  for (const folder of folders) {
    const pkg = storePackage(folder);
    if (pkg && pkg.version) seen.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  const components = [...seen.keys()].sort().map((key) => {
    const { name, version } = seen.get(key);
    return { type: "library", name, version, purl: `pkg:npm/${name.replace("@", "%40")}@${version}` };
  });
  return { bomFormat: "CycloneDX", specVersion: "1.5", version: 1, components };
}

/** The crates a `Cargo.lock` names from a registry, as SBOM components; path crates are the app. */
export function cratesOf(lock) {
  const crates = [];
  for (const block of String(lock).split(/^\[\[package\]\]$/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"$`, "m").exec(block)?.[1];
    const [name, version, source] = [field("name"), field("version"), field("source")];
    if (name && version && source?.startsWith("registry+")) {
      crates.push({ type: "library", name, version, purl: `pkg:cargo/${name}@${version}` });
    }
  }
  return crates.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * A fullstack App's image from its one layer (`/app`, a tar): the gzip layer, a config that runs
 * `/app` as uid 65532, and the OCI manifest, as the blobs of an OCI image layout. No time and no
 * host goes into any of them, so the same layer is the same digest (AP-105).
 */
export function ociImage(layerTar) {
  const layer = gzipSync(layerTar, { level: 9 });
  const config = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { Entrypoint: ["/app"], User: "65532:65532", WorkingDir: "/" },
      rootfs: { type: "layers", diff_ids: [sha256(layerTar)] },
    }),
  );
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: sha256(config), size: config.length },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: sha256(layer), size: layer.length }],
    }),
  );
  const digest = sha256(manifest);
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: manifest.length }],
    }),
  );
  return { digest, index, blobs: [config, layer, manifest] };
}

/** Writes `image` as an OCI image layout under `dir`: `oci-layout`, `index.json`, `blobs/sha256/*`. */
export function writeLayout(image, dir) {
  mkdirSync(join(dir, "blobs", "sha256"), { recursive: true });
  writeFileSync(join(dir, "oci-layout"), '{"imageLayoutVersion":"1.0.0"}');
  writeFileSync(join(dir, "index.json"), image.index);
  for (const blob of image.blobs) {
    writeFileSync(join(dir, "blobs", "sha256", sha256(blob).slice("sha256:".length)), blob);
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** The App as read, with `status` replaced by the build and nothing else: the lane writes one field (AP-73). */
export function withBuild(app, build) {
  if (!DIGEST.test(build?.digest ?? "") || !COMMIT.test(build?.commit ?? "")) {
    throw new Error("build.json holds no sha256 digest and full commit");
  }
  if (app?.kind !== "App" || !app.metadata || !app.spec) {
    throw new Error("the Portal did not answer with an App");
  }
  const { apiVersion, kind, metadata, spec } = app;
  return { apiVersion, kind, metadata, spec, status: { build } };
}

/** The run and job a runtime token was issued for (`scp: Actions.Results:{run}:{job}`). */
export function artifactScope(runtimeToken) {
  let claims = {};
  try {
    claims = JSON.parse(Buffer.from(String(runtimeToken).split(".")[1] ?? "", "base64url").toString());
  } catch {
    // A token that is not a JWT has no scope, which the check below says.
  }
  const scope = /(?:^| )Actions\.Results:([^: ]+):([^: ]+)/.exec(String(claims.scp ?? ""));
  if (!scope) throw new Error("ACTIONS_RUNTIME_TOKEN names no run to upload to");
  return { workflowRunBackendId: scope[1], workflowJobRunBackendId: scope[2] };
}

/**
 * Uploads `bytes` as the run's artifact `name` through the forge's artifact API (v4): create,
 * append, finalize. The upload address the forge signs carries its public ROOT_URL, which the
 * runner cannot reach, so it is sent to the origin of `ACTIONS_RESULTS_URL` with the signed query
 * kept as it is. The path starts at `/twirp/`: a ROOT_URL with a path (`https://host/git/`) signs
 * `/git/twirp/…`, which only the public proxy strips, and the forge itself answers 404 (T-2633).
 */
export async function uploadArtifact(resultsUrl, runtimeToken, name, bytes, fetchImpl = fetch) {
  const base = new URL(resultsUrl);
  const ids = artifactScope(runtimeToken);
  const service = new URL("twirp/github.actions.results.api.v1.ArtifactService/", `${base.origin}${base.pathname.replace(/\/*$/, "/")}`);
  const call = async (method, body) => {
    const response = await fetchImpl(new URL(method, service), {
      method: "POST",
      headers: { Authorization: `Bearer ${runtimeToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`the forge refused ${method} of ${name}: ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text || "{}");
  };
  const created = await call("CreateArtifact", { ...ids, name, version: 4 });
  if (!created.signedUploadUrl) throw new Error(`the forge gave no upload address for ${name}`);
  const signed = new URL(created.signedUploadUrl);
  const path = signed.pathname.slice(Math.max(0, signed.pathname.indexOf("/twirp/")));
  const upload = new URL(`${path}${signed.search}`, base.origin);
  upload.searchParams.set("comp", "block");
  const put = await fetchImpl(upload, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
  if (!put.ok) throw new Error(`the forge refused the upload of ${name}: ${put.status}`);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await call("FinalizeArtifact", { ...ids, name, size: String(bytes.length), hash });
  return hash;
}

/** The build job's outputs, one `key=value` line each, the four fields checked first. */
export function outputsOf(build) {
  const { digest, commit, sdkVersion, builtAt } = build ?? {};
  if (!DIGEST.test(digest ?? "") || !COMMIT.test(commit ?? "")) {
    throw new Error("build.json holds no sha256 digest and full commit");
  }
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(sdkVersion ?? "") || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(builtAt ?? "")) {
    throw new Error("build.json holds no SDK version and UTC build time");
  }
  return `digest=${digest}\ncommit=${commit}\nsdk-version=${sdkVersion}\nbuilt-at=${builtAt}\n`;
}

/**
 * Reads the App, checks it back with `status.build`, then proposes it; the Change the Portal
 * answers. The REST door takes a proposal only after a green check of the same manifest
 * (PF-57), so the check is a call of its own, not a formality (T-2636).
 */
/**
 * A write the Portal answers 409 met a main that moved past the Portal's copy of the App, as when
 * the forge bootstrap pins a new commit while the build runs (T-2674): the App is read again and
 * the build proposed on it, at most this often, this far apart.
 */
const ATTEMPTS = 5;
const APART_MS = 10_000;

export async function propose(api, token, repository, build, fetchImpl = fetch, wait = (ms) => new Promise((done) => setTimeout(done, ms))) {
  const { project, app } = appOf(repository);
  const url = `${api.replace(/\/+$/, "")}/api/v1/projects/${project}/apps/${app}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const refused = async (what, response) => {
    let detail = "";
    try {
      detail = (await response.json())?.detail ?? "";
    } catch {
      // A body that is not a problem document says nothing more than its status.
    }
    return new Error(`${what} ${project}/${app}: the Portal answered ${response.status} ${detail}`.trim());
  };
  for (let attempt = 1; ; attempt += 1) {
    const read = await fetchImpl(url, { headers });
    if (!read.ok) throw await refused("cannot read the App", read);
    const body = withBuild(await read.json(), build);
    const checked = await fetchImpl(`${url}?dryRun=All`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!checked.ok) throw await refused("status.build was refused for", checked);
    const verdict = (await checked.json())?.verdict;
    if (verdict?.ok !== true) {
      const findings = (verdict?.findings ?? []).map((f) => f?.message ?? f?.code ?? "").filter(Boolean).join("; ");
      throw new Error(`the check of status.build for ${project}/${app} is not green${findings ? `: ${findings}` : ""}`);
    }
    const written = await fetchImpl(url, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (written.status === 409 && attempt < ATTEMPTS) {
      await wait(APART_MS);
      continue;
    }
    if (!written.ok) throw await refused("status.build was refused for", written);
    return written.json();
  }
}

/**
 * A job's `target/` started from the dependencies this release precompiled, in CI, from its
 * reference apps' lockfiles (AP-106, T-2794), so a fullstack build compiles its own crate and the
 * dependencies its lock does not share with them rather than every crate. A copy with its times
 * kept, never a link: nothing a build writes reaches the image or the next job, and the work
 * directory is still wiped after every job (AP-81). A seed that is missing, or that fails to copy
 * part way, leaves an empty `to` and a clean build: it never fails one. Returns what it did.
 */
export function seed(from, to) {
  rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) {
    mkdirSync(to, { recursive: true });
    return "no precompiled dependencies in this image: every crate is compiled";
  }
  try {
    cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    return `the precompiled dependencies of ${from} are the start of this build`;
  } catch (err) {
    rmSync(to, { recursive: true, force: true });
    mkdirSync(to, { recursive: true });
    return `the precompiled dependencies could not be copied (${err instanceof Error ? err.message : String(err)}): every crate is compiled`;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, appDir, outDir] = process.argv.slice(2);
  try {
    if (command === "deps" && appDir) {
      const read = (path) => JSON.parse(readFileSync(path, "utf8"));
      const refused = refusedDependencies(read(join(appDir, "package.json")), read(TEMPLATE));
      if (refused.length > 0) {
        throw new Error(`the SDK template installs no ${refused.join(", ")} (SDK-12)`);
      }
    } else if (command === "vitest-config" && appDir) {
      console.log(vitestConfig(resolve(appDir)));
    } else if (command === "functions" && appDir && outDir) {
      await bundleFunctions(resolve(appDir), outDir);
    } else if (command === "app" && appDir) {
      const { project, app } = appOf(appDir);
      console.log(`${project} ${app}`);
    } else if (command === "sbom" && appDir && outDir) {
      const store = join(appDir, ".pnpm");
      const folders = existsSync(store) ? readdirSync(store) : [];
      const sbom = sbomOf(folders);
      // A fullstack App: the crates its lock names are in the image too.
      const lock = process.argv[5];
      if (lock) sbom.components.push(...cratesOf(readFileSync(lock, "utf8")));
      writeFileSync(outDir, JSON.stringify(sbom, null, 2) + "\n");
    } else if (command === "image" && appDir && outDir) {
      const image = ociImage(readFileSync(appDir));
      writeLayout(image, outDir);
      console.log(image.digest);
    } else if (command === "upload" && appDir) {
      const env = process.env;
      if (!env.ACTIONS_RESULTS_URL || !env.ACTIONS_RUNTIME_TOKEN || !env.GITHUB_OUTPUT) {
        throw new Error("upload runs in a workflow job: ACTIONS_RESULTS_URL, ACTIONS_RUNTIME_TOKEN and GITHUB_OUTPUT are not set");
      }
      const build = JSON.parse(readFileSync(join(appDir, "build.json"), "utf8"));
      const outputs = outputsOf(build);
      // A fullstack build leaves its image layout as image.tar; its digest is the manifest's,
      // which the Portal checks inside the layout (AP-105, AP-107).
      if (existsSync(join(appDir, "image.tar"))) {
        await uploadArtifact(env.ACTIONS_RESULTS_URL, env.ACTIONS_RUNTIME_TOKEN, `image-${build.commit}`, readFileSync(join(appDir, "image.tar")));
      } else {
        const bundle = await uploadArtifact(env.ACTIONS_RESULTS_URL, env.ACTIONS_RUNTIME_TOKEN, `bundle-${build.commit}`, readFileSync(join(appDir, "bundle.tar.gz")));
        if (bundle !== build.digest) throw new Error(`the bundle uploaded is ${bundle}, not the ${build.digest} that was built`);
      }
      await uploadArtifact(env.ACTIONS_RESULTS_URL, env.ACTIONS_RUNTIME_TOKEN, `sbom-${build.commit}`, readFileSync(join(appDir, "sbom.cdx.json")));
      appendFileSync(env.GITHUB_OUTPUT, outputs);
      console.log(`uploaded the build of ${build.commit} as ${build.digest}`);
    } else if (command === "test-project" && appDir && outDir) {
      // One line the Portal reads from the pod's log, whatever happened (SDK-38).
      const timeoutMs = Number.parseInt(process.env.JC_TEST_TIMEOUT_MS ?? "", 10);
      console.log(`JC-TESTS ${JSON.stringify(testProject(appDir, outDir, { timeoutMs: timeoutMs > 0 ? timeoutMs : 100_000 }))}`);
    } else if (command === "seed" && appDir && outDir) {
      console.log(seed(appDir, outDir));
    } else if (command === "propose" && appDir) {
      // The runner gives every job the Portal's in-cluster address (AP-81).
      const api = process.env.JC_PORTAL_URL ?? "";
      const token = process.env.JC_LANE_TOKEN ?? "";
      if (!/^https?:\/\//.test(api)) throw new Error("JC_PORTAL_URL is not an http(s) URL");
      if (!token) throw new Error("JC_LANE_TOKEN is not set");
      const build = {
        digest: process.env.JC_DIGEST,
        commit: process.env.JC_COMMIT,
        sdkVersion: process.env.JC_SDK_VERSION,
        builtAt: process.env.JC_BUILT_AT,
      };
      outputsOf(build);
      const change = await propose(api, token, appDir, build);
      console.log(`proposed status.build: ${change?.metadata?.name ?? "accepted"}`);
    } else {
      throw new Error(
        "usage: lane.mjs deps <app-dir> | seed <from> <to> | functions <app-dir> <out-dir> | app <owner/repo> | sbom <node_modules> <out> | image <layer.tar> <dir> | upload <build-dir> | propose <owner/repo>",
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
