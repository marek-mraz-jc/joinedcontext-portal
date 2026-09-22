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
WORKDIR /opt/template
COPY --from=sdk /out/ /opt/sdk/
COPY sdk/template/package.json ./
# The SDK as this release built it, never a registry copy of the same version number.
RUN node -e 'const f="package.json",p=require("./"+f);p.dependencies["@joinedcontext/sdk"]="file:/opt/sdk/sdk.tgz";require("fs").writeFileSync(f,JSON.stringify(p,null,2))' \
    && corepack enable && pnpm install --ignore-scripts \
    && test -x node_modules/.bin/vite && test -x node_modules/.bin/vitest && test -x node_modules/.bin/tsc \
    && cp /opt/sdk/sdk-version ./sdk-version

# The forge's runner binary (ADR-N-028 §3.3), checked against the digest its release publishes.
FROM node:24-slim AS runner
ARG RUNNER_VERSION=3.5.0
ARG RUNNER_SHA256=16dc5c89ad5ac5496369642f01ed29c9bb130a2512e16a8cc3b400d9d0bfea73
ADD --checksum=sha256:${RUNNER_SHA256} \
    https://dl.gitea.com/gitea-runner/${RUNNER_VERSION}/gitea-runner-${RUNNER_VERSION}-linux-amd64 /gitea-runner

# The crate store of the rust-1.90 runner (AP-106): every crate this release's Cargo.lock names,
# the reference applications' included, fetched once here so a fullstack build fetches none.
FROM rust:1.90-slim-bookworm AS crates
WORKDIR /src
COPY . .
RUN CARGO_HOME=/opt/cargo cargo fetch --locked

# The rust-1.90 runner (AP-105, AP-106): the toolchain with the musl target, node and the
# template for the interface, the crate store, and the same lane and runner as the Node one.
# Built with `--target rust`; the last stage stays the Node runner.
FROM rust:1.90-slim-bookworm AS rust
# The tag pins the toolchain, not its Debian: upgrade the base's packages so the image carries
# the security fixes bookworm has shipped since the tag was cut (the image lane's trivy gate).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends git curl ca-certificates musl-tools \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add x86_64-unknown-linux-musl
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=template /opt/template/ /opt/template/
COPY --from=crates /opt/cargo/registry/index /opt/cargo/registry/index
COPY --from=crates /opt/cargo/registry/cache /opt/cargo/registry/cache
COPY scripts/app-integrity.mjs builder/lane.mjs /opt/template/
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
