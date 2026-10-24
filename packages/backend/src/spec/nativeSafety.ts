const reportOrCode = /```|<\/?(?:source|code)|\b(?:MOVAPS|MOVUPS|PXOR|JBE|CMP|RDI|XMM\d+|param_\d+)\b|\b0x[0-9a-f]{6,}\b|\b[0-9a-f]{64}\b|\b(?:decompil|disassembl|review_state|unmapped|artifact|unknown|TODO|dossier|claim|probe|source)\w*\b|\bsrc\//i;
const syntax = /[{}`;]|\b(?:function|const|let|return|if)\s*\(|=>|(?:^|\s)[A-Za-z_]\w*(?:\[[^\]]+\])?\s*(?:\+=|-=|==|=)\s*\S/;

export function sourceLikeText(value: string): boolean {
  return reportOrCode.test(value) || syntax.test(value);
}

export function publicSpecContainsSource(value: unknown): boolean {
  if (typeof value === "string") return sourceLikeText(value) || value.includes("\n");
  if (Array.isArray(value)) return value.some(publicSpecContainsSource);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      sourceLikeText(key) || publicSpecContainsSource(item));
  }
  return false;
}
