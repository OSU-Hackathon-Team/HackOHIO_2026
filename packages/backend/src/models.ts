import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Backend is ESM: derive __dirname from import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FALLBACK_MODEL = "amazon-bedrock/deepseek.v3.2";

export type ModelRole = "decomp_worker" | "spec_writer" | "legal_verification";

export interface ModelsConfig {
  default: string;
  roles: Record<string, string>;
}

function configPath(): string {
  const override = process.env.MODELS_JSON ?? process.env.MODEL_CONFIG;
  if (override) return override;
  // src/models.ts -> packages/backend/src -> repo root is ../../..
  return path.resolve(__dirname, "../../../models.json");
}

let cache: { path: string; config: ModelsConfig } | null = null;

export function loadModelsConfig(): ModelsConfig {
  const file = configPath();
  if (cache && cache.path === file) return cache.config;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      default?: unknown;
      roles?: unknown;
    };
    const roles =
      raw.roles && typeof raw.roles === "object"
        ? (raw.roles as Record<string, string>)
        : {};
    const config: ModelsConfig = {
      default:
        typeof raw.default === "string" && raw.default.length > 0
          ? raw.default
          : FALLBACK_MODEL,
      roles,
    };
    cache = { path: file, config };
    return config;
  } catch {
    const config: ModelsConfig = { default: FALLBACK_MODEL, roles: {} };
    cache = { path: file, config };
    return config;
  }
}

export function roleEnvVar(role: string): string {
  return `MODEL_${role.toUpperCase().replace(/-/g, "_")}`;
}

/** Resolution order: explicit > MODEL_<ROLE> > models.json role > OPENCODE_MODEL > models.json default. */
export function getModel(role: string, explicit?: string | null): string {
  if (explicit) return explicit;
  const config = loadModelsConfig();
  const envHit = process.env[roleEnvVar(role)];
  if (envHit) return envHit;
  const configured = config.roles[role];
  if (configured) return configured;
  if (role === "default") {
    return process.env.OPENCODE_MODEL ?? config.default;
  }
  return process.env.OPENCODE_MODEL ?? config.default;
}

export function resolvedModelTable(): Record<string, string> {
  const config = loadModelsConfig();
  const table: Record<string, string> = {
    default: getModel("default"),
  };
  for (const role of Object.keys(config.roles)) {
    table[role] = getModel(role);
  }
  return table;
}

export function availableRoles(): string[] {
  return Object.keys(loadModelsConfig().roles).sort();
}
