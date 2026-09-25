# syntax=docker/dockerfile:1
# The build lane's image (AP-80, AP-82, ADR-N-026, ADR-N-028): git, curl, node, this release's SDK and the
# template's dependencies installed once, here, so a build fetches no package. Built from the
# repository root: docker build -f builder/Dockerfile . (the Node runner), and with
# --target rust the rust-1.90 runner of fullstack Apps (AP-106).

FROM node:24-slim AS sdk
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /sdk
COPY sdk/package.json sdk/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY sdk/ ./
RUN pnpm pack --pack-destination /out && mv /out/*.tgz /out/sdk.tgz \
    && node -p 'require("./package.json").version' > /out/sdk-version

FROM node:24-slim AS template
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY --from=sdk /out/ /opt/sdk/
# The SDK as this release built it, never a registry copy of the same version number, unpacked
# with the template beside it as in the repository: the template's lockfile resolves the SDK
# from the directory above (`file:..`, AP-126).
RUN mkdir -p /build/sdk/template && tar -xzf /opt/sdk/sdk.tgz --strip-components=1 -C /build/sdk
WORKDIR /build/sdk/template
COPY sdk/template/package.json sdk/template/pnpm-lock.yaml ./
COPY builder/lane.mjs /build/lane.mjs
# Exactly the packages the lockfile names (AP-127): a lockfile out of step with package.json
# fails the install, and a store missing a package the lockfile names fails the check.
RUN node /build/lane.mjs lock-manifest . \
    && corepack enable && pnpm install --frozen-lockfile --ignore-scripts \
    && node /build/lane.mjs store-check pnpm-lock.yaml node_modules \
    && test -x node_modules/.bin/vite && test -x node_modules/.bin/vitest && test -x node_modules/.bin/tsc \
    && cp /opt/sdk/sdk-version ./sdk-version \
    && mv /build/sdk/template /opt/template

# The forge's runner binary (ADR-N-028 §3.3), checked against the digest its release publishes.
FROM node:24-slim AS runner
ARG RUNNER_VERSION=3.5.0
ARG RUNNER_SHA256=16dc5c89ad5ac5496369642f01ed29c9bb130a2512e16a8cc3b400d9d0bfea73
ADD --checksum=sha256:${RUNNER_SHA256} \
    https://dl.gitea.com/gitea-runner/${RUNNER_VERSION}/gitea-runner-${RUNNER_VERSION}-linux-amd64 /gitea-runner

# The crate store of the rust-1.90 runner (AP-106, AP-127): every crate this release's Cargo.lock
# names, the reference applications' included, and every crate of the ui-rust template's own
# lockfile, fetched once here so a fullstack build fetches none.
FROM rust:1.90-slim-bookworm AS crates
WORKDIR /src
COPY . .
RUN CARGO_HOME=/opt/cargo cargo fetch --locked \
    && CARGO_HOME=/opt/cargo cargo fetch --locked --manifest-path sdk/template-fullstack/Cargo.toml

# The toolchain of the rust-1.90 runner. The tag pins the toolchain, not its Debian: upgrade the
# base's packages so the image carries the security fixes bookworm has shipped since the tag was
# cut (the image lane's trivy gate).
FROM rust:1.90-slim-bookworm AS toolchain
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends git curl ca-certificates musl-tools \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-musl

# The dependencies of the reference fullstack apps, compiled here, by CI, from their own
# Cargo.lock (AP-106, T-2794): the lane's two builds, `cargo test` and the release musl binary,
# with the lane's own paths, so the fingerprints match and a job only compiles its own crate and
# what its lock does not share. Cargo-chef style: each app's manifest and lock over stub sources,
# so nothing of the apps' code is in the seed.
FROM toolchain AS seed
COPY --from=crates /opt/cargo/registry/index /opt/cargo/registry/index
COPY --from=crates /opt/cargo/registry/cache /opt/cargo/registry/cache
COPY apps/air-quality/Cargo.toml apps/air-quality/Cargo.lock /manifests/air-quality/
COPY apps/hsl-transport/Cargo.toml apps/hsl-transport/Cargo.lock /manifests/hsl-transport/
# An app scaffolded from the ui-rust template starts from exactly these (AP-128).
COPY sdk/template-fullstack/Cargo.toml sdk/template-fullstack/Cargo.lock /manifests/jc-app/
ENV CARGO_HOME=/tmp/build/cargo CARGO_TARGET_DIR=/tmp/build/target CARGO_NET_OFFLINE=true
RUN set -eu; for app in air-quality hsl-transport jc-app; do \
      rm -rf /tmp/build/app /tmp/build/cargo && mkdir -p /tmp/build/cargo/registry /tmp/build/app/src; \
      ln -s /opt/cargo/registry/index /opt/cargo/registry/cache /tmp/build/cargo/registry/; \
      cp /manifests/$app/Cargo.toml /manifests/$app/Cargo.lock /tmp/build/app/; \
      echo 'fn main() {}' > /tmp/build/app/src/main.rs; : > /tmp/build/app/src/lib.rs; \
      cd /tmp/build/app; \
      cargo test --offline --locked --no-run; \
      cargo build --release --offline --locked --target x86_64-unknown-linux-musl; \
    done; \
    # The stubs' own artifacts are no App's: only the dependencies stay.
    find /tmp/build/target -depth \( -name 'air-quality*' -o -name 'air_quality*' -o -name 'libair_quality*' \
      -o -name 'hsl-transport*' -o -name 'hsl_transport*' -o -name 'libhsl_transport*' \
      -o -name 'jc-app*' -o -name 'jc_app*' -o -name 'libjc_app*' \) -exec rm -rf {} +; \
    rm -rf /tmp/build/target/*/incremental /tmp/build/target/*/*/incremental; \
    mv /tmp/build/target /opt/cargo/target-seed

