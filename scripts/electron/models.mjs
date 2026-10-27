/** Role-based model routing for the Electron reconstruction agent.
 *
 * The agent is a worker: its model comes from root models.json, never from a literal in the
 * pipeline. MODEL_<ROLE> overrides win, matching packages/backend/src/models.ts and model_config.py.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const MODELS = fileURLToPath(new URL("../../models.json", import.meta.url));

export function resolveModel(role = "electron_reconstructor", explicit = null) {
  if (explicit) return explicit;
  const override = process.env[`MODEL_${role.toUpperCase()}`];
  if (override) return override;
  const models = JSON.parse(fs.readFileSync(MODELS, "utf8"));
  const id = models.roles?.[role] ?? models.default;
  if (!id) throw new Error(`No model configured for role ${role} in models.json`);
  return id;
}

/** AWS_* values from the repo .env, without exposing anything else. */
export function awsEnvironment(envFiles) {
  const values = {};
  for (const file of envFiles) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = /^(AWS_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      let value = match[2].trim();
      if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'"))
        value = value.slice(1, -1);
      if (value && !(match[1] in values)) values[match[1]] = value;
    }
  }
  return values;
}
