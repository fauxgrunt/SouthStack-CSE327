# 🚀 SouthStack - Real Implementation Guide

## ✨ What Changed: From Mock to Production

This document explains the **production-ready implementation** using real WebContainer and WebLLM APIs.

---

## 📦 New Dependencies

Added to `package.json`:

```json
{
  "@xterm/xterm": "^5.3.0",
  "@xterm/addon-fit": "^0.10.0"
}
```

Install with:

```bash
npm install
```

---

## 🔧 Critical: Vite Configuration

### File: `vite.config.ts`

**REQUIREMENT**: WebContainer requires specific CORS headers or it will fail to boot.

```typescript
server: {
  headers: {
    // CRITICAL - Without these, SharedArrayBuffer is unavailable
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Opener-Policy': 'same-origin',
  },
}
```

**What happens without these headers?**

- ❌ Error: `SharedArrayBuffer is not defined`
- ❌ WebContainer.boot() fails immediately
- ❌ No in-browser Node.js execution

**These headers are required because:**

- WebContainer uses SharedArrayBuffer for memory sharing
- Browser security policies require COEP + COOP for SharedArrayBuffer
- Vite must send these headers from the dev server

---

## 🏗️ Architecture Overview

### Real Data Flow

```
User Input
    ↓
WebLLM (Local GPU Inference)
    ↓
Generated Code (JavaScript)
    ↓
WebContainer Virtual FS
    ↓
npm install (in-browser)
    ↓
node index.js (in-browser)
    ↓
Terminal Output (xterm.js)
```

### Key Files

1. **`src/services/webcontainer.ts`** - WebContainer singleton service
2. **`src/components/Terminal.tsx`** - Real terminal using xterm.js
3. **`src/App.tsx`** - Main agentic loop orchestration

---

## 📁 File 1: WebContainer Service

### `src/services/webcontainer.ts`

**Purpose**: Singleton wrapper around WebContainer API

**Key Methods:**

```typescript
// Boot the container (call once)
await webContainerService.boot();

// Check if ready
webContainerService.isReady(); // boolean

// Write files
await webContainerService.writeFile("/index.js", code);

// Spawn process
const process = await webContainerService.spawn("npm", ["install"]);

// Execute and wait
const { exitCode, output } = await webContainerService.exec("node", [
  "index.js",
]);
```

**Why Singleton?**

- WebContainer.boot() is expensive (~1-2 seconds)
- Should only be called once per application lifecycle
- Multiple boot attempts cause errors

**Error Handling:**

```typescript
if (typeof SharedArrayBuffer === "undefined") {
  throw new Error("COOP/COEP headers not set correctly");
}
```

This catches the **most common misconfiguration** issue.

---

## 🖥️ File 2: Terminal Component

### `src/components/Terminal.tsx`

**Purpose**: Real terminal emulator using xterm.js

**Features:**

✅ **Real Terminal Rendering**

- Full ANSI color support
- Cursor positioning
- Scrollback buffer (10,000 lines)

✅ **Auto-Sizing**

- FitAddon automatically resizes to container
- Responds to window resize events

✅ **Stream Piping**

- Accepts `ReadableStream<string>` from WebContainer
- Pipes process output directly to terminal UI

✅ **Theming**

- Custom dark theme optimized for code
- Matches SouthStack brand colors

**Props:**

```typescript
interface TerminalProps {
  processStream?: ReadableStream<string> | null;
  clearTrigger?: number;
  height?: string;
}
```

**Usage:**

```tsx
const [stream, setStream] = useState<ReadableStream<string> | null>(null);

// Start a process
const process = await webContainerService.spawn("node", ["index.js"]);
setStream(process.output); // Terminal auto-updates!

// Component
<Terminal processStream={stream} height="400px" />;
```

**Key xterm Features Used:**

- `xterm.writeln()` - Write line with newline
- `xterm.write()` - Write without newline
- `xterm.clear()` - Clear terminal
- ANSI escape codes for colors: `\x1b[1;32m` (green)

---

## 🎯 File 3: Main App (Agentic Loop)

### `src/App.tsx`

**Purpose**: Orchestrate the complete offline agentic workflow

### Initialization Flow

```typescript
1. Check WebGPU availability
   ↓
2. Initialize WebLLM Engine
   - Load Llama-3.2-1B-Instruct model
   - Show progress updates
   - Cache in IndexedDB (one-time)
   ↓
3. Boot WebContainer
   - Initialize virtual file system
   - Prepare Node.js runtime
   ↓
4. Ready for agentic loop! 🚀
```

### Agentic Loop Flow

