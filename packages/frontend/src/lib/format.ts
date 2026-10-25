// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/05_frontend_setup.md §3

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function shortId(id: string, len = 8): string {
  return id.slice(0, len);
}

export function formatChars(chars: number): string {
  return `${chars.toLocaleString()} chars`;
}
