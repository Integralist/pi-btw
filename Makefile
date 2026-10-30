# pi-btw — development tasks.

.DEFAULT_GOAL := help
.PHONY: help install test watch typecheck host-check verify try clean

PI ?= pi

help: ## List the available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

test: ## Run the test suite once
	npx vitest --run

watch: ## Run the test suite and re-run it on every change
	npx vitest

typecheck: ## Check types without emitting anything
	npx tsc --noEmit

host-check: ## Run the multi-host compatibility matrix
	node ./tests/btw.host-matrix.mjs

verify: test typecheck ## Run test and typecheck

try: ## Open a pi session with this extension loaded, for a live walkthrough
	$(PI) -ne -e ./extensions/btw.ts

clean: ## Remove build output and test scratch
	rm -rf dist node_modules/.vite
