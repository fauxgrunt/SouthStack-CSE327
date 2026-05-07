# Preview Rendering Debugging Guide

## What Should Happen

1. **Code Generation**: LLM generates React component code
2. **Validation**: Code is validated for basic JSX structure
3. **Repair**: If invalid, `autoCloseJsx()` attempts to fix it
4. **WebContainer Execution**: Code is written to `/src/App.jsx`
5. **Dev Server Start**: Vite dev server starts on port 4173
6. **URL Callback**: Preview URL is set in state → iframe loads URL

## How to Debug

### Step 1: Open Browser Console

- Open the app in your browser
- Press **F12** to open DevTools → **Console** tab
- Keep this open while testing

### Step 2: Generate Code

- Enter a prompt like: `"Create a beautiful login form with Tailwind CSS"`
- Watch the console logs in real-time

### Step 3: Look for These Key Logs

#### ✅ Code Generation Success

```
AUDIT [4] FINAL PREVIEW PAYLOAD:
export default function App() { ... }
```

**What it means**: Code was generated and made it to WebContainer execution.

#### ✅ Metrics Table

```
Total Generation Time (s):  2.34
VRAM Typos Auto-Fixed:      0
Code Size (Characters):     1245
Status:                     Success
```

**What it means**: Generation completed successfully.

#### ⚠️ JSX Validation Failures

If you see:

```
[JSXValidator] Generated code failed structural validation.
{
  codeLength: 1234,
  hasExportDefault: true,
  hasJsxTag: true,
  lastLine: "...",
  preview: "export default function App() { ..."
}
```

**What it means**: Code failed validation but may have been repaired. Check if subsequent logs show:

- `"Generated code passed validation after JSX auto-repair."` → ✅ Repaired and used
- `"[JSXValidator] Auto-repair also failed."` → ❌ Fell back to DEFAULT_SAFE_FALLBACK

#### ✅ React Execution Path

```
[ExecuteReact] Processing as React app
[ExecuteReact] Normalized app code length: 1245
[ExecuteReact] Safe code length after sanitization: 1245
[ExecuteReact] Writing code to /src/App.jsx...
[ExecuteReact] File written successfully
[ExecuteReact] Calling ensureDevServerRunning...
```

**What it means**: Code is being prepared for WebContainer.

#### ✅ Dev Server Startup

```
[DevServer] Starting fresh dev server instance...
[DevServer] Waiting for server-ready promise...
[DevServer] server-ready event fired: { port: 4173, url: "http://..." }
[DevServer] Server ready promise resolved with URL: http://...
[DevServer] Invoking onPreviewUrlChange callback with URL: http://...
[DevServer] Callback invoked
```

**What it means**: Vite dev server started and preview URL was set.

#### ✅ Preview State Update

```
[PreviewCallback] Setting previewUrl to: http://localhost:4173
[PreviewCallback] New state: { previewUrl: "http://localhost:4173", ... }
```

**What it means**: React state was updated with the preview URL.

## Common Issues & Solutions

### Issue: "constantly showing the default template"

#### Possible Cause 1: Code Failing Validation

Look for:

```
[JSXValidator] Generated code failed structural validation.
[JSXValidator] Auto-repair also failed. Using DEFAULT_SAFE_FALLBACK.
```

**Solution**: The generated code is missing `export default` or proper JSX tags. Check:

- Is the LLM returning valid React code?
- Is `healVramTypos()` working correctly?
- Does the `autoCloseJsx()` function need improvement?

#### Possible Cause 2: Dev Server Not Starting

Look for:

```
[DevServer] Error: Timed out waiting for dev server to become ready
OR
[ExecuteReact] Dev server failed:
```

**Solution**:

- WebContainer may not be initializing
- npm install may be failing
- Check browser console for network/COOP/COEP errors

#### Possible Cause 3: Preview URL Not Being Called

Look for missing:

```
[PreviewCallback] Setting previewUrl to:
```

**Solution**:

- Dev server started but callback never fired
- Check if `ensureDevServerRunning()` completed successfully
- May be a timing/promise issue

#### Possible Cause 4: iframe Not Rendering

URL is set but iframe shows blank/error.
**Solution**:

- Check Network tab in DevTools
- Does the iframe `src` attribute match what was logged?
- Is the iframe sandbox attribute blocking resources?
- Check Application tab → Cookies/Storage for CORS issues

## Expected Console Output (Successful Flow)

```
AUDIT [4] FINAL PREVIEW PAYLOAD:
export default function App() { ... }

Object {
  Total Generation Time (s): "2.34"
  VRAM Typos Auto-Fixed: 0
  Code Size (Characters): 1456
  Status: "Success"
}

[ExecuteReact] Processing as React app
[ExecuteReact] Normalized app code length: 1456
[ExecuteReact] Safe code length after sanitization: 1456
[ExecuteReact] Writing code to /src/App.jsx...
[ExecuteReact] File written successfully
[ExecuteReact] Calling ensureDevServerRunning...

[DevServer] Starting fresh dev server instance...
[DevServer] Waiting for server-ready promise...
[DevServer] server-ready event fired: {port: 4173, url: "http://localhost:4173"}
[DevServer] Server ready promise resolved with URL: http://localhost:4173
[DevServer] Invoking onPreviewUrlChange callback with URL: http://localhost:4173
[DevServer] Callback invoked

[PreviewCallback] Setting previewUrl to: http://localhost:4173
[PreviewCallback] New state: {previewUrl: "http://localhost:4173", ...}

[ExecuteReact] Dev server running, execution complete
```

## How to Report Issues

When reporting a preview issue, include:

1. **Full console output** from code generation to iframe load
2. **Network tab** → filter by `4173` to see if iframe is requesting the dev server
3. **iframe Source** (right-click iframe → Inspect → check `src` attribute)
4. **Specific prompt** you used that triggered the issue
5. **Browser version** and OS

## Manual Testing Commands

If you want to test the WebContainer setup manually:

```javascript
// In browser console:
// Check if dev server is running
fetch("http://localhost:4173").then((r) =>
  console.log("Server responding:", r.status),
);

// Check current preview URL in React state
// (Requires access to app state - use React DevTools)
```
