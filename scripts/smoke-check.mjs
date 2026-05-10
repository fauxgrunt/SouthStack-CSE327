import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const validation = read("src/pipeline/validation.ts");
const generator = read("src/hooks/useUIGenerator.ts");
const builder = read("src/hooks/useUIBuilder.ts");
const webcontainer = read("src/services/webcontainer.ts");
const loop = read("src/hooks/useAgenticLoop.ts");

assert(
  validation.includes("export const FALLBACK_UI") &&
    validation.includes("<form") &&
    validation.includes("<input"),
  "Fallback UI should remain a valid form-based component.",
);

assert(
  generator.includes("validationPassed: fallbackValidation.valid") &&
    generator.includes("code: FALLBACK_UI") &&
    generator.includes(
      "Final repair did not pass validation; using fallback UI.",
    ),
  "Generator should fall back to a validated safe UI when repair fails.",
);

assert(
  webcontainer.includes("server-ready") &&
    webcontainer.includes("serverUrlByPort") &&
    builder.includes("waitForServerUrl(4173") &&
    builder.includes("codeForPreview"),
  "Preview path should rely on server-ready mapping and preserve the best preview code.",
);

assert(
  loop.includes("generatedCode: result.code") &&
    loop.includes("Generated code needed fallback repair."),
  "Agent loop should keep code available even when validation falls back.",
);

console.log(
  "Smoke check passed: fallback, preview, and agent-loop invariants are present.",
);
