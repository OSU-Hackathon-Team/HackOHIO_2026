import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_LOADED_SKILLS, SKILL_TOOL, loadSkillCatalog, parseSkill, skillSession, skillTool, withSkills, type Skill, type SkillCatalog } from "./skills.js";
import { synthesize } from "../synthesis/synthesize.js";
import { APP, GOOD_ENGINE, LINK_ENGINE, NOTE_CARD, makeBlueprint, makeLinkSpec, makeSpec } from "../engine/testFixtures.js";
import type { LlmPort, StructuredCallOpts } from "../engine/ports.js";

const catalog: SkillCatalog = {
  version: "test",
  skills: ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta"].map((name) => ({ name, description: `${name} rules`, body: `BODY-${name}` })),
};

test("the catalog is the unmodified ui-skills set, all parseable", () => {
  const real = loadSkillCatalog();
  assert.deepEqual(real.skills.map((s) => s.name), [
    "baseline-ui", "component-canvas", "create-canvas", "create-design-md", "fixing-accessibility",
    "fixing-metadata", "fixing-motion-performance", "improve-ui", "ui-skills-root",
  ]);
  assert.match(real.version, /^[0-9a-f]{12}$/);
  for (const s of real.skills) assert.ok(s.description.length > 20 && !s.description.startsWith(">"), s.name);
});

test("frontmatter supports plain and folded descriptions and requires kebab-case names", () => {
  assert.deepEqual(parseSkill("---\nname: ok-skill\ndescription: Does things.\n---\n# Body\n", "x"),
    { name: "ok-skill", description: "Does things.", body: "# Body" });
  assert.equal(parseSkill("---\nname: folded\ndescription: >\n  First line\n  second line.\nlicense: MIT\n---\nb", "x").description,
    "First line second line.");
  assert.throws(() => parseSkill("# no frontmatter", "x"), /frontmatter/);
  assert.throws(() => parseSkill("---\nname: Bad Name\ndescription: d\n---\nb", "x"), /kebab-case/);
});

test("a folder whose SKILL.md name differs is rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  fs.mkdirSync(path.join(dir, "folder"));
  fs.writeFileSync(path.join(dir, "folder", "SKILL.md"), "---\nname: other\ndescription: d\n---\nb");
  assert.throws(() => loadSkillCatalog(dir), /must match its folder/);
  fs.rmSync(dir, { recursive: true });
});

test("load_skills returns bodies, skips duplicates and unknown names, and enforces the cap", async () => {
  const loaded: Skill[] = [], reports: string[][] = [];
  const tool = skillTool(catalog, loaded, (names) => reports.push(names));
  const first = await tool.run({ names: ["beta", "nope", "beta"] });
  assert.match(first, /<skill name="beta">\nBODY-beta\n<\/skill>/);
  assert.match(first, /Unknown skill "nope"/);
  assert.match(await tool.run({ names: ["beta", "alpha"] }), /"beta" is already loaded/);
  await tool.run({ names: ["gamma", "delta", "eps", "zeta", "eta"] });
  assert.equal(loaded.length, MAX_LOADED_SKILLS);
  assert.deepEqual(reports, [["beta"], ["alpha"], ["gamma", "delta", "eps", "zeta"]]);
  await assert.rejects(tool.run({ names: ["nope"] }), /Valid names: alpha/);
  await assert.rejects(tool.run({}), /Pass \{"names"/);
});

test("the first call offers the catalog and tool; repairs carry loaded skills inline", () => {
  const session = skillSession("BASE", catalog, () => {});
  const first = session.next();
  assert.ok(first.system.startsWith("BASE") && first.system.includes("- alpha: alpha rules") && !first.system.includes("BODY-alpha"));
  assert.equal(first.tools?.[0].name, SKILL_TOOL);
  session.loaded.push(catalog.skills[2]);
  const repair = session.next();
  assert.equal(repair.tools, undefined);
  assert.equal(repair.system, withSkills("BASE", [catalog.skills[2]]));
  assert.deepEqual(skillSession("BASE", undefined, () => {}).next(), { system: "BASE" });
});

test("synthesis lets the model load skills and keeps them for repair calls", async () => {
  const blueprints = [makeBlueprint(makeSpec(), GOOD_ENGINE), makeBlueprint(makeLinkSpec(), LINK_ENGINE)];
  const files = [{ path: "/App.tsx", content: APP }, { path: "/components/NoteCard.tsx", content: NOTE_CARD }];
  const broken = APP.replace(/updateEase/g, "updateEases");
  const calls: StructuredCallOpts<unknown>[] = [];
  const llm: LlmPort = {
    async structuredCall<T>(o: StructuredCallOpts<T>) {
      calls.push(o as StructuredCallOpts<unknown>);
      if (o.tools) await o.tools[0].run({ names: ["gamma"] }); // the model asks for a skill before answering
      const raw = { app_title: "Study Room", app_description: "d", files: calls.length === 1 ? [{ ...files[0], content: broken }, files[1]] : files };
      return { value: o.parse(raw), assistantContent: [{ type: "text", text: JSON.stringify(raw), citations: null }], model: "m" };
    },
    continueWith: (m, a, f) => [...m, { role: "assistant", content: a }, { role: "user", content: f }],
  };
  const stages: string[] = [];
  await synthesize(blueprints, "A study app", "b_1", { onStage: (_, m) => stages.push(m), onProgress: () => {}, onValidation: () => {} },
    { llm, skills: catalog });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tools?.[0].name, SKILL_TOOL);
  assert.equal(calls[1].tools, undefined);
  assert.ok(calls[1].system.includes("BODY-gamma"), "the repair call keeps the loaded skill");
  assert.ok(stages.includes("Loaded UI skills: gamma"));
});
