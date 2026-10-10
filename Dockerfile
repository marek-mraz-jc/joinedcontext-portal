# syntax=docker/dockerfile:1
# One binary: the axum API, the embedded UI bundle and the in-process reconciler.

# The Vite build. rust-embed reads ui/dist at compile time, so the bundle has to exist
# before cargo runs; without this stage the binary ships the placeholder page and every
# view of DEMO.md is unreachable on the deployed platform (T-0369).
FROM node:24-slim AS ui
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Both halves of the build context: `ui` depends on `@joinedcontext/sdk` as `link:../sdk` (T-1439,
# UI-71 — one grid, linked and never copied), so the sibling has to be beside it before
# `pnpm install` can resolve it, and its sources have to be there before Vite compiles them.
WORKDIR /work
COPY sdk/package.json sdk/pnpm-lock.yaml ./sdk/
COPY ui/package.json ui/pnpm-lock.yaml ./ui/
# The SDK's own dependencies first: `link:` symlinks the sibling and installs nothing for it, so
# without this `tsc -b` finds no `react` types beside the SDK's sources and Vite resolves none of
# its imports (the red main of 1a7c5b9).
RUN corepack enable && cd sdk && pnpm install --frozen-lockfile && cd ../ui && pnpm install --frozen-lockfile
COPY sdk/ ./sdk/
COPY ui/ ./ui/
WORKDIR /work/ui
# An empty dist embeds as nothing and the placeholder page comes back silently, so the
# image build is where that is caught, not the demo.
RUN pnpm build && test -s dist/index.html && ls dist/assets/*.js >/dev/null

# The App SDK (SDK-01) with the kit renderer the spec pass still fills in, embedded like the UI.
FROM node:24-slim AS sdk
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /sdk
COPY sdk/package.json sdk/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY sdk/ ./
RUN pnpm build && test -s dist/kit.js && test -s dist/kit.css && test -s dist/kit-worker.js \
    && test -s dist/runtime/runtime.json && test -s dist/functions-server.js \
    && test -s dist/demos/index.html

# The static apps the Portal serves under /apps/{name}/ (AP-14): each built bundle with the
# `integrity.json` the host checks every file against before it serves it (AP-12). An app without
# that map serves nothing, so the stage fails rather than ship one without it (T-2457).
FROM node:24-slim AS apps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /work
COPY sdk/package.json sdk/pnpm-lock.yaml ./sdk/
COPY apps/bbsk-ukazovatele/ui/package.json apps/bbsk-ukazovatele/ui/pnpm-lock.yaml ./apps/bbsk-ukazovatele/ui/
COPY apps/banskabystrica-zaznamy/ui/package.json apps/banskabystrica-zaznamy/ui/pnpm-lock.yaml ./apps/banskabystrica-zaznamy/ui/
COPY apps/bbsk-zaznamy/ui/package.json apps/bbsk-zaznamy/ui/pnpm-lock.yaml ./apps/bbsk-zaznamy/ui/
COPY apps/banskabystrica-ovzdusie/ui/package.json apps/banskabystrica-ovzdusie/ui/pnpm-lock.yaml ./apps/banskabystrica-ovzdusie/ui/
COPY apps/banskabystrica-mapa/ui/package.json apps/banskabystrica-mapa/ui/pnpm-lock.yaml ./apps/banskabystrica-mapa/ui/
COPY apps/banskabystrica-data/ui/package.json apps/banskabystrica-data/ui/pnpm-lock.yaml ./apps/banskabystrica-data/ui/
COPY apps/banskabystrica-skoly/ui/package.json apps/banskabystrica-skoly/ui/pnpm-lock.yaml ./apps/banskabystrica-skoly/ui/
COPY apps/bbsk-mapa/ui/package.json apps/bbsk-mapa/ui/pnpm-lock.yaml ./apps/bbsk-mapa/ui/
COPY apps/bbsk-data/ui/package.json apps/bbsk-data/ui/pnpm-lock.yaml ./apps/bbsk-data/ui/
COPY apps/bbsk-mosty/ui/package.json apps/bbsk-mosty/ui/pnpm-lock.yaml ./apps/bbsk-mosty/ui/
COPY apps/praha-mapa/ui/package.json apps/praha-mapa/ui/pnpm-lock.yaml ./apps/praha-mapa/ui/
COPY apps/praha-data/ui/package.json apps/praha-data/ui/pnpm-lock.yaml ./apps/praha-data/ui/
COPY apps/praha-odpad/ui/package.json apps/praha-odpad/ui/pnpm-lock.yaml ./apps/praha-odpad/ui/
COPY apps/helsinki-kartta/ui/package.json apps/helsinki-kartta/ui/pnpm-lock.yaml ./apps/helsinki-kartta/ui/
COPY apps/helsinki-data/ui/package.json apps/helsinki-data/ui/pnpm-lock.yaml ./apps/helsinki-data/ui/
COPY apps/bike-stations/ui/package.json apps/bike-stations/ui/pnpm-lock.yaml ./apps/bike-stations/ui/
COPY apps/praha-mesto/ui/package.json apps/praha-mesto/ui/pnpm-lock.yaml ./apps/praha-mesto/ui/
COPY apps/zilina-mapa/ui/package.json apps/zilina-mapa/ui/pnpm-lock.yaml ./apps/zilina-mapa/ui/
COPY apps/zilina-ukazovatele/ui/package.json apps/zilina-ukazovatele/ui/pnpm-lock.yaml ./apps/zilina-ukazovatele/ui/
COPY apps/zilina-zaznamy/ui/package.json apps/zilina-zaznamy/ui/pnpm-lock.yaml ./apps/zilina-zaznamy/ui/
COPY apps/zilina-vyskum/ui/package.json apps/zilina-vyskum/ui/pnpm-lock.yaml ./apps/zilina-vyskum/ui/
RUN corepack enable && cd sdk && pnpm install --frozen-lockfile \
    && cd ../apps/bbsk-ukazovatele/ui && pnpm install --frozen-lockfile \
    && cd ../../banskabystrica-zaznamy/ui && pnpm install --frozen-lockfile \
    && cd ../../bbsk-zaznamy/ui && pnpm install --frozen-lockfile \
    && cd ../../banskabystrica-ovzdusie/ui && pnpm install --frozen-lockfile \
    && cd ../../banskabystrica-mapa/ui && pnpm install --frozen-lockfile \
    && cd ../../banskabystrica-data/ui && pnpm install --frozen-lockfile \
    && cd ../../banskabystrica-skoly/ui && pnpm install --frozen-lockfile \
    && cd ../../bbsk-mapa/ui && pnpm install --frozen-lockfile \
    && cd ../../bbsk-data/ui && pnpm install --frozen-lockfile \
    && cd ../../bbsk-mosty/ui && pnpm install --frozen-lockfile \
    && cd ../../praha-mapa/ui && pnpm install --frozen-lockfile \
    && cd ../../praha-data/ui && pnpm install --frozen-lockfile \
    && cd ../../praha-odpad/ui && pnpm install --frozen-lockfile \
    && cd ../../helsinki-kartta/ui && pnpm install --frozen-lockfile \
    && cd ../../helsinki-data/ui && pnpm install --frozen-lockfile \
    && cd ../../bike-stations/ui && pnpm install --frozen-lockfile \
    && cd ../../praha-mesto/ui && pnpm install --frozen-lockfile \
    && cd ../../zilina-mapa/ui && pnpm install --frozen-lockfile \
    && cd ../../zilina-ukazovatele/ui && pnpm install --frozen-lockfile \
    && cd ../../zilina-zaznamy/ui && pnpm install --frozen-lockfile \
    && cd ../../zilina-vyskum/ui && pnpm install --frozen-lockfile
COPY sdk/ ./sdk/
COPY apps/bbsk-ukazovatele/ui/ ./apps/bbsk-ukazovatele/ui/
COPY apps/banskabystrica-zaznamy/ui/ ./apps/banskabystrica-zaznamy/ui/
COPY apps/bbsk-zaznamy/ui/ ./apps/bbsk-zaznamy/ui/
COPY apps/banskabystrica-ovzdusie/ui/ ./apps/banskabystrica-ovzdusie/ui/
COPY apps/banskabystrica-mapa/ui/ ./apps/banskabystrica-mapa/ui/
COPY apps/banskabystrica-data/ui/ ./apps/banskabystrica-data/ui/
COPY apps/banskabystrica-skoly/ui/ ./apps/banskabystrica-skoly/ui/
COPY apps/bbsk-mapa/ui/ ./apps/bbsk-mapa/ui/
COPY apps/bbsk-data/ui/ ./apps/bbsk-data/ui/
COPY apps/bbsk-mosty/ui/ ./apps/bbsk-mosty/ui/
COPY apps/praha-mapa/ui/ ./apps/praha-mapa/ui/
COPY apps/praha-data/ui/ ./apps/praha-data/ui/
COPY apps/praha-odpad/ui/ ./apps/praha-odpad/ui/
COPY apps/helsinki-kartta/ui/ ./apps/helsinki-kartta/ui/
COPY apps/helsinki-data/ui/ ./apps/helsinki-data/ui/
COPY apps/bike-stations/ui/ ./apps/bike-stations/ui/
COPY apps/praha-mesto/ui/ ./apps/praha-mesto/ui/
COPY apps/zilina-mapa/ui/ ./apps/zilina-mapa/ui/
COPY apps/zilina-ukazovatele/ui/ ./apps/zilina-ukazovatele/ui/
COPY apps/zilina-zaznamy/ui/ ./apps/zilina-zaznamy/ui/
COPY apps/zilina-vyskum/ui/ ./apps/zilina-vyskum/ui/
COPY scripts/app-integrity.mjs ./scripts/
RUN cd apps/bbsk-ukazovatele/ui && pnpm build \
    && mkdir -p /srv/apps && cp -r dist /srv/apps/bbsk-ukazovatele \
    && node /work/scripts/app-integrity.mjs /srv/apps/bbsk-ukazovatele
RUN cd apps/banskabystrica-zaznamy/ui && pnpm build \
    && cp -r dist /srv/apps/banskabystrica-zaznamy \
    && node /work/scripts/app-integrity.mjs /srv/apps/banskabystrica-zaznamy
RUN cd apps/bbsk-zaznamy/ui && pnpm build \
    && cp -r dist /srv/apps/bbsk-zaznamy \
    && node /work/scripts/app-integrity.mjs /srv/apps/bbsk-zaznamy
RUN cd apps/banskabystrica-ovzdusie/ui && pnpm build \
    && cp -r dist /srv/apps/banskabystrica-ovzdusie \
    && node /work/scripts/app-integrity.mjs /srv/apps/banskabystrica-ovzdusie
RUN cd apps/banskabystrica-mapa/ui && pnpm build \
    && cp -r dist /srv/apps/banskabystrica-mapa \
    && node /work/scripts/app-integrity.mjs /srv/apps/banskabystrica-mapa
RUN cd apps/banskabystrica-data/ui && pnpm build \
    && cp -r dist /srv/apps/banskabystrica-data \
    && node /work/scripts/app-integrity.mjs /srv/apps/banskabystrica-data
RUN cd apps/banskabystrica-skoly/ui && pnpm build \
    && cp -r dist /srv/apps/banskabystrica-skoly \
    && node /work/scripts/app-integrity.mjs /srv/apps/banskabystrica-skoly
RUN cd apps/bbsk-mapa/ui && pnpm build \
    && cp -r dist /srv/apps/bbsk-mapa \
    && node /work/scripts/app-integrity.mjs /srv/apps/bbsk-mapa
RUN cd apps/bbsk-data/ui && pnpm build \
    && cp -r dist /srv/apps/bbsk-data \
    && node /work/scripts/app-integrity.mjs /srv/apps/bbsk-data
RUN cd apps/bbsk-mosty/ui && pnpm build \
    && cp -r dist /srv/apps/bbsk-mosty \
    && node /work/scripts/app-integrity.mjs /srv/apps/bbsk-mosty
RUN cd apps/praha-mapa/ui && pnpm build \
    && cp -r dist /srv/apps/praha-mapa \
    && node /work/scripts/app-integrity.mjs /srv/apps/praha-mapa
RUN cd apps/praha-data/ui && pnpm build \
    && cp -r dist /srv/apps/praha-data \
    && node /work/scripts/app-integrity.mjs /srv/apps/praha-data
RUN cd apps/praha-odpad/ui && pnpm build \
    && cp -r dist /srv/apps/praha-odpad \
    && node /work/scripts/app-integrity.mjs /srv/apps/praha-odpad
RUN cd apps/helsinki-kartta/ui && pnpm build \
    && cp -r dist /srv/apps/helsinki-kartta \
    && node /work/scripts/app-integrity.mjs /srv/apps/helsinki-kartta
RUN cd apps/helsinki-data/ui && pnpm build \
    && cp -r dist /srv/apps/helsinki-data \
    && node /work/scripts/app-integrity.mjs /srv/apps/helsinki-data
RUN cd apps/bike-stations/ui && pnpm build \
    && cp -r dist /srv/apps/bike-stations \
    && node /work/scripts/app-integrity.mjs /srv/apps/bike-stations
RUN cd apps/praha-mesto/ui && pnpm build \
    && cp -r dist /srv/apps/praha-mesto \
    && node /work/scripts/app-integrity.mjs /srv/apps/praha-mesto
RUN cd apps/zilina-mapa/ui && pnpm build \
    && cp -r dist /srv/apps/zilina-mapa \
    && node /work/scripts/app-integrity.mjs /srv/apps/zilina-mapa
RUN cd apps/zilina-ukazovatele/ui && pnpm build \
    && cp -r dist /srv/apps/zilina-ukazovatele \
    && node /work/scripts/app-integrity.mjs /srv/apps/zilina-ukazovatele
RUN cd apps/zilina-zaznamy/ui && pnpm build \
    && cp -r dist /srv/apps/zilina-zaznamy \
    && node /work/scripts/app-integrity.mjs /srv/apps/zilina-zaznamy
RUN cd apps/zilina-vyskum/ui && pnpm build \
    && cp -r dist /srv/apps/zilina-vyskum \
    && node /work/scripts/app-integrity.mjs /srv/apps/zilina-vyskum

FROM rust:1.97-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
# The repository is a cargo workspace whose members are the reference apps (AP-34). Cargo
# loads every member manifest before it builds anything, so `apps/` is a build input even
# though none of it reaches the image: without it the build dies on `failed to load
# manifest for workspace member /src/apps/*`.
COPY apps ./apps
# sqlx::migrate!("./migrations") reads the folder at COMPILE time, so it is a build input,
# not a runtime one: without it cargo fails with "error canonicalizing migration directory".
COPY migrations ./migrations
# The same for the apps database's own schema (src/apps/apps_db.rs, AP-149).
COPY apps_db ./apps_db
# Cargo.toml declares `[workspace] members = ["apps/*"]`, and cargo resolves every member's
# manifest before it builds anything, so without these the build dies on
# `failed to load manifest for workspace member /src/apps/*`. Their sources are needed too:
# a member's manifest is only valid if the targets it names exist.
COPY apps ./apps
COPY --from=ui /work/ui/dist ./ui/dist
COPY --from=sdk /sdk/dist ./sdk/dist
# The template every code run starts from is compiled into the binary too (src/agents/preview.rs).
COPY sdk/template ./sdk/template
# So is the gallery a run adapts when the request is of a sample's kind (src/agents/samples.rs).
COPY sdk/samples ./sdk/samples
# A code run's prompt carries the SDK's API and export list (`include_str!` in src/agents/code.rs).
COPY sdk/API.md ./sdk/API.md
COPY sdk/src/sdk/index.ts ./sdk/src/sdk/index.ts
# `-p joinedcontext-portal`: this image ships one binary and the reference apps have images of
# their own, so building the whole workspace here would compile them for nothing.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p joinedcontext-portal && \
    install -m 0755 target/release/joinedcontext-portal /joinedcontext-portal

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /joinedcontext-portal /usr/local/bin/joinedcontext-portal
COPY --from=apps /srv/apps /srv/apps
USER nonroot:nonroot
EXPOSE 8080
ENV JC_PORTAL_BIND=0.0.0.0:8080
# The bundles above; a deployment that mounts its own artifact root sets it elsewhere.
ENV JC_PORTAL_APPS_DIR=/srv/apps
ENTRYPOINT ["/usr/local/bin/joinedcontext-portal"]
