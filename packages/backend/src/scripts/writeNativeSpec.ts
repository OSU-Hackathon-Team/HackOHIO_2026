import { writeNativeDraft } from "../spec/nativeDraft.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const result = await writeNativeDraft(JSON.parse(input));
process.stdout.write(JSON.stringify(result));
