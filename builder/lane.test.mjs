// node --test builder/lane.test.mjs (vite from sdk/node_modules for the bundle test)
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { appOf, artifactScope, bundleFunctions, cratesOf, functionEntries, ociImage, outputsOf, propose, refusedDependencies, sbomOf, uploadArtifact, withBuild, writeLayout } from "./lane.mjs";

const template = { dependencies: { react: "^19", "@joinedcontext/sdk": "0.1.0" }, devDependencies: { vite: "^8" } };

test("the template's own packages pass, with any version asked for", () => {
  assert.deepEqual(refusedDependencies({ dependencies: { react: "18" }, devDependencies: { vite: "*" } }, template), []);
  assert.deepEqual(refusedDependencies({}, template), []);
});

test("a package the template does not install is refused by name", () => {
  assert.deepEqual(
    refusedDependencies({ dependencies: { react: "^19", "left-pad": "1" }, devDependencies: { "evil-postinstall": "1" } }, template),
    ["evil-postinstall", "left-pad"],
  );
});

// SDK-12, AP-100, AP-105 (T-2617): a sample the forge bootstrap pushes to its own repository
// builds there, so the lane's package check passes on it against the real template: the page of a
// static app at its root, the interface of a fullstack app in ui/. Its Playwright flows are why
// the template installs @playwright/test; the lane never runs them.
test("every sample application passes the lane's package check against the template", () => {
  const root = new URL("..", import.meta.url).pathname;
  const real = JSON.parse(readFileSync(join(root, "sdk/template/package.json"), "utf8"));
  let seen = 0;
  for (const name of readdirSync(join(root, "apps"))) {
    // Only an app whose source is a forge repository builds on the lane.
    const app = join(root, "apps", name, "app.yaml");
    if (!existsSync(app) || !/^  source:\n    git:$/m.test(readFileSync(app, "utf8"))) continue;
    for (const manifest of [join(root, "apps", name, "package.json"), join(root, "apps", name, "ui/package.json")]) {
      if (!existsSync(manifest)) continue;
      seen += 1;
      assert.deepEqual(refusedDependencies(JSON.parse(readFileSync(manifest, "utf8")), real), [], manifest);
    }
  }
  assert.ok(seen >= 4, `only ${seen} sample packages found`);
});

