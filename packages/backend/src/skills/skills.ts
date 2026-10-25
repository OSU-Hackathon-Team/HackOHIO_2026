// Owner: Eng 3 (Implementation) — UI skills the synthesis model loads for itself.
// packages/backend/skills/ holds unmodified copies of ibelick/ui-skills (MIT, see skills/LICENSE). Each skill is
// <name>/SKILL.md: frontmatter (name, description) plus markdown rules. Skills may assume tools generated apps
// lack (e.g. motion/react); the prompt tells the model that Splice's rules win on any conflict.
// The system prompt lists every skill's name and description; the model calls the load_skills tool (llm.ts
// Converse tool loop) to read the ones that fit the app, then submits its files. Repair calls reuse the skills
// that were loaded, inline, without the tool.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AssistTool } from "../engine/ports.js";

export interface Skill { name: string; description: string; body: string }
export interface SkillCatalog {
  skills: Skill[];
  /** Content hash of every skill; part of replay keys so recordings made with other skills are not reused. */
  version: string;
}

/** Bounds the prompt: each skill is a few hundred tokens. */
export const MAX_LOADED_SKILLS = 6;
export const SKILL_TOOL = "load_skills";
/** src/skills or dist/skills → packages/backend/skills */
export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

export function parseSkill(text: string, source: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${source}: missing frontmatter`);
  const lines = match[1].split(/\r?\n/);
  // Plain `key: value`, or a YAML block scalar (`key: >` / `key: |`) whose value is the indented lines below.
  const field = (key: string) => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const value = lines[at].slice(key.length + 1).trim();
    if (!/^[>|][+-]?$/.test(value)) return value.replace(/^(["'])(.*)\1$/, "$2") || undefined;
    const block: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.trim() && !/^\s/.test(l)) break;
      block.push(l.trim());
    }
    return block.join(" ").replace(/\s+/g, " ").trim() || undefined;
  };
  const name = field("name"), description = field("description");
  if (!name || !/^[a-z0-9-]+$/.test(name)) throw new Error(`${source}: name must be kebab-case`);
  if (!description) throw new Error(`${source}: missing description`);
  return { name, description, body: match[2].trim() };
}

export function loadSkillCatalog(dir = SKILLS_DIR): SkillCatalog {
  const hash = createHash("sha256");
  const skills: Skill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const skill = parseSkill(text, file);
    if (skill.name !== entry.name) throw new Error(`${file}: name "${skill.name}" must match its folder`);
    hash.update(text);
    skills.push(skill);
  }
  return { skills, version: hash.digest("hex").slice(0, 12) };
}

const format = (s: Skill) => `<skill name="${s.name}">\n${s.body}\n</skill>`;

/** Appended to the first call's system prompt: the catalog the model chooses from. */
export function skillCatalogPrompt(catalog: SkillCatalog): string {
  return `# Skills
A catalog of UI skills is available. Each one is a short set of rules for a kind of interface. Before writing files, call the "${SKILL_TOOL}" tool with the skills that fit this app (usually 3 to ${MAX_LOADED_SKILLS}, most important first) and follow them. Where a skill conflicts with the rules above, the rules above win.

<catalog>
${catalog.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}
</catalog>`;
}

/** Repair calls: the skills the model already loaded, inline. */
export function withSkills(system: string, skills: Skill[]): string {
  if (!skills.length) return system;
  return `${system}

# Skills
You loaded these skills for this app. Keep following them. Where a skill conflicts with the rules above, the rules above win.

${skills.map(format).join("\n\n")}`;
}

const Input = z.object({ names: z.array(z.string()).min(1) });

/** The load_skills tool. Loaded skills are pushed onto `loaded`; `onLoad` reports each successful call. */
export function skillTool(catalog: SkillCatalog, loaded: Skill[], onLoad: (names: string[]) => void): AssistTool {
  return {
    name: SKILL_TOOL,
    description: `Read the full rules of one or more skills from the catalog in the system prompt. Load at most ${MAX_LOADED_SKILLS} skills in total.`,
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "Skill names from the catalog" } },
      required: ["names"],
      additionalProperties: false,
    },
    async run(input) {
      const parsed = Input.safeParse(input);
      if (!parsed.success) throw new Error(`Pass {"names": ["skill-name", ...]} using names from the catalog`);
      const notes: string[] = [], added: Skill[] = [];
      for (const name of [...new Set(parsed.data.names)]) {
        const skill = catalog.skills.find((s) => s.name === name);
        if (!skill) notes.push(`Unknown skill "${name}".`);
        else if (loaded.includes(skill)) notes.push(`"${name}" is already loaded.`);
        else if (loaded.length >= MAX_LOADED_SKILLS) notes.push(`Skipped "${name}": the limit of ${MAX_LOADED_SKILLS} skills is reached.`);
        else { loaded.push(skill); added.push(skill); }
      }
      if (added.length) onLoad(added.map((s) => s.name));
      if (!added.length) throw new Error(`${notes.join(" ")} Valid names: ${catalog.skills.map((s) => s.name).join(", ")}`);
      return [...added.map(format), ...notes].join("\n\n");
    },
  };
}

/**
 * Prompt and tools for a skill-aware call. The first call offers the catalog and the tool; later calls (repairs)
 * carry the loaded skills inline. Without a catalog this is a no-op.
 */
export function skillSession(base: string, catalog: SkillCatalog | undefined, report: (message: string) => void) {
  const loaded: Skill[] = [];
  let first = true;
  return {
    loaded,
    next(): { system: string; tools?: AssistTool[]; maxToolTurns?: number } {
      if (!catalog?.skills.length) return { system: base };
      if (!first) return { system: withSkills(base, loaded) };
      first = false;
      return {
        system: `${base}\n\n${skillCatalogPrompt(catalog)}`,
        tools: [skillTool(catalog, loaded, (names) => report(`Loaded UI skills: ${names.join(", ")}`))],
        maxToolTurns: 3,
      };
    },
  };
}
