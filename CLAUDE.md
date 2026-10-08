# turbo-vibe

An open-source kit that deploys a project's services from one `turbo-vibe.yaml`. This repository holds the `turbo-vibe` CLI (published as `@turbo-vibe/cli`).

Specs live outside this repo, in the OpenSpec store `turbo-vibe`; see `CLAUDE.local.md` if present.

## Commands

- `make check` — the gate for every commit: `biome ci .`, `tsc --noEmit`, `vitest run`.
- `make build` — bundles `src/cli.ts` into `dist/cli.js` with `tsup`.
- `make integration` — `validate-infra`, `lint-workflows` (`actionlint`, local or the pinned Docker image), and `dry-run-example` (a real `wrangler deploy --dry-run` of `examples/go-api`, which builds its image with Docker). Not part of `make check`.
- `make validate-infra` — `tofu init -backend=false && tofu validate` on every module under `infra/`; uses a local `tofu` if present, otherwise the pinned OpenTofu Docker image.
- `pnpm exec vitest run test/<file>.test.ts` — one test file.
- `pnpm exec biome check --write .` — format and fix lint.

## Layout

- `src/cli.ts` — process entry; everything else is reachable through `main(argv, io)` in `src/main.ts`, which tests call directly.
- `src/config/` — the `turbo-vibe.yaml` schema (`zod`) and the loader that turns schema issues into `line: message` problems.
- `src/adapters/` — one adapter per target, all behind the contract in `types.ts`; `index.ts` is the registry the config validator reads.
- `src/infrastructure.ts` — composes adapter contributions into one OpenTofu root per project and environment, with state in R2.
- `src/apply.ts` — `turbo-vibe apply`: writes the root to `.turbo-vibe/tofu/<env>/` and runs `tofu`.
- `src/deploy.ts` — `test`, `deploy`, and `smoke` across services; each adapter's `deploy` and `smoke` do the work.
- `src/adapters/wrangler.ts` — the generated Worker entry and `wrangler.json`, written to `.turbo-vibe/wrangler/<env>/<worker>/`. `wrangler` and `@cloudflare/containers` are exact-pinned dependencies resolved from turbo-vibe's own `node_modules`.
- `src/smoke.ts` — the build-ID check every adapter's smoke uses.
- `.github/workflows/deploy.yml` — the reusable workflow projects call; its `TURBO_VIBE_CLI` pin must equal `package.json`'s version (a test enforces it). `pipeline.yml` is the kit's own pipeline: its gate, then the example through `deploy.yml`, which deploys only after the gate passes.
- `examples/go-api/` — the example the kit deploys: a Go API and a static page served from one Worker.
- `infra/` — OpenTofu modules (`cloudflare`, `supabase`), shipped in the npm package; the generated root calls one `supabase_<service>` module per database. OpenTofu owns long-lived resources (Worker entity, routes, DNS); `wrangler` ships Worker code, so modules never manage a script's content.
- `src/plan.ts` — derives what each environment runs from a validated config.
- `test/` — `vitest` tests, one file per module.

## Conventions

- TypeScript strict on Node 24, ESM, `.js` suffixes in relative imports.
- Direct dependencies are pinned to exact versions (`.npmrc` sets `save-exact`); commit `pnpm-lock.yaml`.
- Nothing external (network, child processes) runs before the config validates. Child processes go through `io.run` so tests can fake them.
- Never print secret values; print names.
- Tests fake the outside world through `Io` (`src/io.ts`): `run`, `fetch`, `sleep`.
- Workflow actions are pinned by commit SHA with the tag in a comment.
- Commits follow Conventional Commits: `feat(config): …`, `fix(plan): …`, `chore: …`.
- Comments only where the code cannot carry the reason.
