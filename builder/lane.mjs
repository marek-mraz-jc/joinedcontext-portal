// The build lane's checks, its functions bundle, its SBOM and its proposal (AP-80, AP-82, AP-84,
// AP-101, ADR-N-028).
//
//   node lane.mjs deps <app-dir>       refuses a package the template does not install (SDK-12)
//   node lane.mjs functions <app-dir> <out-dir>
//                                      bundles functions/*.ts into <out-dir>/functions.js
//   node lane.mjs app <owner/repo>     prints "{project} {app}" of an application repository
//   node lane.mjs sbom <node_modules> <out-file>
//                                      the CycloneDX SBOM of the packages the build linked
//   node lane.mjs propose <owner/repo> <build.json>
//                                      proposes status.build as the lane (JC_PORTAL_API, JC_LANE_TOKEN)
//
// Lives beside /opt/template/node_modules in the image, so `vite` resolves to the template's.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    } else if (command === "propose" && appDir && outDir) {
      const api = process.env.JC_PORTAL_API ?? "";
      const token = process.env.JC_LANE_TOKEN ?? "";
      if (!/^https?:\/\//.test(api)) throw new Error("JC_PORTAL_API is not an http(s) URL");
      if (!token) throw new Error("JC_LANE_TOKEN is not set");
      const change = await propose(api, token, appDir, JSON.parse(readFileSync(outDir, "utf8")));
      console.log(`proposed status.build: ${change?.metadata?.name ?? "accepted"}`);
    } else {
      throw new Error(
        "usage: lane.mjs deps <app-dir> | functions <app-dir> <out-dir> | app <owner/repo> | sbom <node_modules> <out> | propose <owner/repo> <build.json>",
      );
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
