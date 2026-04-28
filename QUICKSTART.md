# ⚡ Quick Start Guide

Get SouthStack running in 5 minutes!

## Prerequisites Check

✅ **Browser**: Chrome or Edge 113+ (required for WebGPU)  
✅ **GPU**: Integrated or dedicated GPU with 2GB+ VRAM recommended  
✅ **RAM**: 8GB+ recommended  
✅ **Storage**: 2GB free space for model caching  
✅ **Node.js**: v18+ (for development)

### Check WebGPU Support

Open your browser console and run:

```javascript
navigator.gpu ? "✅ WebGPU Supported" : "❌ WebGPU Not Available";
```

If not supported, update to Chrome/Edge 113+ or enable the flag:

```
chrome://flags/#enable-unsafe-webgpu
```

---

## Installation

```bash
# Clone or download the project
cd SouthStack-Demo

# Install dependencies
npm install

# Start development server
npm run dev
```

Server will start at `http://localhost:3000`

---

## Local Hotspot Setup (LAN-Only)

Use this mode for 100% local P2P signaling and worker execution.

1. Start a local PeerJS signaling server on the laptop (same LAN/hotspot):

```bash
npx peerjs --port 9000 --path /peerjs
```

2. Configure the app environment:

```bash
VITE_PEER_SIGNAL_HOST=YOUR_LAPTOP_LAN_IP
VITE_PEER_SIGNAL_PORT=9000
VITE_PEER_SIGNAL_PATH=/peerjs
VITE_PEER_SIGNAL_SECURE=false
```

3. Connect phone and laptop to the same hotspot.

4. Open the app on both devices and connect nodes using peer IDs.

---

## First Run Workflow

### Step 1: Open the Application

Navigate to `http://localhost:3000` in your browser.

### Step 2: Initialize WebLLM

Click the blue **"🚀 Initialize AI Engine"** button.

**What happens:**

- Downloads Qwen-2.5-Coder model (~1GB)
- Caches in IndexedDB (one-time process)
- Takes 2-5 minutes depending on your connection

**Progress indicators:**

```
⏳ Loading model...
📦 Downloading: 45%
💾 Caching model weights...
✅ Model loaded into browser memory!
```

### Step 3: Test the Agentic Loop

Once initialized, enter a prompt like:

```
Create an Express.js server with a /health endpoint that returns JSON
```

Click **"⚡ Execute Agentic Loop"**

### Step 4: Watch the Magic

The system will:

1. 🤖 **Generate** code using local AI
2. ⚙️ **Execute** code in virtual Node.js environment
3. 🔧 **Self-heal** if errors occur (up to 3 attempts)
4. ✅ **Complete** with working code

---

## Example Prompts

### ✅ Well-Structured Prompts

```
Create a REST API with GET /users and POST /users endpoints
```

```
Write a function that reads a CSV file and converts it to JSON
```

```
Build a simple HTTP server that serves static files from a public directory
```

### ❌ Avoid These

```
Make a website  [Too vague]
```

```
Create a full e-commerce platform  [Too complex for current capabilities]
```

```
Use TensorFlow and PyTorch  [Not available in WebContainers]
```

---

## Troubleshooting

### Issue: "WebGPU not supported"

**Solution:**

- Update to Chrome 113+ or Edge 113+
- Enable WebGPU flag if needed
- Check GPU drivers are up to date

### Issue: "Out of memory" during model load

**Solution:**

1. Close unnecessary browser tabs
2. Close other GPU-intensive applications
3. Restart browser to clear GPU memory
4. Try a smaller model (edit `MODEL_ID` in `useAgenticLoop.ts`)

### Issue: Local P2P connection fails

**Solution:**

- Verify both devices are on the same local hotspot
- Confirm signaling server is running on the laptop (`npx peerjs --port 9000 --path /peerjs`)
- Confirm `VITE_PEER_SIGNAL_HOST` points to the laptop's LAN IP
- Check local firewall rules for the signaling port

