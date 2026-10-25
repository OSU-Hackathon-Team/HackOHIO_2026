FROM docker.io/library/debian:bookworm-slim

LABEL org.opencontainers.image.title="Splice cleanroom implementer"
LABEL org.opencontainers.image.description="Public-only C implementation sandbox; no original binary or analysis state."

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates coreutils diffutils file jq python3 \
    && rm -rf /var/lib/apt/lists/*

# OpenCode is mounted read-only at run time; this directory only holds its auth file.
RUN mkdir -p /root/.local/share/opencode /cleanroom

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /cleanroom
CMD ["/bin/bash"]