```typescript
async function executeAgenticLoop() {
  // 1. Generate Code (WebLLM)
  const completion = await engine.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const code = extractCode(completion.choices[0].message.content);

  // 2. Write Files (WebContainer)
  await webContainerService.writeFile("/package.json", packageJson);
  await webContainerService.writeFile("/index.js", code);

  // 3. Install Dependencies (Real npm!)
  const installProcess = await webContainerService.spawn("npm", ["install"]);
  setProcessStream(installProcess.output); // Show in terminal
  await installProcess.exit; // Wait for completion

  // 4. Execute Code (Real Node.js!)
  const nodeProcess = await webContainerService.spawn("node", ["index.js"]);
  setProcessStream(nodeProcess.output); // Show in terminal

  // Process runs indefinitely (if it's a server)
}
```

### Key Differences from Mock

| Feature         | Mock Version            | Real Version                |
| --------------- | ----------------------- | --------------------------- |
| File System     | `Map<string, string>`   | WebContainer Virtual FS     |
| Execution       | Simulated with timeouts | Real Node.js in browser     |
| npm install     | Faked success           | Actual package installation |
| Terminal        | Text logs               | Real xterm.js terminal      |
| Process Streams | N/A                     | Piped to UI in real-time    |

---

## 🔄 Process Stream Handling

### How WebContainer Streams Work

WebContainer processes return a `ReadableStream<string>`:

```typescript
const process = await webContainer.spawn("node", ["index.js"]);
// process.output is ReadableStream<string>
```

**Reading the Stream:**

```typescript
const reader = process.output.getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  // value is a string chunk
  terminal.write(value);
}
```

**Our Terminal Component handles this automatically:**

```tsx
<Terminal processStream={process.output} />
```

The component:

1. Gets a reader from the stream
2. Reads chunks in a loop
3. Writes each chunk to xterm
4. Handles errors and cleanup

---

## ⚡ Performance Characteristics

### Initialization Times

| Operation                  | Time     | Notes                    |
| -------------------------- | -------- | ------------------------ |
| WebLLM Model Load (first)  | 120-180s | ~1GB download            |
| WebLLM Model Load (cached) | 5-10s    | From IndexedDB           |
| WebContainer Boot          | 1-2s     | One-time per session     |
| npm install (small)        | 5-15s    | In-browser package fetch |
| Code execution start       | <100ms   | Near-instant             |

### Memory Usage

- WebLLM: ~1.5GB RAM + ~1.5GB VRAM
- WebContainer: ~100-300MB RAM
- xterm.js: ~10-50MB RAM
- **Total**: ~2-3GB RAM recommended

---

## 🐛 Common Issues & Solutions

### Issue 1: "SharedArrayBuffer is not defined"

**Cause**: COOP/COEP headers not configured

**Solution**: Check `vite.config.ts` headers are correct

```typescript
headers: {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
}
```

**Verify headers in browser DevTools:**

- Network tab → Select localhost request
- Response Headers → Check for COEP and COOP

### Issue 2: Terminal shows nothing

**Cause**: Process stream not connected or CSS not loaded

**Solution**:

1. Check `@import '@xterm/xterm/css/xterm.css';` in styles.css
2. Verify processStream is passed to Terminal component
3. Check terminal ref is mounted before writing

### Issue 3: Local P2P handshake fails

**Cause**: Devices are not using the same LAN hotspot or local signaling host.

**Solution**:

- Connect both devices to the same local hotspot
- Run local signaling on laptop: `npx peerjs --port 9000 --path /peerjs`
- Set `VITE_PEER_SIGNAL_HOST` to the laptop LAN IP
- Ensure local firewall allows signaling port access

### Issue 4: Code doesn't execute

**Cause**: Several possibilities

**Debug steps:**

1. Check generated code syntax (view in preview)
2. Look for npm install errors in terminal
3. Check package.json dependencies are valid
4. Verify node process actually started (logs)

### Issue 5: Out of Memory

**Cause**: GPU VRAM exhausted

**Solution**:

- Close other browser tabs
- Restart browser
- Use smaller model (edit MODEL_ID in App.tsx)

---

## 🚀 Running the Real Implementation

### Step-by-Step

```bash
# 1. Install dependencies
npm install

# 2. Start dev server (with CORS headers!)
npm run dev

# 3. Open browser
# Navigate to http://localhost:3000

# 4. Click "Initialize System"
# Wait for:
#   - WebLLM model download (~1-2 minutes first time)
#   - WebContainer boot (~1-2 seconds)

# 5. Enter a prompt
Example: "Write an Express.js server with a /health endpoint"

# 6. Click "Execute Agentic Loop"
# Watch:
#   - AI generates code (2-5 seconds)
#   - Files written to virtual FS
#   - npm install runs in terminal
#   - node index.js executes
#   - Server output appears in terminal!

# 7. Test the server
# If it's an Express server, open http://localhost:3000
# (WebContainer maps ports automatically)
```

