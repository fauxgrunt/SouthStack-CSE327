/**
 * Parse user prompt and decompose into atomic UI components
 * Uses keyword-based detection (no LLM needed)
 */

export interface UIAtom {
  id: string;
  type:
    | "Header"
    | "Form"
    | "Input"
    | "Button"
    | "Card"
    | "Hero"
    | "Footer"
    | "Nav";
  description: string;
  complexity: "simple" | "medium" | "complex";
}

/**
 * Decompose user prompt into list of UI atoms
 * No LLM call needed - uses keyword pattern matching
 *
 * Examples:
 * - "Build a login UI" → [Header, Form, Button]
 * - "Create a landing page" → [Hero, Card, Button, Footer]
 * - "Make a dashboard" → [Nav, Card, Card, Footer]
 */
export function decomposeUI(prompt: string): UIAtom[] {
  const atoms: UIAtom[] = [];
  const lower = prompt.toLowerCase();

  // Header / Navigation
  if (
    lower.includes("header") ||
    lower.includes("nav") ||
    lower.includes("navigation") ||
    lower.includes("navbar")
  ) {
    atoms.push({
      id: "header",
      type: "Header",
      description: "App header with title/navigation",
      complexity: "medium",
    });
  }

  // Form (login, signup, contact, etc.)
  if (
    lower.includes("form") ||
    lower.includes("login") ||
    lower.includes("signin") ||
    lower.includes("sign in") ||
    lower.includes("register") ||
    lower.includes("signup") ||
    lower.includes("sign up") ||
    lower.includes("contact") ||
    lower.includes("submit")
  ) {
    atoms.push({
      id: "form",
      type: "Form",
      description: "User form with inputs",
      complexity: "complex",
    });
  }

  // Text Input
  if (
    lower.includes("input") ||
    lower.includes("text field") ||
    lower.includes("textbox") ||
    (lower.includes("form") && !atoms.some((a) => a.type === "Input"))
  ) {
    if (!atoms.some((a) => a.type === "Input")) {
      atoms.push({
        id: "input",
        type: "Input",
        description: "Text input field with label",
        complexity: "simple",
      });
    }
  }

  // Button / CTA
  if (
    lower.includes("button") ||
    lower.includes("cta") ||
    lower.includes("action") ||
    lower.includes("click") ||
    lower.includes("submit")
  ) {
    if (!atoms.some((a) => a.type === "Button")) {
      atoms.push({
        id: "button",
        type: "Button",
        description: "Clickable action button",
        complexity: "simple",
      });
    }
  }

  // Card / Container
  if (
    lower.includes("card") ||
    lower.includes("box") ||
    lower.includes("container") ||
    lower.includes("panel") ||
    lower.includes("widget")
  ) {
    atoms.push({
      id: "card",
      type: "Card",
      description: "Card container component",
      complexity: "medium",
    });
  }

  // Hero Section
  if (
    lower.includes("hero") ||
    lower.includes("landing") ||
    lower.includes("banner") ||
    lower.includes("jumbotron")
  ) {
    atoms.push({
      id: "hero",
      type: "Hero",
      description: "Hero/banner section",
      complexity: "complex",
    });
  }

  // Footer
  if (lower.includes("footer") || lower.includes("bottom")) {
    atoms.push({
      id: "footer",
      type: "Footer",
      description: "Footer with links/info",
      complexity: "simple",
    });
  }

  // If no atoms detected, use Hero as default
  if (atoms.length === 0) {
    atoms.push({
      id: "hero",
      type: "Hero",
      description: "Hero/main content section",
      complexity: "medium",
    });
  }

  // Always wrap with App container (use Card as wrapper)
  if (!atoms.some((a) => a.id === "app")) {
    atoms.push({
      id: "app",
      type: "Card",
      description: "App wrapper/main container",
      complexity: "simple",
    });
  }

  return atoms;
}

/**
 * Get estimated token count for atom generation
 */
export function estimateAtomTokens(atom: UIAtom): number {
  const estimates: Record<UIAtom["type"], number> = {
    Header: 250,
    Form: 400,
    Input: 150,
    Button: 100,
    Card: 200,
    Hero: 300,
    Footer: 150,
    Nav: 250,
  };

  return estimates[atom.type] || 200;
}
