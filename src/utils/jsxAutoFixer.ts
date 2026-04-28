export function autoCloseJsx(code: string): string {
  if (!code || typeof code !== "string") return code;

  let fixed = code;

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
