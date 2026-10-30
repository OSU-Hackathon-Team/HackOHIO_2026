import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// splice.lock.json of the recorded run-2 export (plan 49717df1…): artifact `src/index.ts` per package.
const RUN2_SOURCES = {
  "../src/demo/engines/obsidianRenderer.ts": "2b96666b7bf7d8ab9816ac25977bdd54d97bd50ab9e55345b4d823c2113a2481",
  "../src/demo/engines/calcTables.ts": "d7f40aa5212a3a023f782c8a20add8472fdd294158f2818e3fc0371f66b316a5",
};

test("demo engines are byte-identical to the run-2 export", () => {
  for (const [file, sha256] of Object.entries(RUN2_SOURCES)) {
    const bytes = readFileSync(new URL(file, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256, file);
  }
});
