export interface UIGenerationRequest {
  prompt: string;
  screenshot?: string;
  screenshotDescription?: string;
  previousCode?: string;
}

/**
 * Auto-detect prompt depth (shallow vs deep) to guide generation strategy.
 * Shallow: vague/minimal → model should intelligently improvise standard UI patterns.
 * Deep: specific/detailed → model should follow exact specs without guessing.
 */
function detectPromptDepth(prompt: string): "shallow" | "deep" {
  const trimmed = prompt.trim().toLowerCase();
  const wordCount = trimmed.split(/\s+/).length;
  
  // Specificity indicators for deep prompts
  const deepIndicators = [
    /\b(exact|specific|must|should|require|layout|position|align|color|font|size|padding|margin|spacing|button|input|form|table|grid|flex|shadow|border|radius|width|height|max-|min-)\b/gi,
    /:\s*\d+|%|px|em|rem|\d+\s*(min|sec|hour|color|color code|rgb|hex)/gi,
    /\[\s*|{.*}/gi, // lists or structured notation
    /\bwith\s+|and\s+|include|containing|showing/gi, // enumerating features
  ];
  
  let deepScore = 0;
  deepIndicators.forEach((indicator) => {
    const matches = trimmed.match(indicator);
    if (matches) deepScore += matches.length;
  });
  
  // Shallow indicators
  const shallowPhrases = [
    /^create\s+\w+|^build\s+\w+|^make\s+\w+/i,
    /\bUI\b|\binterface\b|\bscreen\b/i,
  ];
  
  let shallowScore = 0;
  shallowPhrases.forEach((phrase) => {
    if (phrase.test(trimmed)) shallowScore++;
  });
  
  // Scoring logic: if deep indicators found or word count is high, it's deep; otherwise shallow.
  if (deepScore > 3 || wordCount > 40) return "deep";
  if (shallowScore > 0 && deepScore < 2) return "shallow";
  return wordCount > 15 ? "deep" : "shallow";
}

export function buildSystemPrompt(): string {
  return `You are an expert React UI component generator. Your goal is to produce pixel-perfect, production-ready React code that exactly matches the provided UI specifications.

INTENT HANDLING:
- If the user prompt is shallow or minimal, infer the missing product details and build a polished complete UI instead of asking follow-up questions.
- If the user prompt is detailed, follow it precisely and do not invent extra requirements.
- Never fill the output with repeated placeholder text, generic labels, or broken fragments.

CRITICAL REQUIREMENTS:
1. Generate ONE complete, self-contained App component only.
2. Export as: export default function App() { ... }
3. Use ONLY inline Tailwind CSS classes for styling. NO external CSS files. NO CSS imports. NO style= attributes.
4. Do not import any custom UI libraries, icon libraries, or component packages.
5. Do not import ANY CSS files, fonts, or stylesheets.
6. Import React only if needed. Never import from react-dom or react-dom/client.
7. Emit exactly ONE and ONLY ONE default export.
8. Use ONLY these built-in HTML/SVG elements: div, section, header, main, footer, article, nav, label, input, button, span, svg, path, circle, rect, line, polygon, text, tspan, img, p, h1, h2, h3, h4, h5, h6, a, ul, li, form. NOTHING ELSE.
9. FORBIDDEN: Do not create ANY custom component tags. Absolutely NO <CustomComponent>, <Button>, <Card>, <Icon>, <DB>, <RDS>, or any other custom components. Every tag MUST be lowercase HTML or SVG.
10. Every HTML element MUST be properly closed with matching tags. <div>...</div> not <div>...
11. NO console.log, NO comments, NO debug code.
12. NO markdown in output - ONLY valid JSX code.
13. All styling must be applied via className prop with Tailwind utilities. Example: className="flex items-center justify-center bg-blue-500".
14. IMAGES: If the prompt mentions images, use SVG placeholders or CSS gradients ONLY. Do NOT include <img> tags with placeholder paths or broken src attributes. If unclear about images, use colored divs or SVG shapes instead.
15. TEXT: Do NOT include placeholder text like "path_to_image", "PropertyParams", or other OCR artifacts. Use real, contextually appropriate text. If uncertain, use semantic defaults (e.g., "Login", "Welcome", "Username", etc.)

QUALITY STANDARDS:
- Match the exact layout, spacing, alignment, and proportions shown in the reference.
- Preserve all visible text exactly as shown (case-sensitive).
- Match colors, gradients, shadows, and visual hierarchy precisely using only Tailwind classes.
- Use appropriate semantic HTML tags.
- Ensure responsive behavior where applicable.
- Maintain accessibility (alt text, labels, ARIA where needed).

OUTPUT MUST BE: Valid, executable React code that renders immediately without errors. NO imports except React.`;
}

export function buildUserPrompt(request: UIGenerationRequest): string {
  const parts: string[] = [];
  const depth = detectPromptDepth(request.prompt);

  if (request.screenshot || request.screenshotDescription) {
    parts.push("=== SCREENSHOT CONTEXT ===");
    parts.push(
      request.screenshotDescription?.trim() ||
        "Match the visible structure and style shown in the screenshot exactly.",
    );
    parts.push("");
  }

  parts.push("=== PROMPT DEPTH ANALYSIS ===");
  if (depth === "shallow") {
    parts.push(
      "SHALLOW PROMPT DETECTED: The request is minimal/vague. You MUST intelligently improvise a polished, complete UI.",
    );
    parts.push(
      "- Infer standard UI patterns (buttons, inputs, headers, footers, sections) that fit the intent.",
    );
    parts.push("- Add reasonable default features (e.g., for a timer: start/pause/stop/reset buttons, progress bar, presets).");
    parts.push("- Do NOT ask for clarification. Do NOT output partial code.");
    parts.push("- Build a production-ready, visually polished component.");
  } else {
    parts.push(
      "DEEP PROMPT DETECTED: The request is specific and detailed. Follow the exact specifications provided.",
    );
    parts.push("- Do NOT invent additional features not mentioned.");
    parts.push("- Match exact layout, colors, labels, and behavior described.");
    parts.push("- If specifications conflict with best practices, follow the specifications.");
  }
  parts.push("");

  parts.push("=== OUTPUT RULES ===");
  parts.push("- Output only the App component code.");
  parts.push("- Do not output markdown, explanation text, or comments.");
  parts.push("- Do not import from react-dom or react-dom/client.");
  parts.push("- Do not import any CSS files, fonts, or stylesheets.");
  parts.push(
    "- Do not emit multiple default exports or missing default export.",
  );
  parts.push(
    "- Do not create any import statements except from 'react' if needed.",
  );
  parts.push("- Apply ALL styles using Tailwind className attributes only.");
  parts.push(
    "- Do not repeat words like App, placeholder labels, or filler text to pad the layout.",
  );
  parts.push("");

  if (request.previousCode?.trim()) {
    parts.push("=== CURRENT VERSION ===");
    parts.push(request.previousCode.trim());
    parts.push("");
    parts.push("=== REFINEMENT REQUEST ===");
    parts.push(request.prompt.trim());
  } else {
    parts.push("=== BUILD REQUEST ===");
    parts.push(request.prompt.trim());
  }

  parts.push("");
  parts.push(
    "Generate the complete React component NOW. Output ONLY valid JSX code with no imports except React.",
  );

  return parts.join("\n");
}

export function buildRepairPrompt(
  code: string,
  validationErrors: string[],
): string {
  return [
    "YOU MUST FIX THIS CODE. CRITICAL: Output must be: export default function App() { return (...); }",
    "",
    "INTENT: Repair the component without adding repeated filler text or generic placeholder content.",
    "",
    "REQUIRED FIXES:",
    "1. Ensure the code exports EXACTLY ONE default function named App",
    "2. The first line must start with: export default function App()",
    "3. The last line before closing brace must have a return() with JSX",
    "4. Remove all custom component tags (no <CustomComponent>, <Button>, <Card>, <DB>, etc.)",
    "5. Replace any custom components with built-in HTML elements (div, section, etc.)",
    "6. Remove all CSS file imports (no import '/App.css', etc.)",
    "7. Remove all imports except from 'react' if needed",
    "8. Ensure ALL HTML tags are properly closed and balanced (<div>...</div>)",
    "9. Apply all styles using Tailwind className attributes only",
    "10. Do not import from react-dom or react-dom/client",
    "11. IMAGES: Remove <img> tags with placeholder/broken src (path_to_image, etc.). Use SVG or colored divs instead.",
    "12. TEXT: Replace OCR artifacts and placeholder text. Use real, contextual labels (Username, Password, Login, Welcome, etc.). Remove gibberish like 'PropertyParams', 'BOOLE', etc.",
    "13. SEMANTIC HTML: Use proper semantic tags (header, main, section, footer) for better structure. Avoid nested divs with identical styling.",
    "",
    "VALIDATION ERRORS TO FIX:",
    ...validationErrors.map((error) => `- ${error}`),
    "",
    "BROKEN CODE:",
    code,
    "",
    "FIXED CODE (MUST export default function App):",
  ].join("\n");
}
