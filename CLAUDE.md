# turbo-vibe

An open-source kit that deploys a project's services from one `turbo-vibe.yaml`. This repository holds the `turbo-vibe` CLI (published as `@turbo-vibe/cli`).

Specs live outside this repo, in the OpenSpec store `turbo-vibe`; see `CLAUDE.local.md` if present.

## Commands

- `make check` — the gate for every commit: `biome ci .`, `tsc --noEmit`, `vitest run`.
- `make build` — bundles `src/cli.ts` into `dist/cli.js` with `tsup`.
- `pnpm exec vitest run test/<file>.test.ts` — one test file.
- `pnpm exec biome check --write .` — format and fix lint.

## Layout

- `src/cli.ts` — process entry; everything else is reachable through `main(argv, io)` in `src/main.ts`, which tests call directly.
- `src/config/` — the `turbo-vibe.yaml` schema (`zod`) and the loader that turns schema issues into `line: message` problems.
- `src/targets.ts` — the targets the config may name.
- `src/plan.ts` — derives what each environment runs from a validated config.
- `test/` — `vitest` tests, one file per module.

## Conventions

- TypeScript strict on Node 24, ESM, `.js` suffixes in relative imports.
- Direct dependencies are pinned to exact versions (`.npmrc` sets `save-exact`); commit `pnpm-lock.yaml`.
- Nothing external (network, child processes) runs before the config validates.
- Never print secret values; print names.
- Commits follow Conventional Commits: `feat(config): …`, `fix(plan): …`, `chore: …`.
- Comments only where the code cannot carry the reason.
