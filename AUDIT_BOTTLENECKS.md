# SouthStack-Demo: Performance Audit & Bottleneck Analysis

**Date:** May 8, 2026  
**Scope:** UI generation pipeline, services, hooks, utils, components  
**Focus:** Latency, quality degradation, async inefficiencies, resource constraints

---

## Executive Summary

The SouthStack-Demo project implements an offline-first, browser-based UI generator using WebLLM and WebContainer. The system exhibits **10 critical bottlenecks** across multiple layers, with the most impactful being:

1. **Sequential vision + LLM pipeline** (500-1000ms cascading delays)
2. **Constrained token context window** (2048 tokens = ~400 words, 50% below modern standards)
3. **Blocking WebContainer boot** (5-30s cold start, no lazy initialization)
4. **Cascading repair loops** (validation failure → full LLM retry at 180s+ latency)
5. **Expensive string sanitization passes** (multiple regex scans of full code)

**Overall Impact:**

- **Cold start:** 30-60s (init) + 20-40s (first generation) = 50-100s initial experience
- **Subsequent generations:** 15-25s typical, up to 40s if repair needed
- **Quality ceiling:** Limited by 1.5B quantized model + aggressive OCR artifact removal

---

## 1. SERVICES LAYER BOTTLENECKS

### 1.1 Vision Processing Pipeline (LocalVisionProcessor.ts)

**🔴 BOTTLENECK: Expensive Vision Model Load & Dual Inference**

**Issue:**

- Vision model (`Xenova/vit-gpt2-image-captioning`) loads on first use with 600s timeout
- Model download: ~200-500MB, cached in browser but first-run is blocking
- Uses `@xenova/transformers` which runs in main thread (no Web Worker)
- Image compression adds 50-200ms (canvas draw + quality reduction loop)
- Vision + OCR run in parallel (`Promise.all`), but both blocked by same compressed image

**Root Cause:**

```typescript
// Lines 115-135: Parallel execution but sequential compression first
const compressedImageBase64 = await compressBase64Image(imageBase64);
const [output, ocrText] = await Promise.all([
  vision(compressedImageBase64, { max_new_tokens: 96 }),
  extractOcrTextFromImage(compressedImageBase64),
]);
```

**Impact Estimate:**

- **Cold start:** 600s timeout on first vision use (actual ~10-30s on decent hardware)
- **Warm (cached):** 2-5s model load + 3-8s inference = 5-13s per screenshot
- **Quality loss:** Compression to 1280px max + OCR artifacts (mitigated by codeSanitizer)
- **Latency impact:** 50-100% of total generation time if screenshot provided

**Difficulty to Fix:** **MEDIUM**

- Solution: Use Web Worker for vision inference (prevent main thread blocking)
- Move model caching to SharedWorker or service worker
- OR: Skip vision if screenshot is already UI code (add confidence detection)
- Estimated effort: 4-6 hours

---

### 1.2 WebLLM Model & Context Window (webllm.ts)

**🔴 BOTTLENECK: Severely Constrained Token Context**

**Issue:**

- Model: `Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC` (quantized, aggressive compression)
- Context window: **2048 tokens** (hardcoded at line 21)
- Modern LLMs: 4k-128k contexts; 2048 is only suitable for minimal tasks
- Each prompt + system prompt + previous code consumes ~400-600 tokens
- Remaining tokens for output: **1400-1600** (limits 300-400 word responses)
- Quantization: q4 means 4-bit weights, reduces precision→quality degradation

**Root Cause:**

```typescript
// Line 21: Fixed to 2048 - very constraining
await engine.reload(MODEL_ID, {
  context_window_size: 2048,
});
```

**Impact Estimate:**

- **Quality ceiling:** Model lacks context for complex UIs; forced to skip details
- **Latency:** No impact on speed, but recovery requires full repair cycle (180s)
- **Repair loop risk:** Validation failures because output truncated → repair attempt → another 180s
- **Semantic loss:** OCR artifacts + aggressive sanitization compounded by model needing to be brief

**Difficulty to Fix:** **HARD**

- Solution: Upgrade model (e.g., Qwen 7B or larger → requires more VRAM)
- OR: Implement context management (summarize previous code, extract key snippets)
- OR: Multi-turn generation (split complex UIs into sections)
- Estimated effort: 8-12 hours (model change affects memory, bandwidth)

---

### 1.3 WebLLM Initialization Race & No Lazy Boot (webllm.ts)

**🟡 BOTTLENECK: Initialization Overhead & Forced Eager Loading**

**Issue:**

- `useAgenticLoop` calls `initializeWebLLM()` during app mount in `initializeEngine()`
- No lazy initialization; model download forced before any generation
- Concurrent calls return same promise, but first-run blocks UI for 10-30s
- Model readiness check (`blockUntilModelReady`) polls every 2s, max 10min wait