function app(files) {
  const dir = mkdtempSync(join(tmpdir(), "lane-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("functions are the .ts files of functions/, tests and other files left out", () => {
  const dir = app({ "functions/summary.ts": "", "functions/bike-stats.ts": "", "functions/summary.test.ts": "", "functions/notes.md": "" });
  assert.deepEqual(functionEntries(join(dir, "functions")), ["bike-stats", "summary"]);
  assert.deepEqual(functionEntries(join(dir, "nothing-here")), []);
});

test("a function name the route cannot carry fails the build", () => {
  const dir = app({ "functions/Summary.ts": "" });
  assert.throws(() => functionEntries(join(dir, "functions")), /function name/);
});

test("the bundle exports each function by name and leaves the SDK server to the runtime", async () => {
  const dir = app({
    "functions/summary.ts": 'import { json } from "@joinedcontext/sdk/server";\nconst f = (r: unknown) => json({ ok: r !== null });\nexport default f;\n',
    "functions/bike-stats.ts": "export default (): number => 2;\n",
    "functions/summary.test.ts": "throw new Error('a test is never bundled');\n",
  });
  const out = join(dir, "dist");
  assert.equal(await bundleFunctions(dir, out), true);
  const bundle = readFileSync(join(out, "functions.js"), "utf8");
  assert.match(bundle, /from "@joinedcontext\/sdk\/server"/);
  assert.match(bundle, /as "bike-stats"/);
  assert.match(bundle, /as summary|summary as|summary\b.*export|export \{[^}]*summary/s);
  assert.doesNotMatch(bundle, /never bundled/);
});

test("an app with no functions gets no bundle", async () => {
  const dir = app({ "index.html": "<p>hi</p>" });
  assert.equal(await bundleFunctions(dir, join(dir, "dist")), false);
});

// AP-75: the repository name carries the project and the application, split at the one `_`.
test("an application repository names its project and application", () => {
  assert.deepEqual(appOf("joinedcontext/helsinki_city-bikes"), { project: "helsinki", app: "city-bikes" });
  assert.deepEqual(appOf("helsinki_bikes"), { project: "helsinki", app: "bikes" });
  for (const name of ["configuration", "_bikes", "helsinki_", "Helsinki_bikes", "helsinki_bi_kes"]) {
    assert.throws(() => appOf(`joinedcontext/${name}`), /\{project\}_\{app\}/, name);
  }
});

// AP-11, AP-101: the SBOM lists every linked package once, sorted, the same bytes on every build.
test("the SBOM names each package of the store once, scoped ones included", () => {
  const bom = sbomOf(["react@19.2.0", "@deck.gl+core@9.4.0_@luma.gl+core@9.4.2", "react@19.2.0", "lock.yaml", "node_modules"]);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.deepEqual(
    bom.components.map((c) => c.purl),
    ["pkg:npm/%40deck.gl/core@9.4.0", "pkg:npm/react@19.2.0"],
  );
  assert.equal(JSON.stringify(sbomOf(["b@1", "a@2"])), JSON.stringify(sbomOf(["a@2", "b@1"])));
  assert.deepEqual(sbomOf([]).components, []);
});

const build = {
  digest: `sha256:${"ab".repeat(32)}`,
  commit: "0123456789abcdef0123456789abcdef01234567",
  sdkVersion: "0.4.1",
  builtAt: "2026-09-22T06:00:00Z",
};
const manifest = {
  apiVersion: "joinedcontext.com/v1alpha1",
  kind: "App",
  metadata: { name: "city-bikes", namespace: "helsinki" },
  spec: { kind: "static", lifecycle: "published" },
  status: { phase: "Live", sourceUrl: "https://git.example/x", conditions: [] },
};

// AP-73: the lane writes status.build and nothing else, whatever status the Portal computed.
test("the proposal carries the App as read with status.build alone", () => {
  assert.deepEqual(withBuild(manifest, build).status, { build });
  assert.deepEqual(withBuild(manifest, build).spec, manifest.spec);
  assert.throws(() => withBuild(manifest, { ...build, digest: "sha256:short" }), /sha256 digest/);
  assert.throws(() => withBuild(manifest, { ...build, commit: "main" }), /full commit/);
  assert.throws(() => withBuild({ kind: "Endpoint", metadata: {}, spec: {} }, build), /not answer with an App/);
});

function portal(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body });
    const [status, body] = answers.shift();
    return { ok: status < 300, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

// AP-80: the lane token travels only as the bearer, to the App's own route, read then proposed.
test("propose reads the App and writes it back once with the lane's bearer", async () => {
  const { calls, fetchImpl } = portal([[200, manifest], [202, { metadata: { name: "chg-00000042" } }]]);
  const change = await propose("https://portal.example/", "lane-token", "joinedcontext/helsinki_city-bikes", build, fetchImpl);
  assert.equal(change.metadata.name, "chg-00000042");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "GET https://portal.example/api/v1/projects/helsinki/apps/city-bikes",
    "PUT https://portal.example/api/v1/projects/helsinki/apps/city-bikes",
  ]);
  assert.equal(calls[1].headers.Authorization, "Bearer lane-token");
  assert.deepEqual(JSON.parse(calls[1].body).status, { build });
  assert.ok(!calls.some((c) => c.url.includes("lane-token")));
});

