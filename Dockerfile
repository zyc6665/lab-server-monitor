# syntax=docker/dockerfile:1

FROM python:3.11-slim
# TODO(pin): base image is still tag-based, not digest-pinned. Pin with
# `FROM python:3.11-slim@sha256:<digest>` after verifying a real digest for the
# exact platform(s) we publish. A fabricated digest is worse than a floating tag,
# so the tag is kept intentionally until a digest is confirmed.

ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SUPERCRONIC_VERSION=v0.2.32 \
    APP_UID=10001 \
    APP_GID=10001 \
    DEFAULT_TZ=Asia/Shanghai

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

# supercronic v0.2.32 integrity check (fail-closed).
# amd64/arm64: SHA256 computed from the official release binaries (sha1sum of the
#              same files matches the publisher checksum, confirming authenticity).
# arm:         publisher only ships a SHA1 for this arch, so keep the SHA1 check
#              and a TODO to move to SHA256 when one is published.
# TODO(arm): replace the arm SHA1 below with a verified SHA256 when available.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) supercronic_bin="supercronic-linux-amd64"; supercronic_hash="023a6aff43a5a7eb8d7e61c6dd7495bed243c5b3ab74c9075c04953bea0297d3"; hash_algo="sha256" ;; \
      arm64) supercronic_bin="supercronic-linux-arm64"; supercronic_hash="86af00fbacaa12b83efef409db23c8f6cb05248ebee986aa1ea28750e4267198"; hash_algo="sha256" ;; \
      arm) supercronic_bin="supercronic-linux-arm"; supercronic_hash="fe4f85bfb08631189ee8a20fae02294d90856aa7"; hash_algo="sha1" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo "/tmp/${supercronic_bin}" "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/${supercronic_bin}"; \
    echo "${supercronic_hash}  /tmp/${supercronic_bin}" | "${hash_algo}sum" -c -; \
    install -m 0755 "/tmp/${supercronic_bin}" /usr/local/bin/supercronic; \
    rm -f "/tmp/${supercronic_bin}"

COPY pyproject.toml README.md /app/
COPY servermanage /app/servermanage
COPY docker /app/docker

RUN pip install . \
    && chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /etc/supercronic /app/ssh /app/data

# Bake the default timezone at build time. The container runs as a non-root user
# that cannot rewrite /etc/localtime at runtime, so the default must be present
# in the image; the entrypoint still honours a TZ override via the TZ env var.
RUN ln -snf "/usr/share/zoneinfo/${DEFAULT_TZ}" /etc/localtime \
    && echo "${DEFAULT_TZ}" > /etc/timezone

# Create an unprivileged runtime user and hand it ownership of everything it
# must write (application dir incl. data/ssh, and the supercronic crontab dir).
RUN groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid app --home-dir /app --no-create-home --shell /usr/sbin/nologin app \
    && chown -R app:app /app /etc/supercronic

USER app

# This container runs scheduled report jobs via supercronic (there is no HTTP
# server listening), so a liveness check of the scheduler is the meaningful
# health signal. Once the crontab has been generated the entrypoint execs
# supercronic as PID 1; a missing crontab or a dead/replaced PID 1 = unhealthy.
# NOTE: if this image is later switched to serve the dashboard, probe the app
#       health endpoint instead, e.g. curl -fsS http://127.0.0.1:8080/api/system/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["bash", "-c", "test -f /etc/supercronic/servermanage.crontab && grep -q '^supercronic$' /proc/1/comm"]

ENTRYPOINT ["/app/docker/entrypoint.sh"]