### Issue: Code execution fails repeatedly

**Solution:**

- Check the logs for specific error messages
- Try a simpler prompt first
- Verify the generated code in the preview
- Current WebContainer is mocked - some Node.js features limited

### Issue: Slow inference (<10 tokens/sec)

**Solution:**

- Check GPU utilization (should be high)
- Close other tabs/apps using GPU
- Integrated GPUs may be slower than dedicated
- Consider smaller model for faster inference

---

## Understanding the UI

### Status Indicators

| Indicator          | Meaning                              |
| ------------------ | ------------------------------------ |
| 🟢 Ready (Offline) | AI engine loaded, system operational |
| 🔵 Generating      | AI is creating code                  |
| 🟡 Executing       | Code is running in WebContainer      |
| 🟠 Fixing          | Self-healing attempt in progress     |
| 🟢 Completed       | Task successful                      |
| 🔴 Error           | Fatal error occurred                 |

### Execution Logs

Real-time logs show:

- Model download progress
- Code generation status
- Execution results
- Error messages and stack traces
- Self-healing attempts

### Retry Counter

`🔄 Self-healing attempt: 2/3`

Shows current retry number. System makes up to 3 attempts to fix errors.

---

## Going Offline

Once the model is loaded (status shows "✅ Model loaded"):

1. **Disconnect from internet** or enable airplane mode
2. System will continue to work fully offline
3. All AI inference happens locally on your GPU
4. Code execution happens in browser's WebContainer

**To verify offline mode:**

- Disable network in DevTools
- Disconnect WiFi
- Try generating code - it should still work!

---

## Development Tips

### Monitoring Performance

Open DevTools and check:

**GPU Usage:**

```
Task Manager → GPU → Chrome process
```

**Memory:**

```
DevTools → Memory → Take heap snapshot
```

**WebGPU Logs:**

```javascript
// In browser console
performance.getEntriesByType("measure");
```

### Modifying the Model

Edit [src/hooks/useAgenticLoop.ts](src/hooks/useAgenticLoop.ts):

```typescript
const MODEL_ID = "Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC";
// Change to:
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC"; // Faster, less accurate
```

Available models: https://github.com/mlc-ai/web-llm#available-models

### Adjusting Retry Attempts

```typescript
const MAX_RETRY_ATTEMPTS = 3;
// Change to 1 for faster failures, 5 for more persistence
```

### Custom System Prompts

Modify `buildSystemPrompt()` function to customize AI behavior:

```typescript
function buildSystemPrompt(ragContext?: string[]): string {
  return `You are a senior software engineer specializing in Node.js.
  Focus on: error handling, TypeScript types, modern ES6+ syntax.
  ${ragContext ? "Context:\n" + ragContext.join("\n") : ""}`;
}
```

---

## Next Steps

- 📖 Read [README.md](README.md) for architecture overview
- 🏗️ Study [ARCHITECTURE.md](ARCHITECTURE.md) for technical deep dive
- 🔧 Customize the agentic loop for your use case
- 🚀 Integrate real WebContainers API
- 🎯 Add vector store for RAG capabilities

---

## Common Questions

**Q: How big is the model download?**  
A: ~1GB for Qwen-2.5-Coder-1.5B. Downloads once and caches in IndexedDB.

**Q: Can I use this without internet?**  
A: Yes! After initial model download, works 100% offline.

**Q: Why is it slow on first run?**  
A: Model loading from IndexedDB takes 5-10 seconds. Subsequent runs are instant.

**Q: Can I use my own models?**  
A: Yes! WebLLM supports many models. Check their GitHub for the list.

**Q: Is my code sent to any server?**  
A: No. Everything runs locally in your browser. Zero network requests after model load.

**Q: Can I use this in production?**  
A: This is a proof-of-concept. Production use requires: proper WebContainers integration, error handling, security hardening, and testing.

---

**Ready to build?** Run `npm run dev` and start creating! 🚀
