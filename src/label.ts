const MAX_LABEL = 80;

/** Strip a `<tag>…</tag>` or self-closing `<tag>` wrapper that Claude Code injects. */
function stripWrappers(text: string): string {
  return text
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, " ")
    .replace(/<local-command-[a-z]+>[\s\S]*?<\/local-command-[a-z]+>/g, " ")
    .replace(/<[^>]+>/g, " ") // any other stray tag
    .trim();
}

/** Extract a `/slash-command` name from a command stub, if the text is one. */
function commandName(text: string): string | null {
  const m = text.match(/<command-name>\s*(\/[^<\s]+)/);
  if (m?.[1]) return m[1];
  const bare = text.trim();
  if (/^\/[a-z0-9][\w-]*$/i.test(bare)) return bare;
  return null;
}

/**
 * Drop leading pasted file-path lines (e.g. "/Users/.../Artworks June 13\n\nactual question").
 * A line counts as a path prefix when it starts with `/` or `~`, is a single line, and lacks
 * sentence-ending punctuation — paths may contain spaces, so we don't reject those. Only
 * strips when real text remains afterwards.
 */
function stripLeadingPath(text: string): string {
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (line === "") {
      i++;
      continue;
    }
    if (/^[~/]\S/.test(line) && !/[.?!:]$/.test(line)) {
      i++;
      continue;
    }
    break;
  }
  const rest = lines.slice(i).join("\n").trim();
  return rest || text;
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LABEL ? collapsed.slice(0, MAX_LABEL - 1).trimEnd() + "…" : collapsed;
}

/**
 * Build a fallback label from a Session's first human user texts. Prefers the first text
 * that cleans to real prose; surfaces a bare slash-command as its name; "(untitled)" if
 * nothing usable. Used only when no native or generated Title exists.
 */
export function cleanLabel(userTexts: readonly string[]): string {
  for (const raw of userTexts) {
    const cmd = commandName(raw);
    if (cmd) return cmd;
    const cleaned = stripLeadingPath(stripWrappers(raw));
    if (cleaned) return truncate(cleaned);
  }
  return "(untitled)";
}
