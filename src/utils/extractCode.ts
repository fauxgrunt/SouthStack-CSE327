export function extractCodeFromResponse(response: string): string {
  let code = response.trim();

  // Remove code fences (all variants)
  code = code.replace(/^```[\w]*\s*/gm, "").replace(/```\s*$/gm, "");

  // Remove markdown-style headers, blockquotes, bold, italic
  code = code
    .replace(/^#+\s+.*$/gm, "")
    .replace(/^>\s+.*$/gm, "")
    .replace(/^\*\*.*?\*\*\s*/gm, "")
    .replace(/^__.*?__\s*/gm, "")
    .replace(/^-+\s+.*$/gm, "");

  // Remove HTML comments
  code = code
    .split("\n")
    .map((line) => line.replace(/\s*<!--.*?-->\s*/g, ""))
    .join("\n");

  // Remove block comments
  code = code
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // Filter out lines that are pure comments or markdown
  code = code
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Skip pure comment lines, markdown headers, blockquotes
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith(">") &&
        !trimmed.startsWith("-") &&
        !trimmed.startsWith("```")
      );
    })
    .join("\n");

  // Clean up extra blank lines
  code = code.replace(/\n\n+/g, "\n").trim();

  return code;
}

export function isValidReactCode(code: string): boolean {
  const hasExportDefault = /export\s+default/i.test(code);
  const hasFunction = /function\s+\w+|const\s+\w+\s*=/i.test(code);
  const hasJSX = /<[A-Z]\w*|<\w+[\s>]/.test(code);

  return hasExportDefault && hasFunction && hasJSX;
}
