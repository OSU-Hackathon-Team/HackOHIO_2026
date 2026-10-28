FROM docker.io/library/node:26.12.1-bookworm-slim AS rea-node
FROM docker.io/library/eclipse-temurin:25-jdk-noble

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
    && /opt/venv/bin/pip install --no-cache-dir . 'openai-agents==0.24.0' 'pyghidra==3.2.0' 'boto3==1.43.104'

# LibreOffice target for scripts/lo_pipeline.py: Calc without a GUI, its UNO Python bridge,
# binutils (nm for companion symbols), Node for REA, Frida for runtime triage.
# Ubuntu noble's nodejs is 18.x; REA requires Node >=22.19.0.
COPY --from=rea-node /usr/local/bin/node /usr/local/bin/node
COPY --from=rea-node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
ARG REA_VERSION=6.7.0
ARG OPENCODE_VERSION=1.19.4
ARG LO_DEBUG_SYMBOLS=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-calc-nogui python3-uno binutils gdb ubuntu-dbgsym-keyring \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "rea-agents@${REA_VERSION}" "opencode-ai@${OPENCODE_VERSION}" \
    && /opt/venv/bin/pip install --no-cache-dir 'frida==17.2.17' \
    && python3 -m venv /opt/frida-venv \
    && /opt/frida-venv/bin/pip install --no-cache-dir 'frida==17.2.17' 'frida-tools==14.4.5'
# Symbols turn Ghidra's FUN_* into ScInterpreter::ScMul. ddebs can lag security updates; if
# the versions do not match, lo_paths.py reports "no debug file" instead of failing the build.
# The hash query avoids a cached ddebs 503; verify the payload against the signed APT index.
RUN if [ "$LO_DEBUG_SYMBOLS" = "1" ]; then \
      echo "deb http://ddebs.ubuntu.com noble main universe" > /etc/apt/sources.list.d/ddebs.list \
      && echo "deb http://ddebs.ubuntu.com noble-updates main universe" >> /etc/apt/sources.list.d/ddebs.list \
      && apt-get update \
      && (debug_package="libreoffice-calc-nogui-dbgsym=$(dpkg-query -W -f='${Version}' libreoffice-calc-nogui)" \
          && debug_path=$(apt-cache show "$debug_package" | sed -n 's/^Filename: //p' | head -n 1) \
          && debug_sha=$(apt-cache show "$debug_package" | sed -n 's/^SHA256: //p' | head -n 1) \
          && test -n "$debug_path" && test -n "$debug_sha" \
          && curl -fL --retry 3 --retry-all-errors --max-time 1200 \
              "http://ddebs.ubuntu.com/${debug_path}?sha256=${debug_sha}" -o /tmp/lo-debug.deb \
          && echo "${debug_sha}  /tmp/lo-debug.deb" | sha256sum -c - \
          && apt-get install -y --no-install-recommends /tmp/lo-debug.deb \
          && rm /tmp/lo-debug.deb \
          || echo "warning: LibreOffice debug symbols unavailable for this version") \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV REA_COMMAND="rea-agents mcp" \
    REA_GHIDRA_STARTUP_TIMEOUT_MS=600000 \
    LO_PYTHON=/usr/bin/python3 \
    OPENCODE_BIN=/usr/local/bin/opencode \
    SAL_USE_VCLPLUGIN=svp

ENV PATH=/opt/venv/bin:/opt/frida-venv/bin:$PATH
ENV JAVA_TOOL_OPTIONS=-Djava.awt.headless=true
WORKDIR /app
COPY agent_worker.py /app/
CMD ["python", "agent_worker.py", "--help"]