# The rust-1.90 runner (AP-105, AP-106): the toolchain with the musl target, node and the
# template for the interface, the crate store, the precompiled dependencies, and the same lane and
# runner as the Node one. Built with `--target rust`; the last stage stays the Node runner.
FROM toolchain AS rust
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=template /opt/template/ /opt/template/
COPY --from=crates /opt/cargo/registry/index /opt/cargo/registry/index
COPY --from=crates /opt/cargo/registry/cache /opt/cargo/registry/cache
# Read-only to the lane's uid: a job copies it and never writes it.
COPY --from=seed /opt/cargo/target-seed /opt/cargo/target-seed
COPY scripts/app-integrity.mjs builder/lane.mjs /opt/template/
# The ui-rust template, whose lockfile every crate of the store must cover (AP-126, AP-127).
COPY sdk/template-fullstack/ /opt/template-fullstack/
RUN node /opt/template/lane.mjs crate-check /opt/template-fullstack/Cargo.lock /opt/cargo/registry/cache
COPY builder/build-app.sh /usr/local/bin/build-app
COPY --from=runner --chmod=0755 /gitea-runner /usr/local/bin/gitea-runner
COPY builder/runner.sh /usr/local/bin/runner
COPY builder/runner.yaml /opt/runner/runner.yaml
# The same runner, listed under the label a fullstack workflow asks for.
# A release build and link take longer than an interface build: the job's own 30 minutes.
RUN sed -i -e 's/"node-22:host"/"rust-1.90:host"/' -e 's/timeout: 20m/timeout: 30m/' /opt/runner/runner.yaml \
    && grep -q '"rust-1.90:host"' /opt/runner/runner.yaml && grep -q 'timeout: 30m' /opt/runner/runner.yaml
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/build-app"]

FROM node:24-slim
# npm, npx and corepack ship in the base image and nothing here runs them: a build installs
# nothing (AP-82). Removed, so their bundled packages are neither attack surface nor trivy findings.
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=template /opt/template/ /opt/template/
COPY scripts/app-integrity.mjs builder/lane.mjs /opt/template/
COPY builder/build-app.sh /usr/local/bin/build-app
# `jcctl validate --project`, the check every project repository's merge requests run on this
# runner (CC-90, .gitea/workflows/validate.yml of the project template). The platform image's
# own binary, pinned by digest: it links libc and libgcc alone, both in this base.
COPY --from=ghcr.io/marek-mraz-jc/joinedcontext-platform@sha256:1405436f6b9c0b936cb7429d068ea3c77c071fd87bf23c6bb87d392ea3eee03a \
    /usr/local/bin/jcctl /usr/local/bin/jcctl
# The same image is the forge's runner (ADR-N-028): the pod's command is `runner`.
COPY --from=runner --chmod=0755 /gitea-runner /usr/local/bin/gitea-runner
COPY builder/runner.sh /usr/local/bin/runner
COPY builder/runner.yaml /opt/runner/runner.yaml
# The restricted Pod Security Standard runs it as this uid, with nothing it may write but /tmp.
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/build-app"]
