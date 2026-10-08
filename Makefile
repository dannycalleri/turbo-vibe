.PHONY: check lint typecheck test build

check: lint typecheck test

lint:
	pnpm exec biome ci .

typecheck:
	pnpm exec tsc --noEmit

test:
	pnpm exec vitest run

build:
	pnpm exec tsup
