
export interface RenderResult {
  html: string;
}

export interface EditResult {
  markdown: string;
  html: string;
}

export function renderMarkdown(markdown: string): RenderResult {
  // Split into lines for processing
  const lines = markdown.split('\n');
  const processedLines: string[] = [];
  
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    
    // Process code blocks (fenced)
    if (line.startsWith('```')) {
      const result = processCodeBlock(lines, i);
      processedLines.push(result.html);
      i = result.nextIndex;
      continue;
    }
    
    // Process headings
    if (line.match(/^#{1,6}\s/)) {
      processedLines.push(processHeading(line));
      i++;
      continue;
    }
    
    // Process blockquotes and callouts
    if (line.startsWith('>')) {
      const result = processBlockquote(lines, i);
      processedLines.push(result.html);
      i = result.nextIndex;
      continue;
    }
    
    // Process lists
    if (line.match(/^\s*[-*]\s/)) {
      const result = processList(lines, i);
      processedLines.push(result.html);
      i = result.nextIndex;
      continue;
    }
    
    // Process tables
    if (line.startsWith('|')) {
      const result = processTable(lines, i);
      processedLines.push(result.html);
      i = result.nextIndex;
      continue;
    }
    
    // Add line as is (will be processed for inline formatting later)
    processedLines.push(line);
    i++;
  }
  
  // Join lines and process inline formatting
  let html = processedLines.join('\n');
  
  // Process inline formatting
  html = processInlineFormatting(html);
  
  // Process links
  html = processLinks(html);
  
  // Process paragraphs
  html = processParagraphs(html);
  
  return { html };
}

export function editMarkdown(doc: string, action: "replace" | "append", text: string): EditResult {
  const markdown = action === "replace" ? text : doc + text;
  const rendered = renderMarkdown(markdown);
  return {
    markdown,
    html: rendered.html
  };
}

// Helper functions
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function processCodeBlock(lines: string[], startIndex: number): { html: string, nextIndex: number } {
  const startLine = lines[startIndex];
  const lang = startLine.substring(3).trim();
  const contentLines: string[] = [];
  
  let i = startIndex + 1;
  while (i < lines.length && !lines[i].startsWith('```')) {
    contentLines.push(lines[i]);
    i++;
  }
  
  const languageClass = lang ? ` class="language-${lang}"` : '';
  const escapedContent = escapeHtml(contentLines.join('\n'));
  
  return {
    html: `<pre><code${languageClass}>${escapedContent}</code></pre>`,
    nextIndex: i + 1
  };
}

