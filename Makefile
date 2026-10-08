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

TOFU_IMAGE := ghcr.io/opentofu/opentofu:1.13.1

.PHONY: validate-infra
validate-infra:
	@tmp=$$(mktemp -d "$${TMPDIR:-/tmp}/turbo-vibe-infra.XXXXXX"); trap 'rm -rf "$$tmp"' EXIT; \
	cp -R infra/. "$$tmp"; \
	for module in $$(ls "$$tmp"); do \
		echo "tofu validate infra/$$module"; \
		if command -v tofu >/dev/null; then tofu="tofu"; \
		else tofu="docker run --rm -v $$tmp/$$module:/module -w /module $(TOFU_IMAGE)"; fi; \
		(cd "$$tmp/$$module" && $$tofu init -backend=false -input=false >/dev/null && $$tofu validate) || exit 1; \
	done

ACTIONLINT_IMAGE := rhysd/actionlint:1.7.12

.PHONY: integration dry-run-example lint-workflows integration-tests
integration: validate-infra lint-workflows integration-tests dry-run-example

integration-tests:
	pnpm exec vitest run --config vitest.integration.config.ts

lint-workflows:
	@if command -v actionlint >/dev/null; then actionlint; \
	else docker run --rm -v "$(CURDIR)":/repo -w /repo $(ACTIONLINT_IMAGE) -no-color; fi

dry-run-example: build
	@tmp=$$(mktemp -d "$${TMPDIR:-/tmp}/turbo-vibe-dry-run.XXXXXX"); trap 'rm -rf "$$tmp"' EXIT; \
	cd "$$tmp" && node $(CURDIR)/dist/cli.js --config $(CURDIR)/examples/go-api/turbo-vibe.yaml \
		deploy --env staging --build-id dry-run --dry-run
