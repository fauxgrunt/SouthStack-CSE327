# Auto-Detection: "Build This" Prompts

## Overview

The UI Builder now supports **automatic detection** of simple "build this" style prompts. When faculty or users say just a few words like "build this" or "create this" **with an attached image**, the system automatically:

1. ✅ **Skips task decomposition** (AI breaking down into subtasks)
2. ✅ **Goes directly to code generation**
3. ✅ **Processes the image through the Dual-Extraction Pipeline** (Vision + OCR in parallel)
4. ✅ **Generates React code immediately**

This dramatically speeds up the build pipeline for simple requests.

## Recognized Prompts

The auto-detection recognizes these patterns:

### Direct Requests

- `"build this"`
- `"build it"`
- `"build"`
- `"create this"`
- `"create"`
- `"generate this"`
- `"generate"`
- `"make this"`
- `"make"`
- `"implement this"`
- `"implement"`

### Code-Specific

- `"code this"`
- `"code it"`
- `"code"`
- `"convert to react"`
- `"convert to code"`

### Replication Requests

- `"replicate this"`
- `"replicate"`
- `"recreate this"`
- `"recreate"`
- `"from image"`

All patterns are **case-insensitive** and ignore extra whitespace/punctuation.

## How It Works

### Step 1: Detect Prompt

```typescript
import { isBuildThisPrompt } from "../utils/buildPromptDetector";

const isSimpleRequest = isBuildThisPrompt(userPrompt);
// Returns true for "build this", false for "build a login form with..."
```

### Step 2: Check Prerequisites

```typescript
import { shouldSkipDecomposition } from "../utils/buildPromptDetector";

const skipDecomp = shouldSkipDecomposition(
  userPrompt, // "build this"
  hasImage, // true (image attached)
  lowEndMode, // false (normal mode)
);
// Returns true only if ALL conditions are met
```

### Step 3: Route Directly to Generation

When triggered, the system:

1. Extracts image via Dual-Extraction Pipeline (parallel OCR + Vision)
2. Builds a task payload for code generation
3. **Bypasses the task decomposition stage entirely**
4. Sends directly to worker for React code generation

## User Feedback

Users see immediate feedback:

### In Master Console

```
🎯 Auto-detected 'build this' request with image attachment.
   Skipping task decomposition and going directly to code generation...
```

### In Worker Terminal

```
[Worker Status] 🎯 Auto-detected 'build this' prompt - skipping task
                 decomposition and going directly to code generation...
```

## Time Savings

For a typical login form:

| Scenario                                       | Time Saved                                          |
| ---------------------------------------------- | --------------------------------------------------- |
| "build this" with image                        | ~30-40% faster (skips decomposition)                |
| Generic prompt (e.g., "build a login form...") | Normal flow                                         |
| Low-end mode                                   | Auto-detection disabled (always uses decomposition) |

## Implementation Files

- **Detector Logic**: [src/utils/buildPromptDetector.ts](../src/utils/buildPromptDetector.ts)
- **IDE Integration**: [src/components/AgenticIDE.tsx](../src/components/AgenticIDE.tsx) (lines ~433-460)
- **Worker Handler**: [src/components/AgenticIDE.tsx](../src/components/AgenticIDE.tsx) (lines ~766-783)

## For Faculty

Just say:

1. **Upload an image** of the UI you want built
2. **Type a simple prompt** like:
   - "build this"
   - "create this"
   - "build it"
   - "generate this UI"

The system will automatically detect the request and generate the React code in one shot, skipping unnecessary processing stages.

## Fallback Behavior

- If **no image is attached** → Auto-detection disabled, uses normal flow
- If **prompt is complex** (e.g., "build a login form with...") → Uses normal flow with task decomposition
- If **low-end mode is active** → Auto-detection disabled (uses decomposition for better control)
- If **image analysis fails** → Falls back gracefully, doesn't crash

## Configuration

To modify recognized patterns, edit [src/utils/buildPromptDetector.ts](../src/utils/buildPromptDetector.ts):

```typescript
const BUILD_PROMPT_PATTERNS = [
  /^build\s+(this|it|that|a\s+ui|a\s+page|a\s+screen|me)?$/i,
  // Add more patterns here
];
```

## Logging

For debugging, check console logs with the `[BuildPromptDetector]` prefix:

```javascript
[BuildPromptDetector] Analyzing: "build this" {
  isBuildPrompt: true,
  hasAttachedImage: true,
  lowEndMode: false,
  skippingDecomposition: true
}
```