function processHeading(line: string): string {
  const match = line.match(/^(#{1,6})\s+(.*?)\s*$/);
  if (!match) return line;
  
  const level = match[1].length;
  const content = match[2];
  return `<h${level} data-heading="${content}">${content}</h${level}>`;
}

function processBlockquote(lines: string[], startIndex: number): { html: string, nextIndex: number } {
  const blockquoteLines: string[] = [];
  let i = startIndex;
  
  // Collect all consecutive blockquote lines
  while (i < lines.length && lines[i].startsWith('>')) {
    const line = lines[i];
    // Check for callout syntax
    const calloutMatch = line.match(/^>\s*\[!(\w+)\]\s*(.*)/);
    if (calloutMatch) {
      const calloutType = calloutMatch[1].toLowerCase();
      const content = calloutMatch[2] || '';
      
      // Get additional content lines for the callout
      i++;
      const contentLines: string[] = [content];
      while (i < lines.length && lines[i].startsWith('>')) {
        contentLines.push(lines[i].substring(1).trim());
        i++;
      }
      
      const contentHtml = contentLines.filter(l => l !== '').join('<br>');
      return {
        html: `<div class="callout" data-callout="${calloutType}">${contentHtml}</div>`,
        nextIndex: i
      };
    }
    
    // Regular blockquote
    blockquoteLines.push(line.substring(1).trimStart());
    i++;
  }
  
  // Process content for inline formatting
  const processedContent = blockquoteLines
    .map(line => processInlineFormatting(processLinks(line)))
    .join('<br>');
  
  return {
    html: `<blockquote>${processedContent}</blockquote>`,
    nextIndex: i
  };
}

function processList(lines: string[], startIndex: number): { html: string, nextIndex: number } {
  const listItems: Array<{content: string, indent: number}> = [];
  let i = startIndex;
  
  // Collect all list items
  while (i < lines.length && 
         (lines[i].match(/^\s*[-*]\s/) || 
          lines[i].match(/^\s*$/))) {  // Allow blank lines in lists
    const match = lines[i].match(/^(\s*)[-*]\s(.*)/);
    if (match) {
      const indent = match[1].length;
      const content = match[2];
      listItems.push({ content, indent });
    }
    i++;
  }
  
  // Build nested HTML structure
  const html = buildNestedList(listItems, 0);
  
  return {
    html: `<ul>${html}</ul>`,
    nextIndex: i
  };
}

function buildNestedList(items: Array<{content: string, indent: number}>, baseIndent: number): string {
  let html = '';
  let i = 0;
  
  while (i < items.length) {
    const item = items[i];
    
    if (item.indent < baseIndent) {
      break; // Return to parent level
    }
    
    if (item.indent > baseIndent) {
      // Handle nested list
      const nestedItems = [];
      let j = i;
      while (j < items.length && items[j].indent >= item.indent) {
        nestedItems.push(items[j]);
        j++;
      }
      
      const nestedHtml = buildNestedList(nestedItems, item.indent);
      html = html.slice(0, -5); // Remove trailing </li>
      html += `<ul>${nestedHtml}</ul></li>`;
      i = j;
      continue;
    }
    
    // Process item content for inline formatting
    const processedContent = processInlineFormatting(processLinks(item.content));
    html += `<li>${processedContent}</li>`;
    i++;
  }
  
  return html;
}

function processTable(lines: string[], startIndex: number): { html: string, nextIndex: number } {
  const tableLines: string[] = [];
  let i = startIndex;
  
  // Collect table lines
  while (i < lines.length && 
         (lines[i].startsWith('|') || lines[i].match(/^[\s|:-]+$/))) {
    tableLines.push(lines[i]);
    i++;
  }
  
  if (tableLines.length < 2) {
    return {
      html: tableLines.join('\n'),
      nextIndex: i
    };
  }
  
  // Parse header
  const headers = tableLines[0]
    .split('|')
    .slice(1, -1) // Remove first and last empty elements
    .map(cell => cell.trim());
  
  // Parse alignment from separator line
  const alignments: string[] = [];
  if (tableLines[1]) {
    const separators = tableLines[1]
      .split('|')
      .slice(1, -1)
      .map(s => s.trim());
      
    separators.forEach(separator => {
      if (separator.startsWith(':') && separator.endsWith(':')) {
        alignments.push('center');
      } else if (separator.endsWith(':')) {
        alignments.push('right');
      } else {
        alignments.push('left');
      }
    });
  }
  
  // Parse body rows
  const rows: string[][] = [];
  for (let j = 2; j < tableLines.length; j++) {
    if (tableLines[j].startsWith('|')) {
      const cells = tableLines[j]
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());
      rows.push(cells);
    }
  }
  
  // Generate HTML
  let html = '<table class="table-editor"><thead><tr>';
  
  // Header
  for (let j = 0; j < headers.length; j++) {
    const align = alignments[j] || 'left';
    html += `<th style="text-align: ${align}">${headers[j]}</th>`;
  }
  html += '</tr></thead><tbody>';
  
  // Body
  for (const row of rows) {
    html += '<tr>';
    for (let j = 0; j < headers.length; j++) {
      const cell = row[j] || '';
      const align = alignments[j] || 'left';
      html += `<td style="text-align: ${align}">${cell}</td>`;
    }
    html += '</tr>';
  }
  
  html += '</tbody></table>';
  
  return {
    html,
    nextIndex: i
  };
}

function processInlineFormatting(text: string): string {
  // Process strikethrough
  text = text.replace(/~~(.*?)~~/g, '<del>$1</del>');
  
  // Process strong/bold (**text** or __text__)
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.*?)__/g, '<strong>$1</strong>');
  
  // Process emphasis/italic (*text* or _text_)
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, '<em>$1</em>');
  
  return text;
}

function processLinks(text: string): string {
  // Process external links [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, 
    '<a class="external-link" href="$2" rel="noopener nofollow">$1</a>');
  
  // Process internal links [[Target]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, 
    '<a class="internal-link is-unresolved" href="$1" rel="noopener nofollow" data-href="$1">$1</a>');
  
  return text;
}

function processParagraphs(html: string): string {
  // Split by double newlines to identify paragraphs
  const blocks = html.split('\n\n');
  
  const processedBlocks = blocks.map(block => {
    // If block already contains HTML tags, don't wrap in paragraph
    if (block.startsWith('<') || block === '') {
      return block;
    }
    
    // Wrap plain text in paragraph tags
    if (block.trim() !== '') {
      return `<p>${block}</p>`;
    }
    
    return block;
  });
  
  return processedBlocks.join('\n\n');
}

export const operations = {
  render: async (input: { markdown: string }) => {
    const res = renderMarkdown(input.markdown);
    return { html: res.html };
  },
  edit: async (input: { doc: string; action: "replace" | "append"; text: string }) => {
    const res = editMarkdown(input.doc, input.action, input.text);
    return { markdown: res.markdown, html: res.html };
  }
};
export default operations;
