# syntax=docker/dockerfile:1
# The build lane's image (AP-80, AP-82, ADR-N-026): git, curl, node, this release's SDK and the
# template's dependencies installed once, here, so a build fetches no package. Built from the
# repository root: docker build -f builder/Dockerfile .

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
# The restricted Pod Security Standard runs it as this uid, with nothing it may write but /tmp.
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/build-app"]
