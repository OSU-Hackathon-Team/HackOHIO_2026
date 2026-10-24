FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends podman uidmap fuse-overlayfs slirp4netns \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
ENV PYTHONUNBUFFERED=1
CMD ["python", "launch.py", "--help"]
