import type { ApplicationBundle, CompositionPlan } from "@splice/contracts";

export interface CompiledFile {
  path: string;
  /** Null for generated binary assets, which are copied from the package registry. */
  data: Buffer | null;
}

export interface CompiledApplication {
  bundle: ApplicationBundle;
  files: CompiledFile[];
}

export interface CompileHooks {
  signal?: AbortSignal;
  onStage(stage: string, message: string, pct: number): void;
}

export interface CompositionCompiler {
  compile(plan: CompositionPlan, hooks: CompileHooks): Promise<CompiledApplication>;
}
