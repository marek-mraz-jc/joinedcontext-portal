# A joinedcontext application (`ui-rust`)

The interface in `ui/` (React on the App SDK, the `ui` template) and this axum backend, which
embeds the interface's build and serves it. Pick this shape when the app needs work a function
cannot do: a database of its own, scheduled or long work, a write workflow of several steps.
The image is the one static binary, run as a non-root user on a read-only root filesystem.

## Commands

| Where | Command      | What it does                                                        |
|-------|--------------|---------------------------------------------------------------------|
| `ui/` | `pnpm dev`   | Vite's dev server with hot reload                                   |
| `ui/` | `pnpm test`  | the interface's tests (vitest with testing-library)                 |
| `ui/` | `pnpm build` | typechecks and builds into `ui/dist`, which the binary embeds       |
| root  | `cargo test` | the backend's tests, against a stand-in endpoint and Portal         |
| root  | `cargo run`  | the backend, with the variables below                               |

Build the interface before the binary: a debug build reads `ui/dist` as it was when it was
compiled, and without a build the page says so. The build lane runs the interface's tests and
build, `cargo test` and a release build on every push to `main`, offline, from the packages and
crates its runner image holds for the lockfiles of the Portal release (AP-127).

## What the pod is given

| Variable          | What it is                                                                     |
|-------------------|--------------------------------------------------------------------------------|
| `JC_ENDPOINT_URL` | `https://{host}/api/endpoint/{slug}/`, the one endpoint the app reads and writes |
| `JC_APP_CONFIG`   | the `#jc-config` the page's App SDK starts from, without the person            |
| `JC_ME_URL`       | the Portal's `/me` of this App: the person's id, name, e-mail and roles        |
| `JC_BASE_PATH`    | the path the app is served under, `/apps/{name}/`                              |
| `JC_BIND_ADDRESS` | where it listens, `0.0.0.0:8080` in the pod                                    |
| `JC_ANONYMOUS`    | `true` on a public App, where a request without a token is normal              |

To run it on your machine:

```bash
JC_ENDPOINT_URL=https://{host}/api/endpoint/{slug}/ \
JC_APP_CONFIG='{"slug":"{slug}","orgDomain":"{domain}","space":"{space}","transport":"origin","appName":"{name}"}' \
JC_BASE_PATH=/apps/{name}/ \
cargo run
```

## Where things are

| Path                     | Holds                                                                     |
|--------------------------|---------------------------------------------------------------------------|
| `src/lib.rs`             | the routes: `/healthz`, `/api/me`, `/api/functions/summary` and the page; add the app's own beside `summary` |
| `src/assets.rs`          | the embedded interface and the page with its `#jc-config`                 |
| `src/main.rs`            | JSON logs, the variables, bind, serve                                     |
| `tests/server_tests.rs`  | the backend against a stand-in endpoint and Portal (wiremock)            |
| `ui/`                    | the interface: its own `README.md` says what is where                     |

## Rules the template keeps

- No credential and no login of its own: the edge signs the person in and hands over their
  token as `X-Access-Token`; the backend carries it to the endpoint as `Authorization: Bearer`
  and to `/me`, never logs it and never puts it into the page. A request without a token is
  refused unless the App is public, and never retried without it.
- The endpoint's gateway decides what a person may read and write; its refusal reaches the page
  as it was sent. The roles from `/me` decide what the page offers, never what the data allows.
- A value a caller sends is checked before it reaches the upstream query (`valid_type`).
- The interface's `useFunction("summary")` reaches this backend at `/api/functions/summary`: the
  work the `ui` shape does in a function is done here in Rust, so `ui/` is the `ui` template
  unchanged. Its `functions/` stays for the type the overview imports and its tests; no
  function runtime serves it here.
- Every dependency is pinned to one version in `Cargo.toml` and `Cargo.lock`; a crate the
  runner image does not hold fails the build.
