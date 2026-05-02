/**
 * Fix incomplete JSX attribute handlers like onChange={(e) => func(
 * by detecting unclosed parentheses within attribute expressions and closing them.
 */
function fixIncompleteAttributeHandlers(code: string): string {
  let fixed = code;
  const bareTagLineRE =
    /^\s*(\/?)(main|header|footer|section|article|div|form|label|input|button|p|span|ul|ol|li|h[1-6])\b([^<]*)$/i;

  // Scan for incomplete handlers by looking for lines ending with incomplete expressions
  const lines = fixed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Fix dropped '<' on JSX tag lines like "input" or "/main>".
    const bareTagMatch = line.match(bareTagLineRE);
    if (bareTagMatch && !line.trimStart().startsWith("<")) {
      const [, slash, tag, rest] = bareTagMatch;
      const suffix = rest.trimEnd().endsWith(">") ? rest : `${rest}>`;
      line = `<${slash}${tag}${suffix}`;
      lines[i] = line;
    }

    // Detect lines with incomplete arrow functions or method calls:
    // e.g., "onChange={(e) => setUsername(e.target.value"
    // Pattern: attribute={...function call without closing paren/brace
    if (
      line.includes("onChange=") ||
      line.includes("onClick=") ||
      line.includes("onSubmit=")
    ) {
      const hasOpeningBrace = line.includes("{");
      const hasClosingBrace = line.includes("}");
      const openParens = (line.match(/\(/g) || []).length;
      const closeParens = (line.match(/\)/g) || []).length;

      if (hasOpeningBrace && !hasClosingBrace) {
        const parenFix =
          openParens > closeParens ? ")".repeat(openParens - closeParens) : "";
        lines[i] = `${line}${parenFix}}`;
        continue;
      }

      const unclosedParenMatch = line.match(/\(\w+\)\s*=>\s*\w+\([^)]*$/);
      if (unclosedParenMatch) {
        // This line has an incomplete arrow function call; close it
        lines[i] = line + ")";
      }
    }

    // Also check for incomplete object/array literals in attributes
    if (line.match(/\w+=\{[^}]*\(\s*$/)) {
      lines[i] = line + ")";
    }
  }

  fixed = lines.join("\n");

  // Additional scan: look for single-line JSX start tags that never close.
  // Keep the tag name intact; only append a self-close when the line is clearly a tag start.
  fixed = fixed.replace(
    /^\s*<([A-Za-z][\w:-]*)([^>]*?)\s*$/gm,
    (_match, tagName: string, attrs: string) => {
      if (attrs.includes("{") && !attrs.includes("}")) {
        return _match;
      }
      return `<${tagName}${attrs} />`;
    },
  );

  return fixed;
}

export function autoCloseJsx(code: string): string {
  if (!code || typeof code !== "string") return code;

  let fixed = code;

  // Fix incomplete JSX attribute handlers: detect patterns like `onChange={(e) => func(`
  // and close them properly before they break JSX parsing.
  // Pattern: attribute="...( ... (" with unmatched parens within the attribute value.
  fixed = fixIncompleteAttributeHandlers(fixed);

  // Balance simple braces and parentheses
  const openBraces = (fixed.match(/\{/g) || []).length;
  const closeBraces = (fixed.match(/\}/g) || []).length;
  if (openBraces > closeBraces) {
    fixed += "\n" + "}".repeat(openBraces - closeBraces);
  }

  const openParens = (fixed.match(/\(/g) || []).length;
  const closeParens = (fixed.match(/\)/g) || []).length;
  if (openParens > closeParens) {
    fixed += ")".repeat(openParens - closeParens);
  }

  // Common JSX tags to ensure closing tags for
  const tags = [
    "div",
    "p",
    "span",
    "button",
    "section",
    "header",
    "footer",
    "main",
    "ul",
    "ol",
    "li",
    "form",
    "label",
    "article",
  ];

  const toClose: string[] = [];

  for (const tag of tags) {
    const openRegex = new RegExp(`<${tag}(\\s|>|\\/>)`, "gi");
    const selfClosingRegex = new RegExp(`<${tag}[^>]*\\/\\s*>`, "gi");
    const closeRegex = new RegExp(`</${tag}>`, "gi");

    const opens = (fixed.match(openRegex) || []).length;
    const closes = (fixed.match(closeRegex) || []).length;
    const selfCloses = (fixed.match(selfClosingRegex) || []).length;

    const effectiveOpens = Math.max(0, opens - selfCloses);
    if (effectiveOpens > closes) {
      const missing = effectiveOpens - closes;
      for (let i = 0; i < missing; i++) toClose.push(tag);
    }
  }

  if (toClose.length > 0) {
    // Append closing tags in reverse order (naive stack heuristic)
    fixed +=
      "\n" +
      toClose
        .reverse()
        .map((t) => `</${t}>`)
        .join("\n");
  }

  // Ensure common endings for React files
  // If an export default is present but missing trailing semicolon, leave it alone.
  // Return the fixed code
  return fixed;
}
