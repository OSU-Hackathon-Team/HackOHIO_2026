# ==============================================================================
# Stage 1: Base Runtime Environment
# System dependencies for REA (reverse engineering), binutils, and pre-warmed npx cache
# ==============================================================================
# rea-agents 6.7.0 requires Node ^22.19.0
FROM node:22-bookworm-slim AS base

WORKDIR /app

# Install native tools required by REA and binary analysis
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    file \
    binutils \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# 1. Install pinned rea-agents globally; the MCP server is the `mcp` subcommand (`rea-agents mcp`)
# 2. Warm the npx cache so `npx -y rea-agents@6.7.0 mcp` also works offline
RUN npm install -g rea-agents@6.7.0 \
    && npx -y rea-agents@6.7.0 --help || true

# ==============================================================================
# Stage 2: Monorepo Builder
# Installs workspace dependencies, builds packages in order, and prunes devDependencies
# ==============================================================================
FROM base AS builder

WORKDIR /app

# Copy root workspace package definitions
COPY package.json package-lock.json* ./

# Copy package manifests across all monorepo workspaces
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install the committed dependency tree across all workspaces.
RUN npm ci

# Copy source code and TypeScript project configurations
COPY tsconfig*.json ./
COPY packages/contracts ./packages/contracts
COPY packages/backend ./packages/backend
COPY packages/frontend ./packages/frontend
COPY fixtures ./fixtures
COPY targets/manifest.json ./targets/manifest.json

# Build in strict topological dependency order:
# 1. contracts (shared types & Zod schemas)
# 2. backend (Express API, REA client, agent loops)
# 3. frontend (the active App.tsx entry point; currently the chat/library workspace).
# Host dist folders are excluded by .dockerignore, so this always builds source from this checkout.
RUN npm run build --workspace=@splice/contracts \
    && npm run build --workspace=@splice/backend \
    && npm run build --workspace=@splice/frontend

# Prune devDependencies to keep production bundle small
# Root npm prune preserves hoisted modules and workspace symlinks
RUN npm prune --omit=dev

# ==============================================================================
# Stage 3: Development Target (`dev`)
# Mounted with local files via docker-compose for hot reloading
# ==============================================================================
FROM base AS dev

WORKDIR /app

# Copy package manifests
COPY package.json package-lock.json* ./
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install all dependencies including dev tooling
RUN npm ci

# Copy monorepo sources
COPY . .

# Build contracts once so dev servers can resolve @splice/contracts
RUN npm run build --workspace=@splice/contracts

ENV NODE_ENV=development
ENV PORT=3001
ENV REA_MODE=mock

# Expose backend API (3001) and frontend Vite server (5173)
EXPOSE 3001 5173

CMD ["npm", "run", "dev"]

# ==============================================================================
# Stage 4: Production Runner (`runner` - Default Unified Container)
# Inherits from `base` to preserve binutils, file, and the global rea-agents tool
# ==============================================================================
FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
ENV REA_MODE=mock

# Copy root package.json and pruned root node_modules (preserves workspace symlinks)
COPY package.json models.json ./
COPY --from=builder /app/node_modules ./node_modules

# Copy package.json and compiled dist for contracts
COPY --from=builder /app/packages/contracts/package.json ./packages/contracts/
COPY --from=builder /app/packages/contracts/dist ./packages/contracts/dist

# Copy package.json and compiled dist for backend
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
# UI skills the synthesis model chooses from (read at runtime, not compiled)
COPY --from=builder /app/packages/backend/skills ./packages/backend/skills

# Copy the same freshly built frontend; there is no separate Docker UI or mock frontend.
# Express serves it on :3001. Development uses Vite on :5173 instead.
COPY --from=builder /app/packages/frontend/package.json ./packages/frontend/
COPY --from=builder /app/packages/frontend/dist ./packages/frontend/dist

# Copy recorded fixtures and demo targets required for extraction and replay
COPY fixtures ./fixtures
COPY targets ./targets

# Backward-compatibility symlink for legacy mock references
RUN mkdir -p ./packages && ln -s /app/fixtures/_legacy_mocks ./packages/mocks || true

# Unified single-port deployment: Express serves /api/* and static Vite frontend on 3001
EXPOSE 3001

CMD ["node", "packages/backend/dist/server.js"]