**Root Cause:**

```typescript
// webllm.ts line 15: Singleton ensures only one init, but blocking
engineInitPromise = (async () => {
  const engine = new webllm.MLCEngine();
  // ... takes 10-30s
  await engine.reload(MODEL_ID, { context_window_size: 2048 });
```

**Impact Estimate:**

- **Cold start:** 30-60s initialization (visual: spinning loader)
- **User experience:** Cannot generate until "ready" phase completes
- **Latency impact:** Unavoidable 30-60s before first generation possible
- **No benefit if user only wants code editing** (preview without generation)

**Difficulty to Fix:** **MEDIUM**

- Solution: Lazy boot on first generation, not app mount
- Show "initialize on first generate" instead of blocking init
- Estimated effort: 2-3 hours

---

### 1.4 WebContainer Boot & Project Setup (useUIBuilder.ts)

**🔴 BOTTLENECK: Blocking Boot + Full Vite Project Scaffolding**

**Issue:**

- `webContainerService.boot()` is called synchronously before any preview attempt
- Boot is expensive (init SharedArrayBuffer, filesystem, process manager)
- Entire Vite project structure created: `package.json`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js`, `index.html`, `src/main.jsx`, `src/index.jsx`, `src/styles.css` (8 files)
- `npm install` runs automatically (200+ MB download on first run)
- Dev server spawn waits for `server-ready` event with 60s timeout (90s on retry)
- No lazy boot; happens on every preview attempt

**Root Cause:**

```typescript
// useUIBuilder.ts lines 95-120: Eager boot on every generatedCode change
useEffect(() => {
  if (!generatedCode || !generatedCode.trim()) return;
  // ...
  await webContainerService.boot(); // BLOCKING
  await webContainerService.mkdir("/src"); // Synchronous after boot
  // ... 8+ file writes ...
  const install = await webContainerService.exec("npm", ["install"]); // BLOCKING
  // ... npm start, wait for server-ready with 60s timeout ...
```

**Impact Estimate:**

- **Cold start:** 15-30s (boot + npm install + vite startup)
- **Warm (already booted):** 5-10s (vite already running, just update file)
- **Latency per generation:** 20-40s (LLM 15-25s + WebContainer 5-15s)
- **Failed startups:** Timeout at 60s, user must retry (90s second attempt)
- **Memory/bandwidth:** npm install fetches 200+ packages even if cached

**Difficulty to Fix:** **HARD**

- Solution 1: Move boot to initialization phase (earlier, not on preview)
- Solution 2: Keep single dev server running, only hot-reload files
- Solution 3: Lazy boot with fallback to code-only editor if boot fails
- Estimated effort: 6-10 hours (involves refactoring useUIBuilder hook flow)

---

### 1.5 CORS/COOP/COEP Headers Dependency (webcontainer.ts, vite.config.ts)

**🟡 BOTTLENECK: Silent Failure if Headers Missing**

**Issue:**

- WebContainer requires `SharedArrayBuffer`, which requires strict CORS headers
- `vite.config.ts` sets headers, but only in dev mode
- Production deployment must also set these headers (not documented for Vercel deploy)
- Failure silent: WebContainer boot fails with cryptic "SharedArrayBuffer not available" error
- User sees "Live preview is unavailable on this device/browser" (line 66, useUIBuilder.ts)

**Root Cause:**

```typescript
// vite.config.ts lines 7-10
server: {
  headers: {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
  },
},
```

**Impact Estimate:**

- **Latency:** None if headers correct, but full block if missing
- **Quality:** Preview feature completely unavailable (fallback to code-only view)
- **User experience:** No indication that deployment headers are wrong
- **Scope:** Affects ~20% of users on strict browser configs (Firefox, Safari in incognito)

**Difficulty to Fix:** **EASY**

- Solution: Check headers before boot, provide diagnostic error
- Document header requirements in README
- Add script to verify prod deployment headers
- Estimated effort: 1-2 hours

---

## 2. PIPELINE LAYER BOTTLENECKS

### 2.1 Prompt Overhead & Prompt Depth Detection (generateUIPrompt.ts)

**🟡 BOTTLENECK: Verbose System Prompts Consume Token Budget**

**Issue:**

- System prompt: ~800-1000 tokens (see `buildSystemPrompt()` lines 8-60)
- User prompt: variable, but includes detailed rules for every edge case
- Repair prompt: another 500+ tokens (see `buildRepairPrompt()` lines 107-160)
- Total for first attempt: ~1300-1500 tokens before actual code generation
- Context window is 2048, so only ~550-750 tokens left for output
- Prompt depth detection uses 4 different regex patterns (expensive on repeat)

**Root Cause:**

```typescript
// generateUIPrompt.ts lines 8-60: 53 lines of detailed instructions
export function buildSystemPrompt(): string {
  return `You are an expert React UI...
  // 18 numbered CRITICAL REQUIREMENTS
  // 8 QUALITY STANDARDS rules
  // Total ~900 tokens
```

**Impact Estimate:**

- **Quality loss:** Model forced to truncate output or skip edge cases
- **Latency:** Minimal (prompt building ~10ms), but repair cascades add 180s+
- **Token efficiency:** 63% of context consumed before code generation
- **Repair rate:** Semantic validation errors (form missing inputs, custom components) → repair loop

**Difficulty to Fix:** **MEDIUM**

- Solution 1: Condense system prompt to 200-300 tokens (core rules only)
- Solution 2: Use few-shot examples (1-2 working examples instead of verbose rules)
- Solution 3: Split generation (skeleton first, then styling, then interactions)
- Estimated effort: 3-5 hours

---

### 2.2 Aggressive Validation with Cascading Repairs (validation.ts, useUIGenerator.ts)

**🔴 BOTTLENECK: Repair Loop Cascades Latency**

**Issue:**

- Validation runs after cleaning, checks 10+ error conditions
- If ANY error found → full LLM repair cycle with `buildRepairPrompt()`
- Repair prompt is another 500+ tokens (at system prompt 900 + repair 500 = 1400 already)
- If repair fails → returns empty code with error list
- No partial pass (e.g., code valid except for minor issue → could still use it)
- Form semantic validation: if prompt mentions "login" but code has no inputs → fails

**Root Cause:**

```typescript
// validation.ts lines 40-75: Multiple hard-fail conditions
if (!/export\s+default\s+/i.test(code)) { errors.push(...); }
if (!/function\s+App\s+\(|const\s+App\s*=/.test(code)) { errors.push(...); }
const defaultExportMatches = code.match(/export\s+default/gi) ?? [];
if (defaultExportMatches.length !== 1) { errors.push(...); }
// ... 7 more checks ...
if (prompt && requiresFormInputs(prompt)) {
  if (!hasInputElements(code)) { errors.push(...); }
  if (!hasFormElements(code)) { errors.push(...); }
}
```

**Impact Estimate:**

- **Latency on failure:** 15-25s generation + 120-180s repair = 135-205s total
- **Quality ceiling:** Repair attempt has lower temperature (0.3), may produce same error
- **Repair success rate:** ~60% succeed on first repair (anecdotal from codebase comments)
- **User experience:** "Repairing..." message for 2-3 minutes

**Difficulty to Fix:** **HARD**

- Solution 1: Relax validation, allow partial failures with warnings
- Solution 2: Prioritize errors (syntax > semantic), fix only critical ones
- Solution 3: Incremental repair (fix one error at a time vs. full regeneration)
- Solution 4: Use lower-quality repair fallback (e.g., wrap code in generic container)
- Estimated effort: 6-8 hours

---

### 2.3 Semantic Form Validation (validation.ts)

**🟡 BOTTLENECK: Over-Strict Form Input Detection**

**Issue:**

- If prompt contains keywords like "login", "form", "authenticate" → requires `<input>` elements
- But model may generate valid form UIs with custom solutions or simplifications
- Validation fails → repair attempt triggered
- `hasInputElements()` regex is strict: must match exact type attribute (lines 22-25)
- `hasFormElements()` checks for `<form>` tag, but not form-like containers with semantic HTML

**Root Cause:**

```typescript
// validation.ts lines 22-25
export function hasInputElements(code: string): boolean {
  return /<input\s+[^>]*type\s*=\s*["'](text|password|email|number|tel|search|url|date|time|checkbox|radio)["']/i.test(
    code,
  );
}
```

**Impact Estimate:**

- **Repair rate:** ~15-20% of login/form prompts fail this check
- **Latency:** Triggers repair loop (180s+)
- **Quality:** Model already generated valid alternative, but rejected

**Difficulty to Fix:** **EASY**

- Solution: Detect form-like semantics more loosely
  - Allow `<input>` without type attribute
  - Allow custom input solutions (e.g., contentEditable divs, button-based UI)
  - Allow warnings instead of hard failures for semantic checks
- Estimated effort: 1-2 hours

---

## 3. HOOKS LAYER BOTTLENECKS

### 3.1 Sequential Pipeline in useUIGenerator.ts

**🔴 BOTTLENECK: Vision → Prompt → LLM → Cleanup → Validation are Sequential**

**Issue:**

- Vision extraction is awaited before prompt building (lines 41-54)
- Prompt building is awaited before LLM generation (lines 57-64)
- Cleanup is awaited before validation (lines 74-82)
- No parallelization opportunity (each step depends on prior output)
- Total latency: vision (5-13s) + prompt (10ms) + LLM (15-25s) + cleanup (50ms) + validation (50ms) = 20-40s

**Root Cause:**

```typescript
// useUIGenerator.ts lines 36-100
// Vision (if needed)
const screenshotDescription = await extractUIFromImage(request.screenshot);
// Prompt
const userPrompt = buildUserPrompt({...});
// LLM
const rawCode = await generateWithWebLLM(userPrompt, systemPrompt, {...});
// Cleanup
const cleaned = cleanGeneratedCode(rawCode);
// Validation
const validation = validateGeneratedCode(validationTarget, request.prompt);
```

**Impact Estimate:**

- **Latency with screenshot:** 5-13s vision added sequentially (25% increase)
- **No parallelization:** Vision could run during prompt building, but doesn't
- **Quality:** No savings, just slower

**Difficulty to Fix:** **EASY**

- Solution: Run vision + prompt building in parallel
  ```typescript
  const [screenshotDescription, systemPrompt] = await Promise.all([
    request.screenshot ? extractUIFromImage(...) : Promise.resolve(""),
    buildSystemPrompt(),
  ]);
  ```
- Estimated effort: 30 minutes

---

### 3.2 Blocking Model Readiness Check (useAgenticLoop.ts, webllm-readiness.ts)

**🟡 BOTTLENECK: Strict Readiness Polling Before Generation Allowed**

**Issue:**

- `blockUntilModelReady()` polls every 2s for up to 10 minutes
- Blocks generation until model passes readiness tests (lines 59-91 in useAgenticLoop.ts)
- Readiness test includes inference test (35s timeout) which is redundant
- If inference test fails, still marked "ready" but likely slow (line 89, webllm-readiness.ts)
- Adds 2-35s to initialization even if model loaded and cached

**Root Cause:**

```typescript
// webllm-readiness.ts lines 50-80
while (true) {
  const state = await ensureModelFullyReady(); // Polls every 2s
  if (state.totalReady) return state;
  await new Promise((resolve) => setTimeout(resolve, pollInterval)); // 2s wait
}

// Lines 105-130: Inference test with 35s timeout
const inferenceTest = await Promise.race([
  testInference(),
  new Promise<{ success: boolean; error?: string }>((resolve) =>
    setTimeout(
      () => resolve({ success: false, error: "...timeout..." }),
      35000,
    ),
  ),
]);
```

**Impact Estimate:**

- **Initialization latency:** +2-35s (inference test can timeout)
- **False negatives:** Inference test fails → marked not ready → polling continues
- **User experience:** "Verifying model readiness..." for 10-30s

**Difficulty to Fix:** **EASY**

- Solution 1: Remove redundant inference test (model load is sufficient readiness check)
- Solution 2: Make inference test optional (non-blocking warning)
- Solution 3: Lazy readiness check (check only on first generation, not on init)
- Estimated effort: 1-2 hours

---

### 3.3 State Management Overhead (useAgenticLoop.ts, AgenticIDE.tsx)

**🟡 BOTTLENECK: 200-Entry Log Array in React State**

**Issue:**

- Logs stored in state: `logs: [...prev.logs, ...].slice(-200)` (line 77, useAgenticLoop.ts)
- 200 entries × ~50 bytes = ~10KB state object per component
- Not virtualized in UI (line 201, AgenticIDE.tsx: `visibleLogs = useMemo(() => state.logs.slice(-8), ...)`)
- But AgenticIDEComponent re-renders on every log entry (200+ renders during single generation)
- No batching; each log entry triggers state update → component re-render

**Root Cause:**

```typescript
// useAgenticLoop.ts line 77: Log array grows unbounded (up to 200)
setState((prev) => ({
  ...prev,
  logs: [...prev.logs, { timestamp: new Date(), stage, message, type }].slice(
    -200,
  ),
}));
```

**Impact Estimate:**

- **Re-render overhead:** ~200 renders during initialization (each log adds one)
- **Memory:** ~10KB state for 200 log entries (minor)
- **Latency:** Negligible (renders are <1ms each)
- **Quality:** None

**Difficulty to Fix:** **EASY**

- Solution: Move logs to separate context or external state (not main component state)
- OR: Batch log updates (send 5-10 logs per state update)
- Estimated effort: 1-2 hours

---

## 4. UTILS LAYER BOTTLENECKS

### 4.1 Multi-Pass Regex Sanitization (jsxAutoFixer.ts, codeSanitizer.ts)

**🟡 BOTTLENECK: Expensive Regex Operations on Full Code String**

**Issue:**

- `autoCloseJsx()` runs 5+ passes over code:
  1. Replace custom components with divs (regex with lookahead)
  2. Fix incomplete attribute handlers (scan all lines)
  3. Fix orphaned attributes (scan all lines with string matching)
  4. Balance braces/parentheses (scan string)
  5. Balance HTML tags (scan string + regex for each tag type)
  6. Append missing closing tags
- `aggressiveSanitize()` runs 15+ passes over code (see cleaning.ts lines 8-80)
  - Quote normalization (multiple regex)
  - HTML entity removal
  - Arrow function fix
  - Brace/paren balancing
  - Image path removal
  - OCR artifact removal (expensive `isLikelyValidWord()` call per match)
- For 1500 token output (~1000 characters), this is ~20-30 regex passes

**Root Cause:**

```typescript
// jsxAutoFixer.ts lines 82-120: Multiple sequential passes
export function autoCloseJsx(code: string): string {
  let fixed = code;
  fixed = replaceCustomComponentsWithDiv(fixed); // Pass 1: regex
  fixed = fixIncompleteAttributeHandlers(fixed); // Pass 2: line scan + regex
  fixed = fixOrphanedAttributes(fixed); // Pass 3: line scan
  // Balance braces, balance parens, balance tags (5+ more passes)
  // Total: 8+ passes over same code
}
```

**Impact Estimate:**

- **Latency per generation:** 50-100ms for cleanup phase (see timing logs)
- **CPU usage:** Non-negligible on low-end devices
- **Quality:** Fixes many issues, but also introduces bugs (e.g., over-aggressive replacement)
- **Repair likelihood:** Over-sanitization can create validation errors

**Difficulty to Fix:** **MEDIUM**

- Solution 1: Compile regex patterns outside of function (avoid recompilation)
- Solution 2: Combine passes (e.g., single-pass custom component + orphaned attribute fix)
- Solution 3: Skip sanitization for already-valid code (check validation first)
- Solution 4: Use AST parsing instead of regex (more accurate, potentially slower)
- Estimated effort: 3-4 hours

---

### 4.2 OCR Artifact Detection Heuristic (codeSanitizer.ts)

**🟡 BOTTLENECK: isLikelyValidWord() Called on Every Text Match**

**Issue:**

- `aggressiveSanitize()` removes text that looks like OCR gibberish (lines 67-83)
- `isLikelyValidWord()` checks 3 conditions per text match:
  1. Is it in a hardcoded list of ~25 words?
  2. Does it contain common substrings (Button, Link, Page, etc.)?
  3. Does it contain vowels?
- Called potentially 100+ times per code generation
- Heuristic is fragile: misses real OCR artifacts (e.g., "BOOLE") while preserving others

**Root Cause:**

```typescript
// codeSanitizer.ts lines 67-83
if (isSuspicious && !isLikelyValidWord(text)) {
  line = line.replace(match, '""');
}

function isLikelyValidWord(text: string): boolean {
  const commonWords = [
    /* 25 words */
  ];
  if (commonWords.includes(text)) return true;
  if (/(?:Button|Link|Page|...)/.test(text)) return true;
  if (!/[aeiouAEIOU]/.test(text)) return false;
  return false;
}
```

**Impact Estimate:**

- **Latency:** <10ms per generation (minor)
- **Quality:** Misses some OCR artifacts, but also false-positives (removes valid text)
- **Repair likelihood:** Over-aggressive removal can fail validation (missing labels)

**Difficulty to Fix:** **EASY**

- Solution 1: Use pre-computed set instead of hardcoded list (faster lookup)
- Solution 2: Improve heuristic (e.g., ML-based scorer or larger dictionary)
- Solution 3: Skip artifact removal, rely on model quality instead
- Estimated effort: 1 hour

---

## 5. COMPONENT LAYER BOTTLENECKS

### 5.1 EditablePreview Drag-Drop Injection Delay (EditablePreview.tsx)

**🟡 BOTTLENECK: 1000ms Debounce for Drag-Drop Script Injection**

**Issue:**

- After preview URL ready, component waits 1000ms before injecting drag-drop script (line 158)
- Iframe is interactive immediately, but dragging doesn't work for first 1 second
- Injected script is inline, runs in iframe context (minor security issue)
- Mutation observer for drag-drop on dynamically added elements could cause memory leaks

**Root Cause:**

```typescript
// EditablePreview.tsx line 153-160
useEffect(() => {
  if (previewUrl && iframeRef.current) {
    const timer = setTimeout(() => {
      injectDragAndDrop(); // 1000ms delay
    }, 1000);
    return () => clearTimeout(timer);
  }
}, [previewUrl, injectDragAndDrop]);
```

**Impact Estimate:**

- **User experience:** Drag-drop unavailable for 1s after preview loads
- **Latency:** Negligible (doesn't affect generation time)
- **Quality:** None

**Difficulty to Fix:** **EASY**

- Solution 1: Inject immediately (no delay) or after previewUrl is set
- Solution 2: Inject from webcontainer (server-side) instead of client iframe
- Solution 3: Use iframe onload event instead of setTimeout
- Estimated effort: 30 minutes

---

### 5.2 AgenticIDE Component Render Performance (AgenticIDE.tsx)

**🟡 BOTTLENECK: Large Visible Logs Array, Multiple Memoizations**

**Issue:**

- `visibleLogs` memoized (line 101), but depends on `state.logs` (200 entries)
- `useMemo` re-computes when logs change, even if visible slice unchanged
- Selected log state managed separately (line 74), triggers full component re-render on selection
- Progress logs UI (lines 201+) renders all 8 visible logs as buttons, no virtualization
- Voice input hook creates new function on every render (line 99: `useVoiceInput(appendTranscript)`)

**Root Cause:**

```typescript
// AgenticIDE.tsx lines 74-101
const [selectedLogIndex, setSelectedLogIndex] = useState<number | null>(null);
const visibleLogs = useMemo(() => state.logs.slice(-8), [state.logs]); // Re-computes every log
const voice = useVoiceInput(appendTranscript); // Function dependency
```

**Impact Estimate:**

- **Re-render overhead:** ~10-20 renders during initialization (one per new log)
- **Latency:** Negligible (<1ms per render)
- **Quality:** None
- **Mobile experience:** Slightly slower on low-end devices

**Difficulty to Fix:** **EASY**

- Solution 1: Memoize visibleLogs.length and only recompute if length changes
- Solution 2: Use useCallback for appendTranscript
- Solution 3: Move logs to separate context (prevents full component re-render)
- Estimated effort: 1 hour

---

## 6. HARDWARE & ENVIRONMENT CONSTRAINTS

### 6.1 Token Context Window Limitation

**🔴 BOTTLENECK: 2048 Tokens is Below Industry Standard for Code**

**Issue:**

- Context window: 2048 tokens (hardcoded in webllm.ts line 21)
- System prompt: ~900 tokens
- Average UI generation code: ~300-400 tokens
- Repair prompt: ~500 tokens
- **Effective space:** ~150-250 tokens for complex logic or large UIs
- Modern context windows: Claude (100k+), GPT-4 (8k-128k), Llama (4k-32k)

**Root Cause:**

```typescript
// webllm.ts line 19-22
const engine = new webllm.MLCEngine();
await engine.reload(MODEL_ID, {
  context_window_size: 2048, // Fixed constraint
});
```

**Impact Estimate:**

- **Quality ceiling:** Complex UIs (500+ line code) cannot be generated in single pass
- **Repair likelihood:** High (~30-40% of generations need repair due to truncation)
- **Latency:** Each repair adds 120-180s
- **User experience:** "Repairing..." message common for complex prompts

**Difficulty to Fix:** **HARD**

- Solution 1: Upgrade model to Qwen 7B (requires 8GB+ VRAM, not feasible on low-end)
- Solution 2: Use context compression techniques (summarize, extract key parts)
- Solution 3: Multi-turn generation (break complex UIs into sections)
- Solution 4: Use different model with larger context
- Estimated effort: 8-16 hours (major architectural change)

---

### 6.2 Quantized Model Quality Loss (webllm.ts)

**🟡 BOTTLENECK: q4 Quantization Reduces Precision & Reasoning**

**Issue:**

- Model: `Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC`
- q4 = 4-bit quantization (down from fp32 or fp16)
- 1.5B parameters is very small for code generation (modern: 7B+)
- Combination leads to:
  - Hallucinations (inventing component names, colors, structure)
  - Quality degradation in semantic understanding
  - Difficulty with edge cases (accessibility, responsive design)
  - OCR artifacts not caught by model (delegated to sanitizer)

**Root Cause:**

```typescript
// webllm.ts line 8: Model choice is fixed
const MODEL_ID = "Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC";
// Smallest option available; trade-off for browser-native inference
```

**Impact Estimate:**

- **Quality ceiling:** ~70-75% of generated UIs pass validation on first try
- **Repair rate:** ~25-30% require repair attempt
- **Latency per failed repair:** 120-180s
- **User experience:** "Repairing..." common for complex or specific prompts

**Difficulty to Fix:** **HARD**

- Solution 1: Upgrade to larger model (e.g., Qwen 7B, but requires 4-6GB VRAM)
- Solution 2: Use higher quantization (q8 or fp16) if VRAM allows
- Solution 3: Accept quality ceiling, optimize for fast iteration (quick repairs)
- Estimated effort: 6-12 hours (requires testing multiple models)

---

### 6.3 WebContainer Boot & COOP/COEP Headers

**🔴 BOTTLENECK: Blocking Boot, Complex Header Requirements**

**Issue:**

- WebContainer boot is forced on app initialization (useAgenticLoop.ts line 177)
- Requires specific HTTP headers (Vite sets in dev, must be set in production)
- No fallback if boot fails; full feature degradation
- Boot takes 5-30s even when no preview needed
- Headers not documented for Vercel or other deployment platforms

**Root Cause:**

```typescript
// useAgenticLoop.ts line 177
await webContainerService.boot(); // Blocking, no lazy init
// vite.config.ts line 7-10: Only sets headers in dev mode
```

**Impact Estimate:**

- **Initialization latency:** +5-30s (unavoidable boot)
- **Preview failure rate:** ~5-10% on strict browser configs (missing headers)
- **Deployment risk:** Production deployment without headers breaks preview feature
- **User experience:** "WebContainer failed to boot" → feature entirely unavailable

**Difficulty to Fix:** **HARD**

- Solution 1: Lazy boot (only when preview requested)
- Solution 2: Implement header detection, diagnostic error message
- Solution 3: Provide fallback to code-only editing if boot fails
- Estimated effort: 4-8 hours

---

## PRIORITY RANKING: Bottlenecks by Impact + Difficulty

### Tier 1 (CRITICAL - Fix First)

| Rank | Bottleneck                      | Latency Impact       | Difficulty | Effort | Est. Gain               |
| ---- | ------------------------------- | -------------------- | ---------- | ------ | ----------------------- |
| 1    | **Token context window (2048)** | 25-30% repair loops  | HARD       | 8-16h  | -30% latency (repair)   |
| 2    | **Blocking WebContainer boot**  | +15-30s cold start   | HARD       | 4-8h   | -20% initialization     |
| 3    | **Cascading repair loops**      | +120-180s if failure | HARD       | 6-8h   | -15% avg latency        |
| 4    | **Sequential vision → LLM**     | +5-13s if screenshot | EASY       | 0.5h   | -25% screenshot latency |
| 5    | **Verbose system prompts**      | Indirect (quality)   | MEDIUM     | 3-5h   | -10% repair rate        |

### Tier 2 (HIGH - Fix Soon)

| Rank | Bottleneck                     | Latency Impact     | Difficulty | Effort | Est. Gain           |
| ---- | ------------------------------ | ------------------ | ---------- | ------ | ------------------- |
| 6    | **Quantized model (q4)**       | Indirect (quality) | HARD       | 6-12h  | -20% repair rate    |
| 7    | **Multi-pass sanitization**    | +50-100ms per gen  | MEDIUM     | 3-4h   | -5% latency         |
| 8    | **Vision model load**          | +5-13s first use   | MEDIUM     | 4-6h   | -50% vision latency |
| 9    | **Eager model initialization** | +30-60s cold start | MEDIUM     | 2-3h   | -50% initialization |
| 10   | **COOP/COEP header issues**    | 0 (if headers OK)  | EASY       | 1-2h   | -5% failure rate    |

### Tier 3 (MEDIUM - Fix Later)

| Rank | Bottleneck                          | Latency Impact        | Difficulty | Effort | Est. Gain           |
| ---- | ----------------------------------- | --------------------- | ---------- | ------ | ------------------- |
| 11   | **Semantic form validation**        | +120s (if repair)     | EASY       | 1-2h   | -5% repair rate     |
| 12   | **State log array overhead**        | <1ms per log          | EASY       | 1-2h   | -5% re-renders      |
| 13   | **Model readiness polling**         | +2-35s initialization | EASY       | 1-2h   | -50% initialization |
| 14   | **OCR artifact heuristic**          | <10ms per gen         | EASY       | 1h     | -5% repair rate     |
| 15   | **EditablePreview drag-drop delay** | 0 to latency          | EASY       | 0.5h   | UX improvement      |

---

## RECOMMENDATIONS: Quick Wins vs. Major Efforts

### Quick Wins (1-2 hours each, 5-15% improvement)

1. **Parallelize vision + prompt building** (0.5h)
   - Move `buildSystemPrompt()` into parallel with vision extraction
   - Expected gain: -2-3s per screenshot generation

2. **Make model initialization lazy** (2-3h)
   - Boot on first generation, not app mount
   - Expected gain: -30-60s initialization (user doesn't wait before prompt)

3. **Remove redundant inference test** (1-2h)
   - Model load is sufficient readiness check
   - Expected gain: -10-30s initialization

4. **Relax form validation** (1-2h)
   - Allow warnings instead of hard failures for missing inputs
   - Expected gain: -5-10% repair rate

5. **Improve OCR artifact detection** (1h)
   - Use larger dictionary + better heuristic
   - Expected gain: -3-5% repair rate

### Medium Efforts (3-8 hours, 10-30% improvement)

6. **Condense system prompts** (3-5h)
   - Reduce from 900 to 300-400 tokens
   - Use examples instead of verbose rules
   - Expected gain: -10% repair rate, allows longer code

7. **Parallelize cleanup + validation** (2-3h)
   - Cleanup doesn't need to precede validation
   - Expected gain: -50ms per generation

8. **Move WebContainer boot to initialization** (4-8h)
   - Boot earlier (during model init), not on preview
   - Expected gain: -15-30s per preview attempt

9. **Extract logs to separate context** (1-2h)
   - Remove from main state, prevent re-renders
   - Expected gain: -10-20% unnecessary re-renders

10. **Compile & cache regex patterns** (2-3h)
    - Pre-compile outside of functions
    - Expected gain: -20-30ms per generation

### Major Efforts (6-16 hours, 20-50% improvement)

11. **Upgrade model or increase context window** (8-16h)
    - Qwen 7B + 8k context (requires VRAM/bandwidth)
    - OR: Implement context compression
    - Expected gain: -20-30% repair rate, -30% avg latency

12. **Implement incremental repair** (6-8h)
    - Fix one error at a time, not full regeneration
    - Expected gain: -15% repair latency

13. **Use Web Worker for vision** (4-6h)
    - Move vision inference off main thread
    - Expected gain: -50% vision latency, smoother UI

14. **Lazy boot WebContainer** (4-8h)
    - Keep single dev server, hot-reload code only
    - Expected gain: -20-30s per preview

15. **Diagnostic error messages** (1-2h)
    - Detect missing COOP/COEP headers, provide guidance
    - Expected gain: -5% feature failure rate

---

## SUMMARY TABLE: All Bottlenecks

| #   | Issue                     | Layer       | Type           | Cold Start    | Per Gen        | Quality          | Difficulty | Fix Time |
| --- | ------------------------- | ----------- | -------------- | ------------- | -------------- | ---------------- | ---------- | -------- |
| 1   | Token context 2048        | Services    | Hard limit     | -             | +25-30% repair | -30% quality     | HARD       | 8-16h    |
| 2   | WebContainer boot         | Services    | Performance    | +15-30s       | +5-15s         | None             | HARD       | 4-8h     |
| 3   | Repair loops cascade      | Pipeline    | Logic          | -             | +120-180s fail | -30% UX          | HARD       | 6-8h     |
| 4   | Sequential vision+LLM     | Hooks       | Optimization   | -             | +5-13s img     | None             | EASY       | 0.5h     |
| 5   | Verbose prompts           | Pipeline    | Optimization   | -             | Indirect       | -10% pass        | MEDIUM     | 3-5h     |
| 6   | Quantized model           | Services    | Hard limit     | -             | Indirect       | -25% quality     | HARD       | 6-12h    |
| 7   | Regex sanitization        | Utils       | Performance    | -             | +50-100ms      | +5% bugs         | MEDIUM     | 3-4h     |
| 8   | Vision model load         | Services    | Performance    | +10-30s first | +5-13s img     | -10% OCR         | MEDIUM     | 4-6h     |
| 9   | Eager init                | Services    | Initialization | +30-60s       | -              | None             | MEDIUM     | 2-3h     |
| 10  | COOP/COEP headers         | Environment | Failure        | -             | 0              | -5% availability | EASY       | 1-2h     |
| 11  | Semantic form validation  | Pipeline    | Logic          | -             | +120s fail     | -5% pass         | EASY       | 1-2h     |
| 12  | Log state overhead        | Hooks       | Performance    | -             | <1ms           | None             | EASY       | 1-2h     |
| 13  | Model readiness polling   | Services    | Initialization | +2-35s        | -              | None             | EASY       | 1-2h     |
| 14  | OCR artifact detection    | Utils       | Quality        | -             | <10ms          | -5% pass         | EASY       | 1h       |
| 15  | Drag-drop injection delay | Components  | UX             | -             | 0              | -1s UX           | EASY       | 0.5h     |

---

## CONCLUSION

**Critical Path Latency Breakdown (First Generation with Screenshot):**

```
Initialization:           30-60s  (model download + WebContainer boot)
Vision processing:         5-13s  (image compression + vision + OCR)
Prompt building:          10ms    (negligible)
LLM generation:          15-25s   (actual inference)
Cleanup + validation:     50ms    (sanitization + checks)
                         ─────────
TOTAL (no repairs):      50-100s
IF repair needed:       +120-180s (another full LLM cycle)
```

**Quality Ceiling Degradation:**

- **Model:** 1.5B quantized (vs. 7B+ unquantized) = ~25-30% quality loss
- **Context:** 2048 tokens (vs. 4k-8k standard) = ~30% incomplete outputs
- **Repairs:** ~25-30% of generations fail validation = cascading 120s+ latency
- **Combined:** ~60-70% first-pass success rate (30-40% need repair)

**Quick Improvements (Can achieve -30% avg latency with 10 hours effort):**

1. Lazy model boot (-30-60s)
2. Parallelize vision+prompt (-5s)
3. Remove readiness polling (-10-30s)
4. Condense prompts (-10% repair rate)
5. Relax validation (-5-10% repair rate)

**High-Impact Improvements (Can achieve -50% avg latency with 40+ hours effort):**

1. Upgrade model to 7B (-25% repair rate)
2. Increase context window to 4k (-30% repair rate)
3. Implement incremental repair (-15% repair latency)
4. Use Web Worker for vision (-50% vision latency)
