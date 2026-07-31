# Convenience targets for local development and deployment.
# All knobs are env vars: HTML_DIR, PORT, UPLOADS_ENABLED, UPLOAD_MAX_BYTES,
# TRUST_IDENTITY_HEADER, REGISTRY, TAG, ... (see README and ./deploy.sh).

HTML_DIR ?= ./html

.PHONY: help test run run-writable docker-build docker-run docker-run-writable compose-up compose-up-writable compose-down

help:
	@echo "make test                 Run the test suite"
	@echo "make run                  Serve HTML_DIR (default ./html) with node, read-only"
	@echo "make run-writable         Same, with uploads/rename/archive enabled"
	@echo "make docker-build         Build the Docker image"
	@echo "make docker-run           Build + run in Docker, read-only content mount"
	@echo "make docker-run-writable  Build + run in Docker with uploads enabled (rw mount)"
	@echo "make compose-up           docker compose up, read-only"
	@echo "make compose-up-writable  docker compose up with uploads enabled (rw mount)"
	@echo "make compose-down         docker compose down"

test:
	npm test

run:
	node server.js $(HTML_DIR)

run-writable:
	UPLOADS_ENABLED=1 node server.js $(HTML_DIR)

docker-build:
	./deploy.sh build

docker-run:
	./deploy.sh run $(HTML_DIR)

docker-run-writable:
	UPLOADS_ENABLED=1 ./deploy.sh run $(HTML_DIR)

compose-up:
	docker compose up -d

compose-up-writable:
	UPLOADS_ENABLED=1 CONTENT_MODE=rw docker compose up -d

compose-down:
	docker compose down