### Example Prompts

```
✅ "Create an Express server with /health and /api/users endpoints"
✅ "Write a simple HTTP server that serves JSON"
✅ "Build a REST API with CRUD operations for a todo list"
✅ "Create a WebSocket server for real-time chat"
```

---

## 🎯 What's Real Now

### ✅ Real Components

- [x] **WebLLM Integration**: Actual Llama-3.2-1B inference
- [x] **WebContainer**: Real Node.js runtime in browser
- [x] **npm install**: Actual package manager
- [x] **Terminal**: Real xterm.js with ANSI support
- [x] **Process Streams**: Live output piping
- [x] **File System**: Virtual FS with real read/write

### ❌ Not Yet Implemented

- [ ] Self-healing retry loop (can add back from mock version)
- [ ] RAG context injection (vector store integration)
- [ ] Multi-file project structure
- [ ] Error classification and recovery
- [ ] Test generation and validation

---

## 📚 API Reference Quick Guide

### WebContainer API

```typescript
// Boot
const container = await WebContainer.boot();

// File operations
await container.fs.writeFile("/file.js", content);
const content = await container.fs.readFile("/file.js", "utf-8");
await container.fs.mkdir("/dir", { recursive: true });

// Process spawning
const process = await container.spawn("node", ["index.js"]);
const exitCode = await process.exit;

// Stream handling
process.output.pipeTo(myWritableStream);
```

### WebLLM API

```typescript
// Initialize
const engine = new webllm.MLCEngine();
await engine.reload(MODEL_ID);

// Generate
const completion = await engine.chat.completions.create({
  messages: [{ role: "user", content: "prompt" }],
  temperature: 0.7,
  max_tokens: 1024,
});
```

### XTerm API

```typescript
// Create terminal
const term = new Terminal({ theme, fontSize, ... });
term.open(domElement);

// Write
term.write('text');
term.writeln('text with newline');

// Colors (ANSI)
term.writeln('\x1b[1;32mGreen text\x1b[0m');
```

---

## 🎓 Next Steps

### Immediate Enhancements

1. **Add Self-Healing**
   - Capture error output from process
   - Feed back to WebLLM
   - Regenerate and retry

2. **Multi-File Support**
   - Parse project structure from AI
   - Write multiple files
   - Handle imports/exports

3. **Port Mapping UI**
   - Show running servers
   - Link to WebContainer URLs
   - Display port status

### Advanced Features

4. **Terminal Input**
   - Enable user input to running process
   - Interactive CLI tools
   - REPL support

5. **File Explorer**
   - Visual file tree
   - Browse virtual FS
   - Edit files directly

6. **Process Management**
   - List running processes
   - Kill processes
   - View resource usage

---

## ✅ Verification Checklist

Before running, verify:

- [ ] `npm install` completed successfully
- [ ] `@xterm/xterm` and `@xterm/addon-fit` installed
- [ ] Vite config has COEP/COOP headers
- [ ] Chrome/Edge 113+ browser
- [ ] WebGPU enabled (check `navigator.gpu`)
- [ ] At least 4GB VRAM available
- [ ] Dev server running on port 3000

---

## 📶 P2P Edge Computing Instructions

For LAN-only swarm execution:

1. Run local PeerJS signaling on the laptop:

```bash
npx peerjs --port 9000 --path /peerjs
```

2. Set app env vars:

```bash
VITE_PEER_SIGNAL_HOST=YOUR_LAPTOP_LAN_IP
VITE_PEER_SIGNAL_PORT=9000
VITE_PEER_SIGNAL_PATH=/peerjs
VITE_PEER_SIGNAL_SECURE=false
```

3. Join the same hotspot on both devices.

4. Start master on phone, worker on laptop, and exchange peer IDs.

---

## 🎉 Success Criteria

You'll know it's working when:

✅ "Initialize System" button loads model
✅ Terminal shows welcome message
✅ Prompt generates code (visible in preview)
✅ Terminal shows "npm install" output
✅ Terminal shows "Server running on..." message
✅ No errors in browser console

**Congratulations! You now have a real offline-first AI IDE!** 🚀

---

## 📞 Troubleshooting Help

If stuck:

1. Check browser console for errors
2. Verify COEP/COOP headers in Network tab
3. Try refreshing page (clears GPU memory)
4. Clear browser cache if model won't load
5. Check this guide's Common Issues section

---

**Built with real WebContainer + WebLLM • No mocks • Production-ready** ✨
