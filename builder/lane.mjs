// The build lane's two checks and its functions bundle (AP-80, AP-82, AP-84, ADR-N-026).
//
//   node lane.mjs deps <app-dir>       refuses a package the template does not install (SDK-12)
//   node lane.mjs functions <app-dir> <out-dir>
//                                      bundles functions/*.ts into <out-dir>/functions.js
//
// Lives beside /opt/template/node_modules in the image, so `vite` resolves to the template's.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TEMPLATE = new URL("./package.json", import.meta.url);
// The name a function is called by, the same rule the Portal applies to a run's functions.
const FUNCTION = /^[a-z][a-z0-9-]{0,39}$/;

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
    } else {
      throw new Error("usage: lane.mjs deps <app-dir> | functions <app-dir> <out-dir>");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
