#!/usr/bin/env bash
#
# deploy.sh — build and deploy html-comments.
#
# Usage:
#   ./deploy.sh build                 Build the Docker image
#   ./deploy.sh run [<html-dir>]      Build + run locally with Docker (default dir: ./html)
#   ./deploy.sh push                  Build + push the image to a registry (set REGISTRY)
#   ./deploy.sh helm                  Install/upgrade the Helm release
#   ./deploy.sh helm-uninstall        Uninstall the Helm release
#
# Configuration (environment variables):
#   IMAGE      Image name                   (default: html-comments)
#   TAG        Image tag                    (default: git short SHA, or "latest")
#   REGISTRY   Registry prefix for push, e.g. ghcr.io/olson-eric (required for push)
#   PORT       Host port for `run`          (default: 4747)
#   UPLOADS_ENABLED        For `run`: enable the upload/rename/archive API and
#                          mount the content dir writable (default: off, ro)
#   UPLOAD_MAX_BYTES       For `run`: upload size cap passthrough
#   TRUST_IDENTITY_HEADER  For `run`: identity header passthrough
#   RELEASE    Helm release name            (default: html-comments)
#   NAMESPACE  Kubernetes namespace         (default: html-comments)
#   HELM_ARGS  Extra args appended to helm upgrade, e.g. "-f my-values.yaml"

set -euo pipefail
cd "$(dirname "$0")"

IMAGE=${IMAGE:-html-comments}
TAG=${TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo latest)}
PORT=${PORT:-4747}
RELEASE=${RELEASE:-html-comments}
NAMESPACE=${NAMESPACE:-html-comments}
CHART=deploy/helm/html-comments

full_image() {
  if [ -n "${REGISTRY:-}" ]; then
    echo "${REGISTRY%/}/${IMAGE}:${TAG}"
  else
    echo "${IMAGE}:${TAG}"
  fi
}

build() {
  docker build -t "$(full_image)" .
  echo "Built $(full_image)"
}

run() {
  build
  local html_dir
  html_dir=$(cd "${1:-./html}" && pwd) || { echo "html dir not found: ${1:-./html}" >&2; exit 1; }
  # Writable mode: UPLOADS_ENABLED=1 mounts the content dir rw and passes the
  # upload/identity env through, so publishing and rename/archive work.
  local mode=ro
  local envargs=()
  if [ -n "${UPLOADS_ENABLED:-}" ]; then
    mode=rw
    envargs+=(-e "UPLOADS_ENABLED=${UPLOADS_ENABLED}")
  fi
  [ -n "${UPLOAD_MAX_BYTES:-}" ] && envargs+=(-e "UPLOAD_MAX_BYTES=${UPLOAD_MAX_BYTES}")
  [ -n "${TRUST_IDENTITY_HEADER:-}" ] && envargs+=(-e "TRUST_IDENTITY_HEADER=${TRUST_IDENTITY_HEADER}")
  echo "Serving ${html_dir} (${mode}) on http://localhost:${PORT}"
  docker run --rm --init \
    -p "${PORT}:4747" \
    ${envargs[@]+"${envargs[@]}"} \
    -v "${html_dir}:/content:${mode}" \
    -v html-comments-data:/comments \
    "$(full_image)"
}

push() {
  [ -n "${REGISTRY:-}" ] || { echo "Set REGISTRY to push (e.g. REGISTRY=ghcr.io/olson-eric)" >&2; exit 1; }
  build
  docker push "$(full_image)"
  echo "Pushed $(full_image)"
  # Also publish :latest as a convenience alias; the SHA tag stays primary.
  if [ "$TAG" != "latest" ]; then
    local latest="${REGISTRY%/}/${IMAGE}:latest"
    docker tag "$(full_image)" "$latest"
    docker push "$latest"
    echo "Pushed $latest"
  fi
}

helm_deploy() {
  local repo="${IMAGE}"
  [ -n "${REGISTRY:-}" ] && repo="${REGISTRY%/}/${IMAGE}"
  # shellcheck disable=SC2086
  helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" --create-namespace \
    --set image.repository="$repo" \
    --set image.tag="$TAG" \
    ${HELM_ARGS:-}
}

helm_uninstall() {
  helm uninstall "$RELEASE" --namespace "$NAMESPACE"
}

case "${1:-}" in
  build)          build ;;
  run)            shift; run "$@" ;;
  push)           push ;;
  helm)           helm_deploy ;;
  helm-uninstall) helm_uninstall ;;
  *)
    sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
