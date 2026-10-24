FROM docker.io/library/eclipse-temurin:21-jdk-noble

ARG GHIDRA_VERSION=12.1.3
ARG GHIDRA_DATE=20260817
ARG GHIDRA_SHA256=93a5d11a9ad510622acaaf908c556a7b9b764d338e78a7567f3689bf5081fd54
ARG GHIDRA_MCP_COMMIT=f3af083c339709ed2243d57b7ca56354ff12a117

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip curl unzip git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fL --retry 3 -o /tmp/ghidra.zip \
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip" \
    && echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum -c - \
    && unzip -q /tmp/ghidra.zip -d /opt \
    && rm /tmp/ghidra.zip

ENV GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.3_PUBLIC
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && git clone https://github.com/mrphrazer/ghidra-headless-mcp.git /opt/ghidra-headless-mcp \
    && cd /opt/ghidra-headless-mcp \
    && git checkout "${GHIDRA_MCP_COMMIT}" \
    && /opt/venv/bin/pip install --no-cache-dir . 'openai-agents==0.24.0' 'pyghidra==3.2.0'

ENV PATH=/opt/venv/bin:$PATH
ENV JAVA_TOOL_OPTIONS=-Djava.awt.headless=true
WORKDIR /app
COPY agent_worker.py /app/
CMD ["python", "agent_worker.py", "--help"]
