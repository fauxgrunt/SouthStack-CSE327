export function aggressiveSanitize(code: string): string {
  if (!code || typeof code !== "string") return code;

  let out = code;

  // Normalize smart quotes to straight quotes
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Remove HTML entities that might have been generated
  out = out.replace(/&rsquo;/g, "'");
  out = out.replace(/&lsquo;/g, "'");
  out = out.replace(/&rdquo;/g, '"');
  out = out.replace(/&ldquo;/g, '"');
  out = out.replace(/&nbsp;/g, " ");
  out = out.replace(/&amp;/g, "&");
  out = out.replace(/&lt;/g, "<");
  out = out.replace(/&gt;/g, ">");
  out = out.replace(/&#39;/g, "'");
  out = out.replace(/&quot;/g, '"');
  // Remove null chars without regex control-character patterns
  out = out.split("\u0000").join("");

  // Fix common arrow-function slash insertion: '=> / set' -> '=> set'
  out = out.replace(/=>\s*\/\s*/g, "=> ");

  // Remove lines that consist solely of a single starting slash (likely broken regex)
  out = out
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\s*$/.test(line))
    .join("\n");

  // Remove lines that start with a slash followed by non-slash characters and no closing slash
  out = out
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/[^\n/]*$/.test(line))
    .join("\n");

  // Escape lone slashes that are followed by space and an identifier (rare generator artifacts)
  out = out.replace(/\s\/\s+(?=[A-Za-z_])/g, " ");

  // Balance quotes: if odd number of single or double quotes, append closing quote at end of file
  const singleQuotes = (out.match(/'/g) || []).length;
  const doubleQuotes = (out.match(/"/g) || []).length;
  if (singleQuotes % 2 !== 0) {
    out += "'";
  }
  if (doubleQuotes % 2 !== 0) {
    out += '"';
  }

  // Fix unterminated strings on individual lines
  out = out
    .split("\n")
    .map((line) => {
      // Count quotes in this line
      let singleQ = 0,
        doubleQ = 0;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"' && (i === 0 || line[i - 1] !== "\\")) {
          doubleQ++;
        }
        if (line[i] === "'" && (i === 0 || line[i - 1] !== "\\")) {
          singleQ++;
        }
      }
      // Close unterminated quotes on this line
      if (doubleQ % 2 !== 0) {
        line += '"';
      }
      if (singleQ % 2 !== 0) {
        line += "'";
      }
      return line;
    })
    .join("\n");

  // Remove accidental regex-like tokens: patterns like '/something' that are not part of tags or strings
  // Conservative approach: remove occurrences of newline + optional spaces + /word_without_space until another space
  out = out.replace(/(^|\n)\s*\/[A-Za-z0-9_-]+(?=\s|\n|;|,)/g, "$1");

  // Remove spurious backticks that appear on their own line
  out = out.replace(/^\s*`\s*$/gm, "");

  // Remove common garbage patterns that LLMs sometimes add
  out = out.replace(/^\s*\.\.\.\s*$/gm, "");
  out = out.replace(/^\s*===+\s*$/gm, "");
  out = out.replace(/^\s*---+\s*$/gm, "");

  // Remove broken image paths (src="path_to_...", src="image", placeholder URIs)
  out = out.replace(
    /src=["'](?:path_to_[^"']*|image|icon|photo|picture|placeholder|img[^"']*)["']/gi,
    "",
  );

  // Remove img tags with broken/placeholder src entirely (vision artifacts)
  out = out.replace(
    /<img[^>]*src=["'](?:path_to_[^"']*|image|placeholder)["'][^>]*\/?>/gi,
    "",
  );

  // Remove alt text that sounds like descriptions (contains "photo of", "image of", etc.) — likely OCR artifacts
  out = out.replace(
    /alt=["'](?:[^"']*\s+(?:photo|image|picture|picture of|shows|displays|depicts|of a)[^"']*)["']/gi,
    "",
  );

  // Clean up obvious OCR gibberish in text content (e.g., "BOOLE", "PropertyParams" mixed with real words)
  // Remove single-word strings that look like corrupted OCR (all caps with unusual patterns)
  out = out
    .split(/\r?\n/)
    .map((line) => {
      // Remove lines that are only OCR artifacts (e.g., single weird word like "PropertyParams", "BOOLE")
      const textMatch = line.match(/["']([^"']+)["']/g);
      if (textMatch) {
        textMatch.forEach((match) => {
          const text = match.slice(1, -1);
          // If it looks like corrupted OCR (CamelCaseWithoutSpaces, all caps, etc.), flag it
          const isSuspicious =
            /^[A-Z][a-z]*[A-Z]/.test(text) &&
            text.length < 20 &&
            !/\s/.test(text);
          if (isSuspicious && !isLikelyValidWord(text)) {
            line = line.replace(match, '""');
          }
        });
      }
      return line;
    })
    .join("\n");

  // Ensure JSX tags are closed (use existing auto-close heuristics in autoCloseJsx later)
  return out;
}

/**
 * Detect if a string is likely a valid word/phrase vs OCR gibberish.
 * Common valid CamelCase words: React, useState, className, onClick, etc.
 * Gibberish: PropertyParams, BOOLE, etc.
 */
function isLikelyValidWord(text: string): boolean {
  const commonWords = [
    "React",
    "useState",
    "useEffect",
    "className",
    "onClick",
    "onChange",
    "onSubmit",
    "innerHTML",
    "href",
    "src",
    "alt",
    "key",
    "map",
    "filter",
    "reduce",
    "import",
    "export",
    "default",
    "function",
    "const",
    "let",
    "var",
    "return",
    "if",
    "else",
    "for",
    "while",
  ];

  if (commonWords.includes(text)) return true;

  // If it contains common substrings (Button, Link, Page, Component, etc.), likely valid
  if (
    /(?:Button|Link|Page|Component|Header|Footer|Nav|Section|Item|List|Card|Modal|Form|Input|Label|Text|Image|Icon)/.test(
      text,
    )
  ) {
    return true;
  }

  // Real words often have vowels
  if (!/[aeiouAEIOU]/.test(text)) return false;

  return false;
}
