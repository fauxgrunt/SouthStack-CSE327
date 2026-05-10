import type { UIAtom } from "./uiDecomposer";

/**
 * Represents a generated UI atom with its code
 */
export interface GeneratedAtom {
  atom: UIAtom;
  code: string;
}

/**
 * Assemble individual atom components into a single App.jsx export
 * No LLM call needed - pure code assembly
 *
 * Input: Array of { atom, generatedCode }
 * Output: Complete App.jsx with all atoms imported and rendered
 */
export function assembleAtoms(generatedAtoms: GeneratedAtom[]): string {
  if (generatedAtoms.length === 0) {
    return getDefaultApp();
  }

  // Extract component names and deduplicate
  const extractedNames = generatedAtoms.map((ga, idx) => {
    const match = ga.code.match(/export\s+function\s+(\w+)/);
    return match ? match[1] : `${ga.atom.type}${idx + 1}`;
  });

  // Track seen names and create mappings for duplicates
  const seenNames = new Map<string, number>();
  const componentNames: string[] = extractedNames.map((name) => {
    const count = (seenNames.get(name) ?? 0) + 1;
    seenNames.set(name, count);
    return count === 1 ? name : `${name}${count}`;
  });

  // Rename components in code to avoid duplicates
  let componentCodes = generatedAtoms
    .map((ga, idx) => {
      let code = ga.code.trim();
      const originalName = extractedNames[idx];
      const newName = componentNames[idx];

      if (originalName !== newName) {
        // Rename the export function
        code = code.replace(
          /export\s+function\s+\w+\s*\(/,
          `export function ${newName}(`,
        );
      }

      return code;
    })
    .join("\n\n");

  // Determine layout order: Header → Main (Hero/Form/Card) → Footer
  const layoutOrder = buildLayout(generatedAtoms, componentNames);

  // Build complete App component
  const appCode = `import React from 'react';

${componentCodes}

export default function App() {
  return (
    <div className="min-h-screen bg-white">
      ${layoutOrder}
    </div>
  );
}
`;
  return appCode.trim();
}

/**
 * Build smart layout order for components
 * Order: Header → Main Content → Footer
 */
function buildLayout(
  generatedAtoms: GeneratedAtom[],
  componentNames: string[],
): string {
  // Group components by type while preserving generation order
  const headers: string[] = [];
  const navs: string[] = [];
  const heros: string[] = [];
  const forms: string[] = [];
  const cards: string[] = [];
  const inputs: string[] = [];
  const buttons: string[] = [];
  const footers: string[] = [];
  const others: string[] = [];

  for (let i = 0; i < generatedAtoms.length; i++) {
    const type = generatedAtoms[i].atom.type;
    const name = componentNames[i];
    switch (type) {
      case "Header":
        headers.push(name);
        break;
      case "Nav":
        navs.push(name);
        break;
      case "Hero":
        heros.push(name);
        break;
      case "Form":
        forms.push(name);
        break;
      case "Card":
        cards.push(name);
        break;
      case "Input":
        inputs.push(name);
        break;
      case "Button":
        buttons.push(name);
        break;
      case "Footer":
        footers.push(name);
        break;
      default:
        others.push(name);
        break;
    }
  }

  const layoutParts: string[] = [];

  // Header / Nav
  headers.forEach((h) => layoutParts.push(`<${h} />`));
  if (headers.length === 0) {
    navs.forEach((n) => layoutParts.push(`<${n} />`));
  }

  // Main content: hero first
  heros.forEach((h) => layoutParts.push(`<${h} />`));

  // Forms (centered)
  forms.forEach((f) =>
    layoutParts.push(`<div className="flex justify-center p-8"><${f} /></div>`),
  );

  // Cards (if no form, center them individually)
  if (forms.length === 0) {
    cards.forEach((c) =>
      layoutParts.push(
        `<div className="flex justify-center p-8"><${c} /></div>`,
      ),
    );
  } else {
    cards.forEach((c) => layoutParts.push(`<${c} />`));
  }

  // Inputs and Buttons (if standalone)
  if (forms.length === 0) {
    inputs.forEach((i) => layoutParts.push(`<${i} />`));
    buttons.forEach((b) =>
      layoutParts.push(
        `<div className="flex justify-center p-4"><${b} /></div>`,
      ),
    );
  }

  // Others
  others.forEach((o) => layoutParts.push(`<${o} />`));

  // Footer
  footers.forEach((f) => layoutParts.push(`<${f} />`));

  if (layoutParts.length === 0) {
    return componentNames.map((name) => `<${name} />`).join("\n      ");
  }

  return layoutParts.join("\n      ");
}

/**
 * Default fallback app if assembly fails
 */
function getDefaultApp(): string {
  return `import React from 'react';

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 to-slate-900 text-white flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold mb-4">UI Generation</h1>
        <p className="text-slate-400">Ready to generate your UI</p>
      </div>
    </div>
  );
}`;
}

/**
 * Extract component name from generated code
 */
export function extractComponentName(code: string): string {
  const match = code.match(/export\s+function\s+(\w+)/);
  return match ? match[1] : "Component";
}

/**
 * Validate that assembled code has required exports
 */
export function validateAssembly(appCode: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!appCode.includes("export default function App")) {
    errors.push("Missing default export for App component");
  }

  if (!appCode.includes("import React")) {
    errors.push("Missing React import");
  }

  if (!appCode.includes("return")) {
    errors.push("App component must return JSX");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
