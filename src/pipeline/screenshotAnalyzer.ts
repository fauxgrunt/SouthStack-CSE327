import { extractUIFromImage } from "../services/LocalVisionProcessor";

/**
 * Detailed screenshot analysis for image-driven UI generation
 * Extracts specific UI elements, layout, colors, and styling information
 */

export interface UIElement {
  type:
    | "header"
    | "form"
    | "button"
    | "input"
    | "card"
    | "text"
    | "icon"
    | "image"
    | "navigation"
    | "footer"
    | "other";
  description: string;
  position:
    | "top"
    | "middle"
    | "bottom"
    | "full-width"
    | "centered"
    | "left"
    | "right";
  colors?: string[];
  estimatedSize?: "small" | "medium" | "large" | "full";
}

export interface ScreenshotAnalysis {
  overallDescription: string;
  dominantColors: string[];
  layout: "single-column" | "two-column" | "three-column" | "grid" | "hero";
  elements: UIElement[];
  hasForm: boolean;
  hasNavigation: boolean;
  hasHeader: boolean;
  hasFooter: boolean;
  estimatedComplexity: "simple" | "medium" | "complex";
  uiGenerationPrompt: string;
}

async function extractImageCaption(imageData: string): Promise<string> {
  try {
    return await extractUIFromImage(imageData);
  } catch (error) {
    console.warn("[ScreenshotAnalyzer] Failed to extract caption:", error);
    return "";
  }
}

function detectLayout(description: string): ScreenshotAnalysis["layout"] {
  const lower = description.toLowerCase();

  if (
    lower.includes("grid") ||
    lower.includes("gallery") ||
    lower.includes("cards in a grid")
  ) {
    return "grid";
  }
  if (
    lower.includes("two-column") ||
    lower.includes("left sidebar") ||
    lower.includes("sidebar")
  ) {
    return "two-column";
  }
  if (lower.includes("three-column")) {
    return "three-column";
  }
  if (
    lower.includes("hero") ||
    lower.includes("banner") ||
    lower.includes("full-width header")
  ) {
    return "hero";
  }
  return "single-column";
}

function detectColors(description: string): string[] {
  const colorPatterns = {
    blue: /\b(blue|navy|cobalt|azure|indigo)\b/i,
    red: /\b(red|crimson|scarlet|burgundy)\b/i,
    green: /\b(green|emerald|olive|sage|teal)\b/i,
    purple: /\b(purple|violet|lavender|indigo)\b/i,
    yellow: /\b(yellow|gold|amber|orange)\b/i,
    pink: /\b(pink|rose|magenta|hot pink)\b/i,
    gray: /\b(gray|grey|silver|charcoal|slate)\b/i,
    white: /\b(white|light|bright)\b/i,
    black: /\b(black|dark|dark)\b/i,
  };

  const colors: string[] = [];
  for (const [color, pattern] of Object.entries(colorPatterns)) {
    if (pattern.test(description)) {
      colors.push(color);
    }
  }

  return colors.length > 0 ? colors : ["blue", "white"];
}

