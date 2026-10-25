import React from "react";
import clsx from "clsx";

export interface CodeBlockProps {
  code: string;
  startLine?: number;
  highlight?: Set<number>;
  caption?: string;
  className?: string;
}

export function CodeBlock({
  code,
  startLine = 1,
  highlight,
  caption,
  className,
}: CodeBlockProps) {
  const lines = code.split("\n");

  return (
    <div className={clsx("overflow-hidden rounded-lg border border-white/10 bg-black/60 font-mono text-xs", className)}>
      {caption && (
        <div className="border-b border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-400">
          {caption}
        </div>
      )}
      <pre className="overflow-x-auto p-3 leading-5">
        <code>
          {lines.map((line, idx) => {
            const lineNum = startLine + idx;
            const isHighlighted = highlight?.has(lineNum);
            return (
              <div
                key={lineNum}
                className={clsx(
                  "table-row",
                  isHighlighted && "bg-sky-400/10 text-sky-200"
                )}
              >
                <span className="table-cell select-none pr-4 text-right text-slate-600">
                  {lineNum}
                </span>
                <span className="table-cell whitespace-pre">{line}</span>
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
