FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git build-essential pkg-config python3 python3-pip \
    python3-venv python3-tk xvfb xauth xdotool scrot file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
