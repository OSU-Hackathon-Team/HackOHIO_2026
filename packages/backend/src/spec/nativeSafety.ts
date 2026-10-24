const reportOrCode = /```|<\/?(?:source|code)|\b(?:MOVAPS|MOVUPS|PXOR|JBE|CMP|RDI|XMM\d+|param_\d+)\b|\b0x[0-9a-f]{6,}\b|\b[0-9a-f]{64}\b|\b(?:decompil|disassembl|review_state|unmapped|artifact|unknown|TODO|dossier|claim|probe|source)\w*\b|\bsrc\//i;
const syntax = /[{}`;]|\b(?:function|const|let|return|if)\s*\(|=>|(?:^|\s)[A-Za-z_]\w*(?:\[[^\]]+\])?\s*(?:\+=|-=|==|=)\s*\S|^\s*[A-Za-z_]\w*\s*:\s*(?:u?int\d+|boolean|number|string|bool)\b/i;

export function sourceLikeText(value: string): boolean {
  return reportOrCode.test(value) || syntax.test(value);
}

function exampleDataContainsSource(value: unknown): boolean {
  if (typeof value === "string") return value.length > 256 ||
    /```|\/\*|\*\/|\/\/|\b(?:function|class|const|import|export)\s+\w+|\b(?:MOVAPS|MOVUPS|PXOR|JBE|CMP)\b|\b0x[0-9a-f]{6,}\b|\b(?:return|const|let|import|export)\s+\w+|=>|\{\s*\w+\s*[:=]|\n/i.test(value);
  if (Array.isArray(value)) return value.some(exampleDataContainsSource);
  if (value && typeof value === "object") return Object.entries(value).some(
    ([key, item]) => exampleDataContainsSource(key) || exampleDataContainsSource(item));
  return false;
}

export function publicSpecContainsSource(value: unknown): boolean {
  if (typeof value === "string") return sourceLikeText(value) || value.includes("\n");
  if (Array.isArray(value)) return value.some(publicSpecContainsSource);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      sourceLikeText(key) || (key === "examples" && Array.isArray(item)
        ? exampleDataContainsSource(item) : publicSpecContainsSource(item)));
  }
  return false;
}
