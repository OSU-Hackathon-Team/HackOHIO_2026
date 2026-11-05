/** Local showcase code jobs are separate from the Bedrock synthesis pipeline. */
export type ShowcaseCodeJobStatus = "planning" | "writing" | "checking" | "ready" | "failed" | "cancelled";
export interface ShowcaseCodeJob {
  id: string;
  projectId: string;
  parentRevision: string | null;
  dataRevision: number;
  status: ShowcaseCodeJobStatus;
  model: string;
  repairs: number;
  summary?: string;
  files?: string[];
  error?: string;
  revision?: string;
  elapsedMs?: number;
  tokensUsed?: number;
}
export interface ShowcaseCodeRevision {
  revision: string;
  projectId: string;
  parentRevision: string | null;
  summary: string;
  files: string[];
  model: string;
  createdAt: string;
  source: Record<string, string>;
  parentSource: Record<string, string>;
}
/** A trusted same-origin iframe calls this host-owned bridge; edits still use the validated action executor. */
export interface ShowcasePreviewBridge<Project, Action> {
  getProject(): Project;
  subscribe(listener: (project: Project) => void): () => void;
  apply(actions: Action[]): void;
  select(id: string): void;
  tableValues(tableId: string): (string | number)[][];
  total(tableId?: string): number;
  reportReady(): void;
  reportError(message: string): void;
}
