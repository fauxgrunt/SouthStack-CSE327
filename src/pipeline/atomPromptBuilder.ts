import type { UIAtom } from "./uiDecomposer";

/**
 * Build minimal system + user prompts for each UI atom
 * Target: ~40 token system prompt + ~50 token user prompt
 * Expected output: 200-500 tokens
 * Total: < 700 tokens (fits comfortably in context window)
 */

export interface AtomPrompt {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = `You are a React UI component generator that MUST match the provided screenshot exactly.
Generate ONLY valid JSX code. No explanations.

CRITICAL RULES:
- Match the screenshot's visual design, colors, layout, and typography exactly
- Do NOT use generic templates or placeholder UI
- Do NOT use Lorem Ipsum or placeholder text
- Generate specific UI content based on the screenshot
- All <tags> must have matching </tags> or be self-closing />
- All parentheses ( ) and braces { } must be balanced
- All expressions in {} must be complete and valid

STYLING:
- Use Tailwind CSS for all styling
- Use colors that match the screenshot (e.g., colors extracted from analysis)
- Use the same spacing and padding as the screenshot
- Match the font sizes and weights shown
- Recreate shadows, borders, and effects from the screenshot

CODE REQUIREMENTS:
- Use React hooks if needed (useState, useEffect)
- No external imports or remote assets
- One named export function per component
- Max 25 lines of code
- Return valid, compilable code ONLY
- Do not use placeholder images or remote URLs; use CSS backgrounds, gradients, or inline SVG instead

VALIDATION:
- ALWAYS validate that all JSX is properly closed before output
- Check that all Tailwind classes are valid
- Ensure the code compiles without errors`;

export function buildAtomPrompt(atom: UIAtom, userContext: string): AtomPrompt {
  const isScreenshotDriven =
    /screenshot context \(source of truth\)|CRITICAL:|Dominant colors:|Layout style:/i.test(
      userContext,
    );

  const atomPrompts: Record<UIAtom["type"], string> = {
    Header: `Generate a React Header component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: This MUST match the screenshot's header design exactly. Use the same colors, spacing, typography, and layout." : ""}
Include only what's shown in the screenshot:
- Logo/title (if present)
- Navigation items (if shown)
- Styling that matches the screenshot exactly
Export as: export function Header() { ... }`,

    Form: `Generate a React Form component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: This MUST match the screenshot's form design exactly. Recreate the form layout, field order, labels, button placement, and styling." : ""}
Include only what's shown in the screenshot:
- Form fields (in the order shown)
- Labels (with the same text as screenshot)
- Submit button (with correct styling)
- Validation or helper text (if visible)
Export as: export function Form() { ... }`,

    Input: `Generate a React Input component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: Match the screenshot's input styling exactly - same width, border style, padding, and placeholder text." : ""}
Include only what's shown in the screenshot:
- Label (if present)
- Input field with correct placeholder text
- Styling that matches the screenshot
Export as: export function Input() { ... }`,

    Button: `Generate a React Button component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: Match the screenshot's button size, color, padding, and text exactly." : ""}
Include only what's shown in the screenshot:
- Button text (exact text from screenshot)
- Click handler (empty function)
- Styling that matches the screenshot exactly
Export as: export function Button() { ... }`,

    Card: `Generate a React Card component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: Match the screenshot's card design exactly - same border, shadow, padding, and layout." : ""}
Include only what's shown in the screenshot:
- Container with correct border/shadow
- Content arranged as shown
- Styling that matches the screenshot
Export as: export function Card() { ... }`,

    Hero: `Generate a React Hero/Banner component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: Match the screenshot's hero section exactly - same layout, colors, text, and styling." : ""}
Include only what's shown in the screenshot:
- Large heading (exact text from screenshot)
- Subheading/description (if shown)
- Call-to-action button (if present)
- Background styling using Tailwind gradients or CSS shapes (no remote images)
Export as: export function Hero() { ... }`,

    Footer: `Generate a React Footer component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: Match the screenshot's footer styling, text, and layout exactly." : ""}
Include only what's shown in the screenshot:
- Footer text/content (exact text if visible)
- Links (if shown)
- Styling that matches the screenshot
Export as: export function Footer() { ... }`,

    Nav: `Generate a React Nav component that visually matches the screenshot.
Context: ${userContext}
${isScreenshotDriven ? "\nREQUIREMENT: Match the screenshot's navigation styling and layout exactly." : ""}
Include only what's shown in the screenshot:
- Navigation menu items (same items/order as shown)
- Styling that matches the screenshot
- Logo (if present)
- Links/items
- Responsive styling
- Tailwind styling
Export as: export function Nav() { ... }`,
  };

  const userPrompt = atomPrompts[atom.type] || atomPrompts.Card;

  return {
    system: SYSTEM_PROMPT,
    user: userPrompt,
  };
}

/**
 * Build repair prompt for failed atom generation
 */
export function buildAtomRepairPrompt(
  atom: UIAtom,
  failedCode: string,
  errors: string[],
): AtomPrompt {
  const errorSummary = errors.slice(0, 3).join("\n");

  return {
    system: SYSTEM_PROMPT,
    user: `CRITICAL: Fix syntax errors in React ${atom.type} component.

ERRORS TO FIX:
${errorSummary}

Failed attempt:
\`\`\`
${failedCode}
\`\`\`

REQUIREMENTS:
- All JSX tags MUST be properly closed (no unclosed <div>, <input>, etc.)
- All parentheses and braces MUST be balanced
- All expressions in curly braces must be complete
- Use exactly this structure:
export function ${atom.type}() {
  return (
    <div className="...">
      {/* content here */}
    </div>
  );
}

Output ONLY valid JSX. No explanations.`,
  };
}
