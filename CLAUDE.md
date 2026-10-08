# turbo-vibe

An open-source kit that deploys a project's services from one `turbo-vibe.yaml`. This repository holds the `turbo-vibe` CLI (published as `@turbo-vibe/cli`).

Specs live outside this repo, in the OpenSpec store `turbo-vibe`; see `CLAUDE.local.md` if present.

## Commands

- `make check` — the gate for every commit: `biome ci .`, `tsc --noEmit`, `vitest run`.
- `make build` — bundles `src/cli.ts` into `dist/cli.js` with `tsup`.
- `make integration` — `validate-infra`, `lint-workflows` (`actionlint`, local or the pinned Docker image), `integration-tests` (`test/integration/`, against real Postgres in Docker), and `dry-run-example` (a real `wrangler deploy --dry-run` of `examples/go-api`, which builds its image with Docker). Not part of `make check`.
- `make validate-infra` — `tofu init -backend=false && tofu validate` on every module under `infra/`; uses a local `tofu` if present, otherwise the pinned OpenTofu Docker image.
- `pnpm exec vitest run test/<file>.test.ts` — one test file.
- `pnpm exec biome check --write .` — format and fix lint.

## Layout

- `src/cli.ts` — process entry; everything else is reachable through `main(argv, io)` in `src/main.ts`, which tests call directly.
- `src/config/` — the `turbo-vibe.yaml` schema (`zod`) and the loader that turns schema issues into `line: message` problems.
- `src/adapters/` — one adapter per target, all behind the contract in `types.ts`; `index.ts` is the registry the config validator reads.
- `src/infrastructure.ts` — composes adapter contributions into one OpenTofu root per project and environment, with state in R2.
- `src/apply.ts` — `turbo-vibe apply`: writes the root to `.turbo-vibe/tofu/<env>/` and runs `tofu`.
- `src/deploy.ts` — `test`, `deploy`, and `smoke` across services; each adapter's `deploy` and `smoke` do the work. `deploy` hands backends runtime secrets (`DATABASE_URL` from OpenTofu outputs; `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI` from the environment) through `wrangler --secrets-file` and a `0600` file it deletes afterwards, and runs frontend builds with every kit credential removed from their environment.
- `src/adapters/wrangler.ts` — the generated Worker entry and `wrangler.json`, written to `.turbo-vibe/wrangler/<env>/<worker>/`. `wrangler` and `@cloudflare/containers` are exact-pinned dependencies resolved from turbo-vibe's own `node_modules`.
- `src/migrate.ts`, `src/database.ts` — `turbo-vibe migrate`: reads the environment's OpenTofu outputs, checks the Supabase project is awake, creates the `turbo_vibe_migrator` and `turbo_vibe_runtime` roles as `postgres`, then runs the pinned Supabase CLI's `db push` as the migrator over the session pooler.
- `src/adapters/vercel.ts` — `vercel-static` and `vercel-nextjs` (the latter runs `vercel build --prod` in `build.root` with a local `.vercel/project.json`, so no token is needed to build). `vercel-static`: Vercel project, domain and Cloudflare CNAME through OpenTofu; the CI build shipped as `.vercel/output` with the pinned Vercel CLI (`deploy --prebuilt --prod`), the project ID read from OpenTofu outputs. `src/adapters/assets.ts` holds the build, archive and restore steps both static adapters share.
- `src/origins.ts` — the hostname layout per environment: a frontend whose adapter is `crossOrigin` moves the backend to its API hostname. It computes the backend's exact allowed origins and cookie domain, the frontend's API URL, and the sign-in callback. Adapters get `hostname` (their own) and `backendHostname` in their context.
- `src/identity.ts` — before `apply`, lists the WorkOS environment's redirect URIs and decides which ones OpenTofu manages: only those the kit created or that do not exist yet.
- `src/builds.ts` — build records and asset archives in the R2 state bucket (S3 API, signed with `aws4fetch`), and `choosePromotion`. Staging `deploy` writes a record, staging `smoke` marks it, `promote` deploys a record's outputs only. Adapters' `deploy` returns `{ code, outputs }` and, given `recorded`, must not build.
- `src/check.ts`, `src/checks/` — `turbo-vibe check`: one function per vendor or concern returns findings (`ok`, `warn`, `fail` with a fix); `checksFor` picks the ones the project's targets need. Checks only read, apart from the state bucket's lock probe, which writes and deletes one object.
- `src/smoke.ts` — the build-ID check every adapter's smoke uses.
- `.github/workflows/deploy.yml` — the reusable workflow projects call; its `TURBO_VIBE_CLI` pin must equal `package.json`'s version (a test enforces it). `promote.yml` is the reusable "Deploy to production" (choose, check out that build's commit, apply, migrate, promote by build ID, smoke; no build), called by the kit's `production.yml`. `pipeline.yml` is the kit's own pipeline: its gate, then the example through `deploy.yml`, which deploys only after the gate passes.
- `docs/bootstrap.md` — the one-time account, plan, token and secret checklist; keep it in step with what `check` verifies and what adapters declare as `secrets`.
- `docs/adoption.md` — the adoption guide for an existing project; keep its config and workflow snippets in step with the schema and the reusable workflows.
- `.github/workflows/release.yml` — on a `vX.Y.Z` tag: checks that the tag, `package.json` and both reusable workflows' CLI pins agree, runs the gate, publishes `@turbo-vibe/cli` with provenance (npm trusted publishing), then moves the `vX` tag, but only when the release is the newest in its major line, so a patch to an older line never rolls adopters back. If `v*` tags are ever protected by a ruleset, allow GitHub Actions to bypass it, or the move is rejected. To release, bump `package.json` and both `TURBO_VIBE_CLI` pins together, merge, and push the tag.
- `examples/go-api/` — the example the kit deploys: a Go API and a static page served from one Worker, with a Supabase database; `/api/health` reports the build ID and the row its migration (`supabase/migrations/`) inserts. `test/integration/migrate.test.ts` runs that migration. With `ALLOWED_ORIGINS` set it refuses other origins (`cors.go`). `examples/vercel-static/` deploys a page to Vercel against the same API on Cloudflare. `examples/nextjs/` is a Next.js app with one server-rendered page; `test/integration/nextjs.test.ts` builds it with the real `vercel build`. `examples/go-api` signs users in with AuthKit (`auth.go`: `/api/auth/login`, `/api/auth/callback`, `/api/me`), tested by `auth_test.go` against a fake WorkOS token endpoint through the example's `build.test`.
- `infra/` — OpenTofu modules (`cloudflare`, `supabase`, `vercel`, `workos`), shipped in the npm package; the generated root calls one `supabase_<service>` module per database. OpenTofu owns long-lived resources (Worker entity, routes, DNS); `wrangler` ships Worker code, so modules never manage a script's content.
- `src/plan.ts` — derives what each environment runs from a validated config.
- `test/` — `vitest` unit tests, one file per module (`make check`); `test/harness.ts` holds the CLI runner and the fake R2 bucket, Docker, and runner used by `cli.test.ts` and `release.test.ts`; `test/integration/` needs Docker and runs under `make integration`.

## Conventions

- TypeScript strict on Node 24, ESM, `.js` suffixes in relative imports.
- Direct dependencies are pinned to exact versions (`.npmrc` sets `save-exact`); commit `pnpm-lock.yaml`.
- Nothing external (network, child processes) runs before the config validates. Child processes go through `io.run` (output streamed) or `io.capture` (stdout returned); Postgres goes through `io.sql`. Tests fake them.
- Never print secret values; print names.
- Tests fake the outside world through `Io` (`src/io.ts`): `run`, `capture`, `fetch`, `sleep`, `sql`.
- Workflow actions are pinned by commit SHA with the tag in a comment.
- Commits follow Conventional Commits: `feat(config): …`, `fix(plan): …`, `chore: …`.
- Comments only where the code cannot carry the reason.
