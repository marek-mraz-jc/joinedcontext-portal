// The build lane's checks, its functions bundle, its SBOM and its proposal (AP-80, AP-82, AP-84,
// AP-101, ADR-N-028).
//
//   node lane.mjs deps <app-dir>       refuses a package the template does not install (SDK-12)
//   node lane.mjs functions <app-dir> <out-dir>
//                                      bundles functions/*.ts into <out-dir>/functions.js
//   node lane.mjs app <owner/repo>     prints "{project} {app}" of an application repository
//   node lane.mjs sbom <node_modules> <out-file>
//                                      the CycloneDX SBOM of the packages the build linked
//   node lane.mjs upload <build-dir>   uploads bundle-{commit} and sbom-{commit} as the run's
//                                      artifacts and writes the build to $GITHUB_OUTPUT
//   node lane.mjs propose <owner/repo> proposes status.build as the lane, from the build job's
//                                      outputs (JC_DIGEST, JC_COMMIT, JC_SDK_VERSION, JC_BUILT_AT)
//                                      to JC_PORTAL_URL with JC_LANE_TOKEN
//
// Lives beside /opt/template/node_modules in the image, so `vite` resolves to the template's.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * runner cannot reach, so it is sent to the origin of `ACTIONS_RESULTS_URL` with the signed path
 * and query kept as they are.
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
  const upload = new URL(`${signed.pathname}${signed.search}`, base.origin);
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

/** Reads the App, then proposes it back with `status.build`; the Change the Portal answers. */
export async function propose(api, token, repository, build, fetchImpl = fetch) {
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
  const read = await fetchImpl(url, { headers });
  if (!read.ok) throw await refused("cannot read the App", read);
  const body = withBuild(await read.json(), build);
  const written = await fetchImpl(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!written.ok) throw await refused("status.build was refused for", written);
  return written.json();
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
    } else if (command === "functions" && appDir && outDir) {
      await bundleFunctions(resolve(appDir), outDir);
    } else if (command === "app" && appDir) {
      const { project, app } = appOf(appDir);
      console.log(`${project} ${app}`);
    } else if (command === "sbom" && appDir && outDir) {
      const store = join(appDir, ".pnpm");
      const folders = existsSync(store) ? readdirSync(store) : [];
      writeFileSync(outDir, JSON.stringify(sbomOf(folders), null, 2) + "\n");
    } else if (command === "upload" && appDir) {
      const env = process.env;
      if (!env.ACTIONS_RESULTS_URL || !env.ACTIONS_RUNTIME_TOKEN || !env.GITHUB_OUTPUT) {
        throw new Error("upload runs in a workflow job: ACTIONS_RESULTS_URL, ACTIONS_RUNTIME_TOKEN and GITHUB_OUTPUT are not set");
      }
      const build = JSON.parse(readFileSync(join(appDir, "build.json"), "utf8"));
      const outputs = outputsOf(build);
      const bundle = await uploadArtifact(env.ACTIONS_RESULTS_URL, env.ACTIONS_RUNTIME_TOKEN, `bundle-${build.commit}`, readFileSync(join(appDir, "bundle.tar.gz")));
      if (bundle !== build.digest) throw new Error(`the bundle uploaded is ${bundle}, not the ${build.digest} that was built`);
      await uploadArtifact(env.ACTIONS_RESULTS_URL, env.ACTIONS_RUNTIME_TOKEN, `sbom-${build.commit}`, readFileSync(join(appDir, "sbom.cdx.json")));
      appendFileSync(env.GITHUB_OUTPUT, outputs);
      console.log(`uploaded bundle-${build.commit} ${bundle}`);
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
        "usage: lane.mjs deps <app-dir> | functions <app-dir> <out-dir> | app <owner/repo> | sbom <node_modules> <out> | upload <build-dir> | propose <owner/repo>",
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