function parseElements(description: string): UIElement[] {
  const elements: UIElement[] = [];
  const lower = description.toLowerCase();

  // Detect header
  if (/header|logo|title at the top|navigation bar/i.test(description)) {
    elements.push({
      type: "header",
      description: "Header with logo/title",
      position: "top",
      estimatedSize: "medium",
    });
  }

  // Detect form
  if (
    /form|input fields|login|sign up|email field|password/i.test(description)
  ) {
    elements.push({
      type: "form",
      description: "Form with input fields",
      position: "centered",
      estimatedSize: "medium",
    });
  }

  // Detect buttons
  if (/button|submit|click|cta|action/i.test(description)) {
    elements.push({
      type: "button",
      description: "Interactive button(s)",
      position: lower.includes("footer") ? "bottom" : "middle",
      estimatedSize: "small",
    });
  }

  // Detect input fields
  if (/input|field|text box|search/i.test(description)) {
    const count = (description.match(/input|field|box/gi) || []).length;
    elements.push({
      type: "input",
      description: `Input field${count > 1 ? "s" : ""}`,
      position: "middle",
      estimatedSize: "small",
    });
  }

  // Detect cards
  if (/card|box|container|section|item/i.test(description)) {
    elements.push({
      type: "card",
      description: "Card or container component",
      position: "middle",
      estimatedSize: "medium",
    });
  }

  // Detect navigation
  if (/nav|menu|link|sidebar/i.test(description)) {
    elements.push({
      type: "navigation",
      description: "Navigation component",
      position: lower.includes("side") ? "left" : "top",
      estimatedSize: lower.includes("side") ? "small" : "medium",
    });
  }

  // Detect footer
  if (/footer|bottom|copyright/i.test(description)) {
    elements.push({
      type: "footer",
      description: "Footer",
      position: "bottom",
      estimatedSize: "medium",
    });
  }

  // If no specific elements detected, create a generic one based on description
  if (elements.length === 0 && description.trim()) {
    elements.push({
      type: "other",
      description: description.substring(0, 100),
      position: "full-width",
      estimatedSize: "large",
    });
  }

  return elements;
}

function estimateComplexity(
  elements: UIElement[],
  description: string,
): ScreenshotAnalysis["estimatedComplexity"] {
  const elementCount = elements.length;
  const hasForm = elements.some((e) => e.type === "form");
  const hasMultipleCards =
    elements.filter((e) => e.type === "card").length >= 2;
  const isLongDescription = description.length > 200;

  if (elementCount >= 5 || (hasForm && hasMultipleCards) || isLongDescription) {
    return "complex";
  }
  if (elementCount >= 3 || (hasForm && !hasMultipleCards)) {
    return "medium";
  }
  return "simple";
}

function buildGenerationPrompt(analysis: ScreenshotAnalysis): string {
  const parts = [
    "Generate React code that visually matches the following screenshot analysis:\n",
    `Overall appearance: ${analysis.overallDescription}`,
    `Layout style: ${analysis.layout}`,
  ];

  if (analysis.dominantColors.length > 0) {
    parts.push(`Dominant colors: ${analysis.dominantColors.join(", ")}`);
  }

  if (analysis.elements.length > 0) {
    parts.push("\nUI Elements to include:");
    analysis.elements.forEach((el, idx) => {
      parts.push(
        `${idx + 1}. ${el.type.toUpperCase()}: ${el.description} (position: ${el.position})`,
      );
    });
  }

  parts.push(
    "\nIMPORTANT: Use Tailwind CSS to recreate the exact visual appearance.",
    "Match the layout, spacing, colors, and component sizes as closely as possible.",
    "Do NOT use placeholder text like 'Lorem Ipsum' or generic templates.",
    "Create real, specific UI that matches the screenshot's actual content and structure.",
  );

  return parts.join("\n");
}

/**
 * Analyze a screenshot and extract detailed UI structure information
 */
export async function analyzeScreenshot(
  imageData: string,
): Promise<ScreenshotAnalysis> {
  const caption = await extractImageCaption(imageData);

  const layout = detectLayout(caption);
  const colors = detectColors(caption);
  const elements = parseElements(caption);
  const complexity = estimateComplexity(elements, caption);

  return {
    overallDescription: caption,
    dominantColors: colors,
    layout,
    elements,
    hasForm: elements.some((e) => e.type === "form"),
    hasNavigation: elements.some((e) => e.type === "navigation"),
    hasHeader: elements.some((e) => e.type === "header"),
    hasFooter: elements.some((e) => e.type === "footer"),
    estimatedComplexity: complexity,
    uiGenerationPrompt: buildGenerationPrompt({
      overallDescription: caption,
      dominantColors: colors,
      layout,
      elements,
      hasForm: elements.some((e) => e.type === "form"),
      hasNavigation: elements.some((e) => e.type === "navigation"),
      hasHeader: elements.some((e) => e.type === "header"),
      hasFooter: elements.some((e) => e.type === "footer"),
      estimatedComplexity: complexity,
      uiGenerationPrompt: "", // Will be set after
    }),
  };
}