test("a refusal names the App and the Portal's reason, never the token", async () => {
  const { fetchImpl } = portal([[200, manifest], [403, { detail: "status.build is written by the build lane" }]]);
  await assert.rejects(
    propose("https://portal.example", "lane-token", "joinedcontext/helsinki_city-bikes", build, fetchImpl),
    (err) => /helsinki\/city-bikes: the Portal answered 403 status.build is written/.test(err.message) && !err.message.includes("lane-token"),
  );
  const missing = portal([[404, null]]);
  await assert.rejects(
    propose("https://portal.example", "t", "joinedcontext/helsinki_gone", build, missing.fetchImpl),
    /cannot read the App helsinki\/gone: the Portal answered 404/,
  );
  assert.equal(missing.calls.length, 1, "nothing is written after a failed read");
});

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part(claims)}.sig`;
}
const RUNTIME = jwt({ scp: "Actions.UploadArtifacts:3:5 Actions.Results:3:5" });

// AP-101: the run and job come from the runtime token the forge issued, nothing else.
test("the artifact scope is the run and job of the runtime token", () => {
  assert.deepEqual(artifactScope(RUNTIME), { workflowRunBackendId: "3", workflowJobRunBackendId: "5" });
  assert.throws(() => artifactScope(jwt({ scp: "Actions.UploadArtifacts:3:5" })), /names no run/);
  assert.throws(() => artifactScope("not-a-jwt"), /names no run/);
  assert.throws(() => artifactScope(undefined), /names no run/);
});

function forge(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    const [status, body] = answers.shift();
    return { ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)) };
  };
  return { calls, fetchImpl };
}

// AP-101, ADR-N-028: create, append, finalize; the signed address is sent to the runner's forge
// origin, its signature kept, and the hash is the SHA-256 of the bytes uploaded.
test("upload creates, appends to the in-cluster origin, and finalizes with the bytes' hash", async () => {
  const signed = "https://forge.public.example/twirp/api/actions/3/artifacts/9/upload?sig=abc&expires=1";
  const { calls, fetchImpl } = forge([[200, { ok: true, signedUploadUrl: signed }], [201], [200, { ok: true }]]);
  const bytes = Buffer.from("bundle");
  const hash = await uploadArtifact("http://gitea-http:3000/api/actions_pipeline/", RUNTIME, "bundle-abc", bytes, fetchImpl);

  const expected = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(hash, expected);
  const service = "http://gitea-http:3000/api/actions_pipeline/twirp/github.actions.results.api.v1.ArtifactService/";
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `POST ${service}CreateArtifact`,
    "PUT http://gitea-http:3000/twirp/api/actions/3/artifacts/9/upload?sig=abc&expires=1&comp=block",
    `POST ${service}FinalizeArtifact`,
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { workflowRunBackendId: "3", workflowJobRunBackendId: "5", name: "bundle-abc", version: 4 });
  assert.deepEqual(JSON.parse(calls[2].body), { workflowRunBackendId: "3", workflowJobRunBackendId: "5", name: "bundle-abc", size: "6", hash: expected });
  assert.equal(calls[0].headers.Authorization, `Bearer ${RUNTIME}`);
  assert.equal(calls[1].headers.Authorization, undefined, "the signed address carries its own grant");
});

test("a refused upload names the artifact and stops before finalize", async () => {
  const refused = forge([[401, { msg: "bad token" }]]);
  await assert.rejects(uploadArtifact("http://f/api/actions_pipeline", RUNTIME, "sbom-abc", Buffer.from("x"), refused.fetchImpl), /refused CreateArtifact of sbom-abc: 401/);
  const noAddress = forge([[200, { ok: true }]]);
  await assert.rejects(uploadArtifact("http://f/", RUNTIME, "sbom-abc", Buffer.from("x"), noAddress.fetchImpl), /no upload address for sbom-abc/);
  const put = forge([[200, { signedUploadUrl: "http://f/u?sig=1" }], [500]]);
  await assert.rejects(uploadArtifact("http://f/", RUNTIME, "sbom-abc", Buffer.from("x"), put.fetchImpl), /refused the upload of sbom-abc: 500/);
  assert.equal(put.calls.length, 2, "nothing is finalized after a failed upload");
});

// AP-80: the outputs the propose job reads are the four fields, checked before they are written.
test("the build job's outputs are the four fields of status.build, checked", () => {
  assert.equal(outputsOf(build), `digest=${build.digest}\ncommit=${build.commit}\nsdk-version=${build.sdkVersion}\nbuilt-at=${build.builtAt}\n`);
  assert.throws(() => outputsOf({ ...build, sdkVersion: "0.4.1\ndigest=sha256:evil" }), /SDK version/);
  assert.throws(() => outputsOf({ ...build, builtAt: "yesterday" }), /UTC build time/);
  assert.throws(() => outputsOf({ ...build, commit: "" }), /full commit/);
  assert.throws(() => outputsOf(undefined), /sha256 digest/);
});

// AP-105: the image is one gzip layer, a config that runs /app as uid 65532, and an OCI
// manifest whose digest is the SHA-256 of its bytes; the same layer is the same digest.
test("the image of a layer is a digest-addressed OCI manifest, reproducible", () => {
  const layer = Buffer.from("a tar holding /app");
  const image = ociImage(layer);
  const [config, gz, manifestBytes] = image.blobs;
  const manifest = JSON.parse(manifestBytes);
  const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  assert.equal(image.digest, digestOf(manifestBytes));
  assert.equal(manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert.deepEqual(manifest.config, { mediaType: "application/vnd.oci.image.config.v1+json", digest: digestOf(config), size: config.length });
  assert.deepEqual(manifest.layers, [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: digestOf(gz), size: gz.length }]);
  const parsed = JSON.parse(config);
  assert.deepEqual(parsed.config, { Entrypoint: ["/app"], User: "65532:65532", WorkingDir: "/" });
  assert.deepEqual(parsed.rootfs.diff_ids, [digestOf(layer)]);
  assert.ok(!("created" in parsed), "no time in the config");
  assert.equal(JSON.parse(image.index).manifests[0].digest, image.digest);
  assert.equal(ociImage(Buffer.from("a tar holding /app")).digest, image.digest);
  assert.notEqual(ociImage(Buffer.from("another /app")).digest, image.digest);
});

test("the layout holds oci-layout, index.json and each blob under its digest", () => {
  const dir = mkdtempSync(join(tmpdir(), "layout-"));
  const image = ociImage(Buffer.from("x"));
  writeLayout(image, dir);
  assert.equal(readFileSync(join(dir, "oci-layout"), "utf8"), '{"imageLayoutVersion":"1.0.0"}');
  assert.deepEqual(readFileSync(join(dir, "index.json")), image.index);
  for (const blob of image.blobs) {
    const hex = createHash("sha256").update(blob).digest("hex");
    assert.deepEqual(readFileSync(join(dir, "blobs", "sha256", hex)), blob);
  }
});

// AP-105: the SBOM names every registry crate of the lock, and no path crate (the app itself).
test("the crates of a Cargo.lock are SBOM components, registry crates only", () => {
  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "air-quality"',
    'version = "0.1.0"',
    "",
    "[[package]]",
    'name = "axum"',
    'version = "0.8.4"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "abc"',
    "",
    "[[package]]",
    'name = "anyhow"',
    'version = "1.0.98"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    "",
    "[[package]]",
    'name = "from-git"',
    'version = "0.1.0"',
    'source = "git+https://example.org/x#abc"',
  ].join("\n");
  assert.deepEqual(cratesOf(lock), [
    { type: "library", name: "anyhow", version: "1.0.98", purl: "pkg:cargo/anyhow@1.0.98" },
    { type: "library", name: "axum", version: "0.8.4", purl: "pkg:cargo/axum@0.8.4" },
  ]);
  assert.deepEqual(cratesOf(""), []);
});
