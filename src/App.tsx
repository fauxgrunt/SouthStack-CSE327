import React, { useState, useEffect, useRef } from "react";
import * as webllm from "@mlc-ai/web-llm";
import { webContainerService } from "./services/webcontainer";
import { Terminal } from "./components/Terminal";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { logger } from "./utils/logger";

/**
 * SouthStack - Real Agentic Loop Implementation
 *
 * This is the production implementation that:
 * 1. Loads WebLLM (Llama-3.2-1B) for code generation
 * 2. Boots WebContainer for in-browser Node.js execution
 * 3. Implements autonomous loop: Generate → Execute → Debug
 */

interface LogEntry {
  timestamp: Date;
  message: string;
  type: "info" | "success" | "error" | "warning";
}

type Phase =
  | "idle"
  | "initializing"
  | "ready"
  | "generating"
  | "installing"
  | "executing"
  | "error";

const App: React.FC = () => {
  // State
  const [phase, setPhase] = useState<Phase>("idle");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [userPrompt, setUserPrompt] = useState("");
  const [generatedCode, setGeneratedCode] = useState("");
  const [processStream, setProcessStream] =
    useState<ReadableStream<string> | null>(null);
  const [initProgress, setInitProgress] = useState("");
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [codeCopied, setCodeCopied] = useState(false);

  // Refs
  const engineRef = useRef<webllm.MLCEngine | null>(null);
  const isInitializedRef = useRef(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Monitor online/offline status
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      addLog("[CONNECTION] Internet connection restored", "success");
    };

    const handleOffline = () => {
      setIsOnline(false);
      addLog(
        "[CONNECTION] Internet connection lost - switching to offline mode",
        "warning",
      );
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Add log entry
  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [...prev, { timestamp: new Date(), message, type }]);
  };

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Reset copy state when code changes
  useEffect(() => {
    if (generatedCode) {
      setCodeCopied(false);
    }
  }, [generatedCode]);

  // Helper: Detect language from code
  const detectLanguage = (code: string): string => {
    if (
      code.includes("import") ||
      code.includes("export") ||
      code.includes("const") ||
      code.includes("let")
    ) {
      return code.includes("tsx") || code.includes("jsx")
        ? "tsx"
        : "javascript";
    }
    return "javascript";
  };

  // Handle copy code
  const handleCopyCode = async () => {
    if (generatedCode) {
      await navigator.clipboard.writeText(generatedCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  /**
   * Initialize both WebLLM and WebContainer
   */
  const initialize = async () => {
    if (isInitializedRef.current) return;

    setPhase("initializing");
    addLog("Starting initialization...", "info");

    try {
      // Step 1: Check WebGPU
      const navigatorWithGPU = navigator as typeof navigator & {
        gpu?: { requestAdapter: () => Promise<unknown> };
      };
      if (!navigatorWithGPU.gpu) {
        throw new Error("WebGPU not supported. Please use Chrome/Edge 113+");
      }
      addLog("[OK] WebGPU available", "success");

      // Step 2: Initialize WebLLM
      addLog("Initializing WebLLM...", "info");
      const engine = new webllm.MLCEngine();
      engineRef.current = engine;

      engine.setInitProgressCallback((report: webllm.InitProgressReport) => {
        setInitProgress(report.text);
        addLog(report.text, "info");
      });

      addLog("Loading Llama-3.2-1B model...", "info");
      await engine.reload("Llama-3.2-1B-Instruct-q4f16_1-MLC", {
        context_window_size: 2048,
      });
      addLog("[OK] WebLLM ready!", "success");

      // Step 3: Boot WebContainer
      addLog("Booting WebContainer...", "info");
      await webContainerService.boot();
      addLog("[OK] WebContainer ready!", "success");

      // Success
      setPhase("ready");
      addLog("System fully initialized - 100% offline!", "success");
      isInitializedRef.current = true;
    } catch (error: any) {
      setPhase("error");
      addLog(`[ERROR] Initialization failed: ${error.message}`, "error");
      logger.error("Initialization failed", error, { component: "App" });
    }
  };

  /**
   * Execute the Agentic Loop
   */
  const executeAgenticLoop = async () => {
    if (!engineRef.current || !webContainerService.isReady()) {
      addLog("System not initialized", "error");
      return;
    }

    if (!userPrompt.trim()) {
      addLog("Please enter a prompt", "warning");
      return;
    }

    try {
      // Phase 1: Generate Code
      setPhase("generating");
      addLog(`Generating code for: "${userPrompt}"`, "info");

      const systemPrompt = `You are an expert Node.js developer in a RESTRICTED 100% OFFLINE ENVIRONMENT.

CRITICAL CONSTRAINTS:
- You have NO access to the internet or npm registry
- You MUST ONLY use Node.js built-in core modules
- Available modules: http, https, fs, path, crypto, events, util, url, querystring, stream, buffer, os, process
- DO NOT use express, dotenv, axios, lodash, or ANY external libraries
- If you need a web server, use the 'http' or 'https' module directly
- If you need file operations, use the 'fs' module
- If you need routing, implement it manually with url parsing

CODE REQUIREMENTS:
- Write complete, executable code with no TODOs or placeholders
- Use CommonJS syntax with require() for imports (NOT ES6 import/export)
- Handle errors gracefully with try-catch
- Include proper error messages
- Test all edge cases

EXAMPLE (Good):
const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});
server.listen(3000, () => console.log('Server running on port 3000'));

EXAMPLE (Bad - DO NOT DO THIS):
const express = require('express');  // WRONG - express not available offline!`;

      const completion = await engineRef.current.chat.completions.create({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 1024,
      });

      const code = extractCode(completion.choices[0].message.content || "");

      if (!code) {
        throw new Error("Failed to extract code from AI response");
      }

      setGeneratedCode(code);
      addLog(`[OK] Generated ${code.length} characters of code`, "success");

      // Phase 2: Write Files to WebContainer
      addLog("Writing files to virtual filesystem...", "info");

      // Detect offline mode
      const isOffline = !navigator.onLine;

      if (isOffline) {
        addLog("[OFFLINE MODE] Internet connection not detected", "warning");
        addLog(
          "[OFFLINE MODE] Skipping npm install - using Node.js standard library only",
          "warning",
        );
      }

      // Write package.json (no dependencies in offline mode)
      // Note: "type": "module" is NOT included to allow CommonJS (require) syntax
      // Most AI models generate require() by default, so this ensures compatibility
      const packageJson = {
        name: "southstack-project",
        version: "1.0.0",
        dependencies: isOffline
          ? {}
          : {
              express: "^4.18.2",
            },
      };

      await webContainerService.writeFile(
        "/package.json",
        JSON.stringify(packageJson, null, 2),
      );

      // Write the generated code
      await webContainerService.writeFile("/index.js", code);
      addLog("[OK] Files written to virtual filesystem", "success");

      // Phase 3: Install Dependencies (Skip if offline)
      if (!isOffline) {
        setPhase("installing");
        addLog("Running npm install...", "info");

        const installProcess = await webContainerService.spawn("npm", [
          "install",
        ]);

        // Pipe install output to terminal
        setProcessStream(installProcess.output);

        // Wait for install to complete
        const installExitCode = await installProcess.exit;

        if (installExitCode !== 0) {
          addLog(
            "[WARNING] npm install failed, attempting to run anyway...",
            "warning",
          );
        } else {
          addLog("[OK] Dependencies installed", "success");
        }
      } else {
        addLog("[OFFLINE MODE] Skipping npm install step", "info");
      }

      // Phase 4: Execute Code
      setPhase("executing");
      addLog("Executing code with node index.js...", "info");

      // Create a combined stream that includes system messages
      const systemMessageStream = new ReadableStream({
        start(controller) {
          if (isOffline) {
            controller.enqueue(
              "\x1b[1;33m[SYSTEM] Offline Mode Detected. Skipping npm installs. Using Node.js Standard Library only.\x1b[0m\r\n",
            );
            controller.enqueue(
              "\x1b[1;36m[SYSTEM] Available modules: http, https, fs, path, crypto, events, util, url, querystring, stream, buffer, os, process\x1b[0m\r\n\r\n",
            );
          }
          controller.enqueue(
            "\x1b[1;32m[SYSTEM] Starting Node.js process...\x1b[0m\r\n\r\n",
          );
          controller.close();
        },
      });

      // Display system messages first
      setProcessStream(systemMessageStream);

      // Small delay to ensure system messages are displayed
      await new Promise((resolve) => setTimeout(resolve, 100));

      try {
        const nodeProcess = await webContainerService.spawn("node", [
          "index.js",
        ]);

        // Pipe execution output to terminal
        setProcessStream(nodeProcess.output);

        addLog("[OK] Process started! Check terminal for output.", "success");

        // Monitor process exit for error detection (non-blocking)
        nodeProcess.exit
          .then((exitCode) => {
            if (exitCode !== 0) {
              addLog(
                `[WARNING] Process exited with code ${exitCode}. Check terminal for errors.`,
                "warning",
              );
              // If there's a module error, log it for potential self-healing
              addLog(
                '[INFO] If you see "Cannot find module" errors, try rephrasing your prompt to use only Node.js built-in modules.',
                "info",
              );
            } else {
              addLog("[OK] Process completed successfully.", "success");
            }
            setPhase("ready");
          })
          .catch((error) => {
            addLog(`[ERROR] Process error: ${error.message}`, "error");
            setPhase("ready");
          });

        setPhase("ready");
      } catch (spawnError: any) {
        // Handle spawn errors gracefully
        addLog(
          `[ERROR] Failed to start process: ${spawnError.message}`,
          "error",
        );

        // Create error stream for terminal
        const errorStream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              `\r\n\x1b[1;31m[ERROR] Failed to spawn Node.js process:\x1b[0m\r\n`,
            );
            controller.enqueue(`\x1b[31m${spawnError.message}\x1b[0m\r\n\r\n`);
            controller.enqueue(
              `\x1b[33m[HINT] The generated code may have syntax errors or use unavailable modules.\x1b[0m\r\n`,
            );
            controller.close();
          },
        });

        setProcessStream(errorStream);
        setPhase("ready");
      }
    } catch (error: any) {
      setPhase("error");
      addLog(`[ERROR] Error: ${error.message}`, "error");
      logger.error("Agentic loop error", error, { component: "App" });

      // Reset to ready after error
      setTimeout(() => setPhase("ready"), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-slate-900 to-gray-900 text-white p-8">
      <style>{`
        @keyframes heartbeat {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.1); opacity: 0.8; }
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        .heartbeat-pulse {
          animation: heartbeat 2s ease-in-out infinite;
        }
        
        .spinner {
          animation: spin 1s linear infinite;
        }
        
        .copy-btn-glow {
          box-shadow: 0 0 15px rgba(59, 130, 246, 0.6);
        }
        
        /* Custom scrollbar styling for code container - thin and subtle */
        .code-container {
          scrollbar-gutter: stable;
        }
        
        .code-container::-webkit-scrollbar {
          height: 6px;
          width: 6px;
        }
        
        .code-container::-webkit-scrollbar-track {
          background: transparent;
        }
        
        .code-container::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
        }
        
        .code-container::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        
        /* Hide scrollbar until hover */
        .code-container::-webkit-scrollbar-thumb {
          background: transparent;
        }
        
        .code-container:hover::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
        }
        
        .code-container:hover::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>

      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1
            className="text-5xl font-bold mb-2 bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            SouthStack - Real Agentic Loop
          </h1>
          <p
            className="text-gray-400 text-lg"
            style={{ fontFamily: "'Fira Code', monospace" }}
          >
            WebLLM + WebContainer • Fully Offline • Zero Cloud Compute
          </p>
        </div>

        {/* Status Bar */}
        <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-4 mb-6 border border-slate-700 shadow-xl flex items-center justify-between">
          <div
            className="flex items-center gap-4"
            style={{ fontFamily: "'Fira Code', monospace" }}
          >
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  phase === "ready"
                    ? "bg-green-500 heartbeat-pulse"
                    : phase === "error"
                      ? "bg-red-500"
                      : "bg-yellow-500 animate-pulse"
                }`}
              />
              <span className="font-medium flex items-center gap-2">
                {phase === "idle" && "Not Initialized"}
                {phase === "initializing" && (
                  <>
                    Initializing...{" "}
                    <svg
                      className="spinner w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  </>
                )}
                {phase === "ready" && "[READY] Offline"}
                {phase === "generating" && (
                  <>
                    Generating Code...{" "}
                    <svg
                      className="spinner w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  </>
                )}
                {phase === "installing" && (
                  <>
                    Installing Dependencies...{" "}
                    <svg
                      className="spinner w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  </>
                )}
                {phase === "executing" && (
                  <>
                    Executing Code...{" "}
                    <svg
                      className="spinner w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                  </>
                )}
                {phase === "error" && "[ERROR]"}
              </span>
            </div>
            {/* Connection Status Indicator */}
            <div
              className={`px-3 py-1 rounded text-xs font-semibold ${
                isOnline
                  ? "bg-blue-900 text-blue-200 border border-blue-700"
                  : "bg-orange-900 text-orange-200 border border-orange-700"
              }`}
            >
              {isOnline ? "ONLINE" : "OFFLINE - Core Modules Only"}
            </div>
          </div>
          {!isInitializedRef.current && phase !== "initializing" && (
            <button
              onClick={initialize}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 px-6 py-2 rounded-lg font-medium transition-all shadow-lg"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              Initialize System
            </button>
          )}
        </div>

        {/* Initialization Progress */}
        {phase === "initializing" && initProgress && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-4 mb-6 border border-slate-700 shadow-xl">
            <div
              className="text-sm text-blue-400 mb-2"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              Loading Model...
            </div>
            <div
              className="text-xs text-gray-400"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              {initProgress}
            </div>
            <div className="w-full bg-slate-700 rounded-full h-2 mt-3">
              <div
                className="bg-blue-500 h-2 rounded-full animate-pulse"
                style={{ width: "70%" }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-6">
          {/* Left Column: Input & Logs */}
          <div className="space-y-6">
            {/* Offline Mode Warning */}
            {!isOnline && phase === "ready" && (
              <div className="bg-orange-900/20 backdrop-blur-md border border-orange-700 rounded-lg p-4 shadow-xl">
                <h3
                  className="text-orange-400 font-semibold mb-2"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  [OFFLINE MODE ACTIVE]
                </h3>
                <p
                  className="text-orange-200 text-sm mb-2"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  Internet connection not detected. The AI has been configured
                  to generate code using ONLY Node.js built-in modules.
                </p>
                <p
                  className="text-orange-300 text-xs"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  Available: http, https, fs, path, crypto, events, util, url,
                  querystring, stream, buffer, os, process
                </p>
                <p
                  className="text-orange-300 text-xs mt-2"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  Not available: express, axios, lodash, or any npm packages
                </p>
              </div>
            )}

            {/* Prompt Input */}
            {phase === "ready" && (
              <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-6 border border-slate-700 shadow-xl">
                <h2
                  className="text-xl font-semibold mb-4"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  Agentic Prompt
                </h2>
                <textarea
                  value={userPrompt}
                  onChange={(e) => setUserPrompt(e.target.value)}
                  placeholder={
                    isOnline
                      ? "Example: Write an Express.js server with a /health endpoint that returns { status: 'ok' }"
                      : "Example (Offline): Write an HTTP server using the 'http' module with a /health endpoint that returns { status: 'ok' }"
                  }
                  className="w-full bg-slate-950/70 border border-slate-600 rounded-lg p-4 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 min-h-[120px] text-sm transition-all"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                  disabled={phase !== "ready"}
                />
                <button
                  onClick={executeAgenticLoop}
                  disabled={phase !== "ready" || !userPrompt.trim()}
                  className="mt-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-all w-full shadow-lg"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  Execute Agentic Loop
                </button>
              </div>
            )}

            {/* Generated Code Preview - Professional IDE Style */}
            {generatedCode && (
              <div className="bg-slate-900/50 backdrop-blur-md rounded-lg border border-slate-700 shadow-xl overflow-hidden">
                {/* Code Editor Top Bar */}
                <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
                  {/* Window Control Dots */}
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors cursor-pointer"></div>
                    <div className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-colors cursor-pointer"></div>
                    <div className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"></div>
                  </div>

                  {/* Filename */}
                  <div
                    className="absolute left-1/2 transform -translate-x-1/2 text-sm text-gray-400 font-medium"
                    style={{ fontFamily: "'Fira Code', monospace" }}
                  >
                    index.js
                  </div>

                  {/* Copy Button */}
                  <button
                    onClick={handleCopyCode}
                    className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                      codeCopied
                        ? "bg-green-600 text-white"
                        : "bg-blue-600 hover:bg-blue-700 text-white copy-btn-glow"
                    }`}
                    style={{ fontFamily: "'Fira Code', monospace" }}
                  >
                    {codeCopied ? "Copied!" : "Copy Code"}
                  </button>
                </div>

                {/* Syntax Highlighted Code */}
                <div className="overflow-x-auto min-h-[200px] code-container pb-10">
                  <SyntaxHighlighter
                    language={detectLanguage(generatedCode)}
                    style={vscDarkPlus}
                    customStyle={{
                      margin: 0,
                      padding: "1.5rem",
                      paddingBottom: "2.5rem",
                      background: "transparent",
                      fontSize: "0.875rem",
                      fontFamily: "'Fira Code', monospace",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      minHeight: "200px",
                    }}
                    showLineNumbers={true}
                    wrapLines={true}
                    lineNumberStyle={{ marginRight: "1rem", opacity: 0.5 }}
                  >
                    {generatedCode}
                  </SyntaxHighlighter>
                </div>
              </div>
            )}

            {/* Logs with Terminal Styling */}
            <div className="bg-slate-900/50 backdrop-blur-md rounded-lg border border-slate-700 shadow-xl overflow-hidden">
              {/* Terminal Header Bar */}
              <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500"></div>
                  <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                </div>
                <div
                  className="text-sm text-gray-400 font-medium"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  System Logs
                </div>
                <div className="w-20"></div>
              </div>

              {/* Logs Content */}
              <div className="p-6">
                <div
                  className="bg-slate-950/70 rounded-lg p-4 max-h-[400px] overflow-y-auto text-sm border border-slate-700"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  {logs.length === 0 ? (
                    <p className="text-gray-500 italic">
                      No logs yet. Click Initialize to begin.
                    </p>
                  ) : (
                    logs.map((log, idx) => (
                      <div
                        key={idx}
                        className={`mb-2 pb-2 border-b border-slate-800 last:border-0 ${
                          log.type === "error"
                            ? "text-red-400"
                            : log.type === "success"
                              ? "text-green-400"
                              : log.type === "warning"
                                ? "text-yellow-400"
                                : "text-gray-300"
                        }`}
                      >
                        <span className="text-gray-500 text-xs">
                          [{log.timestamp.toLocaleTimeString()}]
                        </span>{" "}
                        {log.message}
                      </div>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Terminal */}
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-6 border border-slate-700 shadow-xl">
            <h2
              className="text-xl font-semibold mb-4"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              Terminal Output
            </h2>
            <Terminal
              processStream={processStream}
              height="calc(100vh - 250px)"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Extract code from LLM response (handles markdown code blocks)
 */
function extractCode(response: string): string {
  // Try to extract from markdown code blocks
  const codeBlockMatch = response.match(
    /```(?:javascript|js|typescript|ts)?\n([\s\S]*?)\n```/,
  );
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // If no code block, return trimmed response
  return response.trim();
}

export default App;
