export function parseLinks(markdown: string): string[] {
  const clean = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  return Array.from(clean.matchAll(/\[\[([^\]]+)\]\]/g), (m) => m[1].split(/[|#]/)[0].trim()).filter(Boolean);
}
