// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/08_sandpack_studio.md §2
import { useEffect, useRef } from "react";
import { useSandpack } from "@codesandbox/sandpack-react";
import { useStudio } from "../../store/useStudio";

/** Implements the auto-fix policy in 04 §3. */
export function RuntimeErrorWatcher({
  bundleId,
  revision,
}: {
  bundleId: string;
  revision: number;
}) {
  const { sandpack } = useSandpack();
  const refine = useStudio(s => s.refine);
  const autoFixUsedFor = useStudio(s => s.synth.autoFixUsedFor);
  const status = useStudio(s => s.synth.status);
  const timer = useRef<number>();

  useEffect(() => {
    window.clearTimeout(timer.current);
    const err = sandpack.error;
    if (!err || status === "running") return;
    // Debounce: Sandpack can flash errors while bundling
    timer.current = window.setTimeout(() => {
      const text = [
        err.title,
        err.message,
        err.path ? `${err.path}:${err.line ?? "?"}` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000);

      useStudio.setState(s => ({ synth: { ...s.synth, error: text } }));
      if (autoFixUsedFor !== bundleId) {
        void refine("fix", text);
      }
    }, 1200);

    return () => window.clearTimeout(timer.current);
  }, [sandpack.error, bundleId, revision, autoFixUsedFor, status, refine]);

  return null;
}
