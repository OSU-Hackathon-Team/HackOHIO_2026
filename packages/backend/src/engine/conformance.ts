// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/01_engine_implementation.md §4
import type { FeatureSpec } from "@splice/contracts";
import { typecheckVirtual } from "../typecheck/virtualTsc.js";

/**
 * Engine vs spec.interface.types_code, strict mode. Functions and consts must be assignable to the
 * declared type; exported types must be assignable both ways (same shape).
 */
export function conformanceErrors(spec: FeatureSpec, engineCode: string): string[] {
  const names = (kind: "function" | "type" | "const") =>
    spec.interface.exports.filter((e) => e.kind === kind).map((e) => e.name);

  // One line per check, remembering which export it belongs to: the model never sees /check.ts,
  // so its diagnostics are rewritten to name the export instead.
  const lines: [string, string | null][] = [
    [`import * as impl from "./engine";`, null],
    [`import type * as S from "./interface";`, null],
    ...[...names("function"), ...names("const")].map((n): [string, string] =>
      [`const _v_${n}: typeof import("./interface").${n} = impl.${n};`, n]),
    ...names("type").flatMap((n): [string, string][] => [
      [`declare const _a_${n}: import("./engine").${n};`, n],
      [`const _b_${n}: S.${n} = _a_${n};`, n],
      [`declare const _c_${n}: S.${n};`, n],
      [`const _d_${n}: import("./engine").${n} = _c_${n};`, n],
    ]),
    [`export {};`, null],
  ];

  const errors = typecheckVirtual(
    { "/engine.ts": engineCode, "/interface.ts": spec.interface.types_code, "/check.ts": lines.map(([l]) => l).join("\n") },
    { strict: true, jsx: false },
  );
  return errors.map((e) => {
    const m = e.match(/^\/check\.ts\((\d+),\d+\): ([\s\S]*)$/);
    const name = m ? lines[+m[1] - 1]?.[1] : null;
    return name ? `Export "${name}" does not match the interface: ${m![2]}` : e;
  });
}
