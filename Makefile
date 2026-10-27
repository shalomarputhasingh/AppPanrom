PYTHON ?= python3

.PHONY: setup test test-backend test-runtime test-frontend e2e dev-backend dev-frontend build serve

setup:
	pip install -r backend/requirements-dev.txt
	cd frontend && npm install

test: test-backend test-runtime test-frontend

test-backend:
	cd backend && $(PYTHON) -m pytest -q

test-runtime:
	cd runtime && node --test test/*.test.mjs

test-frontend:
	cd frontend && npm run typecheck && npm test

e2e: build
	cd frontend && node e2e/run.mjs

dev-backend:
	cd backend && uvicorn apppanrom.main:create_app --factory --reload --port 8000

dev-frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

# Single-process mode: the backend serves the built Studio at http://127.0.0.1:8000
serve: build
	cd backend && uvicorn apppanrom.main:create_app --factory --port 8000
