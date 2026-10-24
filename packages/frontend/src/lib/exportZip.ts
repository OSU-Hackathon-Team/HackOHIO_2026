// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/08_sandpack_studio.md §4
import type { SynthesisBundle } from "@splice/contracts";

export function exportBundleJson(bundle: SynthesisBundle): void {
  if (typeof document === "undefined") return;
  const json = JSON.stringify(bundle, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const slug = bundle.app_title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "splice-app";
  a.href = url;
  a.download = `${slug}-rev${bundle.revision}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
