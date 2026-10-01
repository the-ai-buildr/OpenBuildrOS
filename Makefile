SHELL := /bin/bash
.DEFAULT_GOAL := help
COMPOSE := docker compose
E2E := docker compose -p openbuildros-e2e -f docker-compose.yml -f docker-compose.e2e.yml
E2E_ENV := DB_PASSWORD=e2e OS_SECURITY_KEY=e2e-key COMPUTER_TOKEN=e2e-computer SUPERVISOR_TOKEN=e2e-supervisor \
	UI_USERNAME=e2e-user UI_PASSWORD=e2e FRONTEND_PORT=3100 BACKEND_PORT=8100

.PHONY: help
help: ## Show available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "\033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: env
env: ## Create .env from .env.example with generated secrets (keeps an existing .env)
	@if [ -f .env ]; then echo ".env already exists."; exit 0; fi; \
	sed -e "s/^OS_SECURITY_KEY=$$/OS_SECURITY_KEY=$$(openssl rand -hex 32)/" \
	    -e "s/^COMPUTER_TOKEN=$$/COMPUTER_TOKEN=$$(openssl rand -hex 32)/" \
	    -e "s/^SUPERVISOR_TOKEN=$$/SUPERVISOR_TOKEN=$$(openssl rand -hex 32)/" \
	    -e "s/^DB_PASSWORD=$$/DB_PASSWORD=$$(openssl rand -hex 16)/" .env.example > .env; \
	echo "Created .env. Add your OPENROUTER_API_KEY (and a UI_PASSWORD) before 'make up'."

.PHONY: build
build: ## Build the Docker images (including the per-bot computer image)
	$(COMPOSE) --profile shared-computer build

.PHONY: up
up: build ## Start the stack in the background (http://localhost:3000)
	$(COMPOSE) up -d --wait

.PHONY: down
down: ## Stop the stack (data is kept)
	$(COMPOSE) down

.PHONY: logs
logs: ## Follow logs for all services
	$(COMPOSE) logs -f

.PHONY: ps
ps: ## Show service status and health
	$(COMPOSE) ps

.PHONY: clean
clean: ## Stop the stack and DELETE its database volume
	$(COMPOSE) down -v --remove-orphans

.PHONY: install
install: ## Install backend (.venv, incl. the computer service) and frontend dev dependencies locally
	cd backend && python3 -m venv .venv && .venv/bin/pip install -q -r requirements-dev.txt docker \
	  && .venv/bin/playwright install chromium
	cd frontend && npm ci --no-audit --no-fund

.PHONY: dev-backend
dev-backend: ## Run the backend with reload on :8000 (SQLite, RUNTIME_ENV=dev)
	cd backend && set -a && { [ -f ../.env ] && source ../.env || true; } && set +a && \
	RUNTIME_ENV=dev DATABASE_URL= .venv/bin/uvicorn app.main:app --reload

.PHONY: dev-frontend
dev-frontend: ## Run the UI with hot reload on :3000 against the local backend
	cd frontend && BACKEND_URL=http://localhost:8000 npm run dev

.PHONY: lint
lint: ## Lint, format-check, and type-check both apps
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy app agents tests
	cd computer && ../backend/.venv/bin/ruff check . && ../backend/.venv/bin/mypy computer.py
	cd supervisor && ../backend/.venv/bin/ruff check . && ../backend/.venv/bin/mypy supervisor.py
	cd frontend && npm run lint && npm run typecheck

.PHONY: test
test: ## Run backend and frontend unit/integration tests
	cd backend && .venv/bin/pytest
	cd computer && ../backend/.venv/bin/pytest
	cd supervisor && ../backend/.venv/bin/pytest
	cd frontend && npm test

.PHONY: lock
lock: ## Re-resolve every service's requirements.txt from its requirements.in (Python 3.12)
	for service in backend computer supervisor; do \
	  docker run --rm -v $$PWD/$$service:/w -w /w python:3.12-slim sh -c \
	    "pip install -q uv && uv pip compile requirements.in -o requirements.txt --python-version 3.12 -q"; \
	done

.PHONY: e2e
e2e: ## Build the stack against the fake model and run the Playwright journey
	$(E2E_ENV) $(E2E) --profile shared-computer build
	$(E2E_ENV) $(E2E) up -d --wait
	cd frontend && E2E_BASE_URL=http://localhost:3100 UI_USERNAME=e2e-user UI_PASSWORD=e2e npx playwright test; \
	  status=$$?; cd ..; \
	  if [ $$status -ne 0 ]; then $(E2E_ENV) $(E2E) logs --no-color | tail -200; fi; \
	  $(E2E_ENV) $(E2E) down -v; \
	  docker ps -aq --filter label=openbuildr.bot | xargs -r docker rm -f; exit $$status
