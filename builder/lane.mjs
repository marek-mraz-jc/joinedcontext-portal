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
//   node lane.mjs lock-manifest <dir> points <dir>/package.json's SDK at the directory above, as the
//                                      template's lockfile resolves it (AP-126)
//   node lane.mjs store-check <pnpm-lock.yaml> <node_modules>
//                                      fails when a package the lockfile names for this platform
//                                      is not in the store (AP-127)
//   node lane.mjs propose <owner/repo> proposes status.build as the lane, from the build job's
//                                      outputs (JC_DIGEST, JC_COMMIT, JC_SDK_VERSION, JC_BUILT_AT)
//                                      to JC_PORTAL_URL with JC_LANE_TOKEN
//
// Lives beside /opt/template/node_modules in the image, so `vite` resolves to the template's.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

/**
 * The SDK is this release's own build, never a registry package: a template's lockfile resolves
 * it from the directory above the template, `sdk/` in the repository and the unpacked SDK in the
 * runner image, so both install the same packages (AP-126, AP-127).
 */
export const SDK_SPEC = "file:..";

/** The template's manifest as its lockfile was written from: the SDK taken from `SDK_SPEC`. */
export function lockManifest(pkg) {
  if (!pkg.dependencies?.["@joinedcontext/sdk"]) throw new Error("the template does not depend on @joinedcontext/sdk");
  return { ...pkg, dependencies: { ...pkg.dependencies, "@joinedcontext/sdk": SDK_SPEC } };
}

/** Whether a lockfile's `os`/`cpu`/`libc` list admits `value`: absent, listed, or not denied with `!`. */
function admits(list, value) {
  if (!list) return true;
  const items = list.split(",").map((item) => item.trim().replace(/^'|'$/g, "")).filter(Boolean);
  const denied = items.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
  return denied.length > 0 ? !denied.includes(value) : items.includes(value);
}

/**
 * The `name@version` entries of a pnpm v9 lockfile's `packages:` that a store for `platform`
 * ({ os, cpu, libc }) must hold but whose folder is missing from `folders` (the names in
 * `node_modules/.pnpm`), sorted (AP-127). Packages built for another platform are not installed
 * there and are skipped; a directory or link dependency (the SDK) is not a registry package.
 */
export function missingFromStore(lock, folders, platform) {
  const have = new Set(folders.map((folder) => folder.split("_")[0]));
  const entries = [];
  let section = "";
  for (const line of String(lock).split("\n")) {
    if (/^\S/.test(line)) {
      section = line.trim();
      continue;
    }
    if (section !== "packages:") continue;
    const key = /^  '?([^' ][^']*?)'?:\s*$/.exec(line)?.[1];
    if (key) {
      entries.push({ key, fields: {} });
      continue;
    }
    const field = /^    (os|cpu|libc): \[(.*)\]\s*$/.exec(line);
    if (field && entries.length > 0) entries[entries.length - 1].fields[field[1]] = field[2];
  }
  const missing = [];
  for (const { key, fields } of entries) {
    const at = key.lastIndexOf("@");
    const [name, version] = [key.slice(0, at), key.slice(at + 1)];
    if (at <= 0 || version.includes(":")) continue;
    if (!admits(fields.os, platform.os) || !admits(fields.cpu, platform.cpu) || !admits(fields.libc, platform.libc)) continue;
    if (!have.has(`${name.replace("/", "+")}@${version}`)) missing.push(key);
  }
  return missing.sort();
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
    } else if (command === "seed" && appDir && outDir) {
      console.log(seed(appDir, outDir));
    } else if (command === "lock-manifest" && appDir) {
      const path = join(appDir, "package.json");
      writeFileSync(path, `${JSON.stringify(lockManifest(JSON.parse(readFileSync(path, "utf8"))), null, 2)}\n`);
    } else if (command === "store-check" && appDir && outDir) {
      // The runner images are Debian (glibc); a musl libc would say so in its loader's name.
      const libc = existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1") ? "musl" : "glibc";
      const store = join(outDir, ".pnpm");
      const missing = missingFromStore(readFileSync(appDir, "utf8"), existsSync(store) ? readdirSync(store) : [], {
        os: process.platform,
        cpu: process.arch,
        libc,
      });
      if (missing.length > 0) throw new Error(`the store in ${outDir} lacks ${missing.length} package(s) ${appDir} names: ${missing.join(", ")}`);
      if (!existsSync(join(outDir, "@joinedcontext", "sdk", "package.json"))) throw new Error(`the store in ${outDir} holds no @joinedcontext/sdk`);
      console.log(`the store in ${outDir} holds every package ${appDir} names`);
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
        "usage: lane.mjs deps <app-dir> | lock-manifest <dir> | store-check <pnpm-lock.yaml> <node_modules> | seed <from> <to> | functions <app-dir> <out-dir> | app <owner/repo> | sbom <node_modules> <out> | image <layer.tar> <dir> | upload <build-dir> | propose <owner/repo>",
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
