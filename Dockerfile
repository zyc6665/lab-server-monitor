FROM python:3.11-slim

ARG TARGETARCH

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SUPERCRONIC_VERSION=v0.2.32

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*

# Verified against the official supercronic release page:
# https://github.com/aptible/supercronic/releases
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) supercronic_bin="supercronic-linux-amd64"; supercronic_sha1="7da26ce6ab48d75e97f7204554afe7c80779d4e0" ;; \
      arm64) supercronic_bin="supercronic-linux-arm64"; supercronic_sha1="7f89438e7810669d3e0ea488a202aaf422cc2fdf" ;; \
      arm) supercronic_bin="supercronic-linux-arm"; supercronic_sha1="fe4f85bfb08631189ee8a20fae02294d90856aa7" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo "/tmp/${supercronic_bin}" "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/${supercronic_bin}"; \
    echo "${supercronic_sha1}  /tmp/${supercronic_bin}" | sha1sum -c -; \
    install -m 0755 "/tmp/${supercronic_bin}" /usr/local/bin/supercronic; \
    rm -f "/tmp/${supercronic_bin}"

COPY pyproject.toml README.md /app/
COPY servermanage /app/servermanage
COPY docker /app/docker

RUN pip install . \
    && chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /etc/supercronic /app/ssh

ENTRYPOINT ["/app/docker/entrypoint.sh"]
