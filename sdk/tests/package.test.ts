/**
 * T-0682: `@joinedcontext/sdk` is a package a generated application can install (SDK-17, AP-11).
 *
 * A published application is built in CI from its committed project, with the SDK installed from
 * the organization's forge registry rather than resolved to this checkout. So what the tarball
 * carries is the contract: every `exports` target has to be in it, the entry points have to be
 * built JavaScript with their declarations beside them, and the libraries the application pins
 * itself have to stay outside the bundle — one copy of React is the only copy that works.
 *
 * The build runs here rather than in a fixture because a stale `dist/package` would let the
 * package.json promise a file that the last build never wrote.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  private?: boolean;
  files: string[];
  exports: Record<string, string | Record<string, string>>;
  peerDependencies: Record<string, string>;
  dependencies: Record<string, string>;
};

/** Every file the tarball would carry, as `npm pack` lists it without writing one. */
function packed(): string[] {
  // `--ignore-scripts`: `prepack` builds the package, and its output would come back on stdout
  // in front of the JSON. `beforeAll` has already built it.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [tarball] = JSON.parse(out) as [{ files: { path: string }[] }];
  return tarball.files.map((file) => file.path);
}

const targets = (entry: string | Record<string, string>): string[] =>
  typeof entry === "string" ? [entry] : Object.values(entry);

describe("the published package", () => {
  let files: string[];

  beforeAll(() => {
    rmSync(join(root, "dist/package"), { recursive: true, force: true });
    execFileSync("pnpm", ["run", "build:package"], { cwd: root, stdio: "ignore" });
    files = packed();
  }, 600_000);

  it("is publishable at the Portal's own version", () => {
    expect(manifest.name).toBe("@joinedcontext/sdk");
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    // The template a generated application starts from pins exactly this version (SDK-17).
    const template = JSON.parse(readFileSync(join(root, "template/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(template.dependencies["@joinedcontext/sdk"]).toBe(manifest.version);
  });

  it("carries every file its exports promise", () => {
    const promised = Object.values(manifest.exports).flatMap(targets);
    expect(promised.length).toBeGreaterThan(4);
    for (const target of promised) {
      const path = target.replace(/^\.\//, "");
      expect(existsSync(join(root, path)), `${target} was never built`).toBe(true);
      expect(files, `${target} is outside "files"`).toContain(path);
    }
  });

  it("ships built JavaScript and declarations, never the TypeScript source", () => {
    for (const [name, entry] of Object.entries(manifest.exports)) {
      if (typeof entry === "string") continue;
      expect(entry.import, `${name} has no import target`).toMatch(/\.js$/);
      expect(entry.types, `${name} has no types`).toMatch(/\.d\.ts$/);
    }
    expect(files.some((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))).toBe(false);
    // The consumer's own `tsc -b` must not be handed this checkout's test setup.
    expect(files.some((file) => file.includes(".test."))).toBe(false);
  });

  it("leaves the application's own libraries outside the bundle", () => {
    const index = readFileSync(join(root, "dist/package/index.js"), "utf8");
    // What the bundle still imports by name was not copied into it.
    const imported = new Set(
      [...index.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map(([, name]) => name),
    );
    // Every peer is one the SDK's own code imports — `react-dom` as its `client` entry.
    for (const peer of Object.keys(manifest.peerDependencies)) {
      expect(
        [...imported].some((name) => name === peer || name.startsWith(`${peer}/`)),
        `${peer} is declared a peer but nothing imports it`,
      ).toBe(true);
    }
    expect(manifest.peerDependencies.react).toBeDefined();
    expect(manifest.dependencies.react).toBeUndefined();
    // What is left a dependency is bundled or installed for the consumer, never both.
    for (const own of Object.keys(manifest.dependencies)) {
      expect(manifest.peerDependencies[own]).toBeUndefined();
    }
    // `echartsTheme` and `rechartsPalette` return plain objects: the SDK never imports a chart
    // library, so a consumer must not be made to install one.
    for (const unused of ["echarts", "recharts", "@deck.gl/core"]) {
      expect(manifest.peerDependencies[unused]).toBeUndefined();
      expect(manifest.dependencies[unused]).toBeUndefined();
    }
  });

  it("is built for production, not for this checkout's development mode", () => {
    for (const entry of ["index.js", "server.js", "testing.js"]) {
      const built = readFileSync(join(root, "dist/package", entry), "utf8");
      expect(built, `${entry} ships React's development JSX runtime`).not.toContain(
        "jsx-dev-runtime",
      );
      expect(built, `${entry} left process.env in the bundle`).not.toContain("process.env.NODE_ENV");
    }
  });

  it("names the same peer versions the generated application pins", () => {
    const template = JSON.parse(readFileSync(join(root, "template/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const [peer, range] of Object.entries(manifest.peerDependencies)) {
      // A peer the template does not pin would be resolved twice, which is how two Reacts happen.
      expect(template.dependencies[peer], `${peer} is not pinned by the template`).toBe(range);
    }
  });

  it("carries no secret and no registry credential", () => {
    for (const file of files) {
      expect(file).not.toMatch(/\.(env|pem|key)$/);
      expect(file).not.toMatch(/npmrc/);
    }
  });
});
