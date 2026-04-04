import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  lazy,
  Suspense,
  useCallback,
} from "react";
import { useAgenticLoop } from "../hooks/useAgenticLoop";
import { useSwarmManager } from "../hooks/useSwarmManager";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { WindowControls } from "./WindowControls";
import { LightweightCodeViewer } from "./LightweightCodeViewer";
import { VirtualizedLogViewer } from "./VirtualizedLogViewer";
import { SwarmControlPanel } from "./SwarmControlPanel";
import {
  detectDeviceCapability,
  getPerformanceConfig,
  throttle,
  limitArraySize,
  type PerformanceConfig,
} from "../utils/performance";

// Lazy load heavy syntax highlighter
const SyntaxHighlighter = lazy(() =>
  import("react-syntax-highlighter").then((module) => ({
    default: module.Prism,
  })),
);

/**
 * AgenticIDE - Professional IDE interface showcasing the autonomous coding workflow
 */
export const AgenticIDE: React.FC = () => {
  const {
    state,
    initializeEngine,
    executeAgenticLoop,
    cancelExecution,
    isReady,
    engine,
  } = useAgenticLoop();
  const [userPrompt, setUserPrompt] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [perfConfig, setPerfConfig] = useState<PerformanceConfig | null>(null);
  const [highlighterStyle, setHighlighterStyle] = useState<any>(null);
  const [showSwarmPanel, setShowSwarmPanel] = useState(false);
  const [completedFiles, setCompletedFiles] = useState<
    { fileName: string; content: string }[]
  >([]);
  const [selectedCompletedFileName, setSelectedCompletedFileName] = useState<
    string | null
  >(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // File write handler for swarm (writes to console/logs)
  const handleSwarmFileWrite = useCallback(
    async (fileName: string, content: string) => {
      console.log(`[Swarm] File write: ${fileName} (${content.length} bytes)`);

      // Store completed files from master writes so they can be inspected in the UI.
      setCompletedFiles((prev) => {
        const existingIndex = prev.findIndex(
          (file) => file.fileName === fileName,
        );

        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = { fileName, content };
          return next;
        }

        return [...prev, { fileName, content }];
      });

      // Auto-select first completed file for immediate visibility.
      setSelectedCompletedFileName((prev) => prev ?? fileName);
    },
    [],
  );

  // Initialize Swarm Manager with engine from useAgenticLoop
  const swarmManager = useSwarmManager(engine, handleSwarmFileWrite);

  const appendPromptTranscript = useCallback((transcript: string) => {
    setUserPrompt((prev) => {
      if (prev.trim().length === 0) {
        return transcript;
      }

      return `${prev}${/\s$/.test(prev) ? "" : " "}${transcript}`;
    });
  }, []);

  const promptVoice = useVoiceInput(appendPromptTranscript);

  // Detect device capability and configure performance settings
  useEffect(() => {
    detectDeviceCapability().then((capability) => {
      const config = getPerformanceConfig(capability);
      setPerfConfig(config);

      // Lazy load syntax highlighter style only if needed
      if (config.syntaxHighlightingEnabled) {
        import("react-syntax-highlighter/dist/esm/styles/prism").then(
          (module) => {
            setHighlighterStyle(module.vscDarkPlus);
          },
        );
      }
    });
  }, []);

  // Limit logs for memory management
  const optimizedLogs = useMemo(() => {
    if (!perfConfig) return state.logs;
    return limitArraySize(state.logs, perfConfig.maxLogs);
  }, [state.logs, perfConfig]);

  // Auto-scroll logs with throttling for performance
  const throttledScrollToBottom = useMemo(
    () =>
      throttle(() => {
        if (logsEndRef.current && perfConfig) {
          logsEndRef.current.scrollIntoView({
            behavior: perfConfig.scrollBehavior,
          });
        }
      }, perfConfig?.autoScrollThrottle || 100),
    [perfConfig],
  );

  useEffect(() => {
    if (!perfConfig?.useVirtualScrolling) {
      throttledScrollToBottom();
    }
  }, [state.logs, perfConfig, throttledScrollToBottom]);

  // Glow effect when code updates
  useEffect(() => {
    if (state.generatedCode) {
      setCodeCopied(false);
    }
  }, [state.generatedCode]);

  const handleExecute = async () => {
    if (!userPrompt.trim()) return;

    promptVoice.stopListening();

    // Blur the textarea to prevent duplicate submissions
    textareaRef.current?.blur();

    // In production, fetch RAG context from your vector store (e.g., voy)
    const mockRagContext = [
      "// Example: Previous project files",
      'const express = require("express");',
      "const app = express();",
    ];

    await executeAgenticLoop(userPrompt, mockRagContext);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter without modifiers = execute
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      handleExecute();
    }
    // Ctrl + Enter or Shift + Enter = new line (default behavior)
  };

  const handleCopyCode = async () => {
    if (state.generatedCode) {
      await navigator.clipboard.writeText(state.generatedCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  // Model selection removed - 0.5B is the only available model

  const formatStorageSize = (bytes: number): string => {
    const gb = bytes / (1024 * 1024 * 1024);
    return gb > 1
      ? `${gb.toFixed(2)}GB`
      : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  };

  const getPhaseColor = () => {
    switch (state.currentPhase) {
      case "generating":
        return "text-blue-400";
      case "executing":
        return "text-yellow-400";
      case "fixing":
        return "text-orange-400";
      case "completed":
        return "text-green-400";
      case "error":
        return "text-red-400";
      default:
        return "text-gray-400";
    }
  };

  const getPhaseIcon = () => {
    switch (state.currentPhase) {
      case "generating":
        return "[GEN]";
      case "executing":
        return "[EXEC]";
      case "fixing":
        return "[FIX]";
      case "completed":
        return "[DONE]";
      case "error":
        return "[ERR]";
      default:
        return "[IDLE]";
    }
  };

  const isPhaseLoading = () => {
    return ["generating", "executing", "fixing"].includes(state.currentPhase);
  };

  // Memoize language detection to avoid recomputation
  const detectedLanguage = useMemo(() => {
    if (!state.generatedCode) return "javascript";
    const code = state.generatedCode;
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
  }, [state.generatedCode]);

  const selectedCompletedFile = useMemo(() => {
    if (completedFiles.length === 0) {
      return null;
    }

    if (selectedCompletedFileName) {
      const selected = completedFiles.find(
        (file) => file.fileName === selectedCompletedFileName,
      );
      if (selected) {
        return selected;
      }
    }

    return completedFiles[0];
  }, [completedFiles, selectedCompletedFileName]);

  const detectFileLanguage = (fileName: string): string => {
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith(".py")) return "python";
    if (lowerName.endsWith(".ts")) return "typescript";
    if (lowerName.endsWith(".tsx")) return "tsx";
    if (lowerName.endsWith(".js")) return "javascript";
    if (lowerName.endsWith(".jsx")) return "jsx";
    if (lowerName.endsWith(".json")) return "json";
    if (lowerName.endsWith(".md")) return "markdown";

    return "text";
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-slate-900 to-gray-900 text-white p-8">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
        
        @keyframes heartbeat {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.1); opacity: 0.8; }
        }
        
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        
        .heartbeat-pulse {
          animation: ${perfConfig?.reduceAnimations ? "none" : "heartbeat 2s ease-in-out infinite"};
        }
        
        .spinner {
          animation: ${perfConfig?.reduceAnimations ? "spin 2s linear infinite" : "spin 1s linear infinite"};
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
            SouthStack AI IDE
          </h1>
          <p
            className="text-gray-400 text-lg"
            style={{ fontFamily: "'Fira Code', monospace" }}
          >
            Offline-First Agentic Coding • Zero Cloud Compute • Self-Healing AI
          </p>
        </div>

        {/* Initialization */}
        {!state.isInitialized && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-6 mb-6 border border-slate-700 shadow-xl">
            <h2
              className="text-xl font-semibold mb-4"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              Step 1: Configure & Initialize
            </h2>

            {/* Engine Badge - Static Display */}
            <div className="mb-4">
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center gap-2 bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/50 rounded-lg px-4 py-3">
                  <div className="w-2 h-2 rounded-full bg-blue-400 shadow-lg shadow-blue-400/50"></div>
                  <span
                    className="text-sm font-semibold text-blue-300"
                    style={{ fontFamily: "'Fira Code', monospace" }}
                  >
                    Engine: Standard (0.5B)
                  </span>
                </div>
                <div
                  className="text-xs text-gray-400"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  ~500MB • Optimized for all devices
                </div>
              </div>

              {/* Storage Info */}
              {state.storageAvailable !== null && (
                <div className="mt-3 flex items-center gap-2 bg-slate-800/50 border border-slate-600 rounded-lg p-3">
                  <span className="text-blue-400 text-sm font-bold">ℹ</span>
                  <div
                    className="text-xs text-gray-300"
                    style={{ fontFamily: "'Fira Code', monospace" }}
                  >
                    <span className="font-semibold">Available Storage:</span>{" "}
                    {formatStorageSize(state.storageAvailable)}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={initializeEngine}
              disabled={state.isLoading}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-all shadow-lg"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              {state.isLoading ? "Loading Model..." : "Initialize AI Engine"}
            </button>
            {state.isLoading && (
              <div
                className="mt-4 text-sm text-gray-400"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                <p>Downloading Standard 0.5B Engine (~500MB)...</p>
                <p className="text-xs mt-2">
                  This happens once - then fully offline!
                </p>
              </div>
            )}
          </div>
        )}

        {/* Status Bar */}
        {state.isInitialized && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-4 mb-6 border border-slate-700 shadow-xl flex items-center justify-between">
            <div
              className="flex items-center gap-4"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              <div className="flex items-center gap-2">
                <div
                  className={`w-3 h-3 rounded-full ${isReady ? "bg-green-500 heartbeat-pulse" : "bg-gray-500"}`}
                />
                <span className="text-sm font-medium">
                  {isReady ? "[READY] Offline" : "[BUSY]"}
                </span>
              </div>
              <div className="text-xs text-gray-400 px-2 py-1 bg-slate-800 rounded border border-slate-600">
                Engine: Standard (0.5B)
              </div>
              {/* Swarm Status Badge */}
              {swarmManager.isInitialized && (
                <div className="flex items-center gap-2 text-xs">
                  <div
                    className={`w-2 h-2 rounded-full ${swarmManager.activeConnectionCount > 0 ? "bg-green-500" : "bg-yellow-500"}`}
                  />
                  <span className="text-gray-300">
                    P2P: {swarmManager.activeConnectionCount} nodes
                  </span>
                </div>
              )}
              <div
                className={`text-sm font-medium ${getPhaseColor()} flex items-center gap-2`}
              >
                {getPhaseIcon()}
                <span>{state.currentPhase.toUpperCase()}</span>
                {isPhaseLoading() && (
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
                )}
              </div>
              {state.retryCount > 0 && (
                <div className="text-sm text-orange-400">
                  [RETRY] Self-healing attempt: {state.retryCount}/3
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Swarm Toggle Button */}
              <button
                onClick={() => setShowSwarmPanel(!showSwarmPanel)}
                className="bg-purple-600 hover:bg-purple-700 px-4 py-2 rounded text-sm font-medium transition-colors"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                {showSwarmPanel ? "Hide" : "Show"} P2P Swarm
              </button>
              {state.isExecuting && (
                <button
                  onClick={cancelExecution}
                  className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded text-sm font-medium transition-colors"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}

        {/* P2P Swarm Control Panel */}
        {showSwarmPanel && swarmManager.isInitialized && (
          <div className="mb-6">
            <SwarmControlPanel
              peerId={swarmManager.peerId}
              connectionStatus={swarmManager.connectionStatus}
              activeConnectionCount={swarmManager.activeConnectionCount}
              swarmMode={swarmManager.swarmMode}
              isProcessing={swarmManager.isProcessing}
              currentTask={swarmManager.currentTask}
              isInitialized={swarmManager.isInitialized}
              connectToNode={swarmManager.connectToNode}
              disconnectAll={swarmManager.disconnectAll}
              distributeTask={swarmManager.distributeTask}
              distributeDebugAnalysis={swarmManager.distributeDebugAnalysis}
              getProgress={swarmManager.getProgress}
              getAllTasks={swarmManager.getAllTasks}
              isMasterHeartbeatHealthy={swarmManager.isMasterHeartbeatHealthy}
            />
          </div>
        )}

        {/* Prompt Input */}
        {isReady && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-6 mb-6 border border-slate-700 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2
                className="text-xl font-semibold"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Agentic Prompt
              </h2>
              <button
                type="button"
                onClick={
                  promptVoice.isListening
                    ? promptVoice.stopListening
                    : promptVoice.startListening
                }
                disabled={!promptVoice.isSupported || state.isExecuting}
                className="px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-600 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                {promptVoice.isListening ? "Stop Mic" : "Start Mic"}
              </button>
            </div>
            <textarea
              ref={textareaRef}
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Example: Create an Express.js server with a /health endpoint..."
              className="w-full bg-slate-950/70 border border-slate-600 rounded-lg p-4 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 min-h-[100px] text-sm transition-all"
              style={{ fontFamily: "'Fira Code', monospace" }}
              disabled={state.isExecuting}
            />
            {!promptVoice.isSupported && (
              <p
                className="mt-2 text-xs text-amber-300"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                Voice input is not supported in this browser.
              </p>
            )}
            {promptVoice.error && (
              <p
                className="mt-2 text-xs text-red-300"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                {promptVoice.error}
              </p>
            )}
            <p
              className="mt-2 text-xs text-gray-400"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              Press{" "}
              <kbd className="px-1.5 py-0.5 bg-slate-700 rounded border border-slate-600 text-gray-300">
                Enter
              </kbd>{" "}
              to run,{" "}
              <kbd className="px-1.5 py-0.5 bg-slate-700 rounded border border-slate-600 text-gray-300">
                Ctrl + Enter
              </kbd>{" "}
              for new line
            </p>
            <button
              onClick={handleExecute}
              disabled={state.isExecuting || !userPrompt.trim()}
              className="mt-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-all shadow-lg"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              {state.isExecuting
                ? "Executing Agentic Loop..."
                : "Execute Agentic Loop"}
            </button>
          </div>
        )}

        {/* Generated Code Preview - Professional IDE Style */}
        {state.generatedCode && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg mb-6 border border-slate-700 shadow-xl overflow-hidden">
            {/* Code Editor Top Bar */}
            <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
              {/* Window Control Dots */}
              <WindowControls currentPhase={state.currentPhase} />

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
              {perfConfig?.syntaxHighlightingEnabled && highlighterStyle ? (
                <Suspense
                  fallback={
                    <div className="p-6 text-gray-400 font-mono text-sm">
                      Loading syntax highlighter...
                    </div>
                  }
                >
                  <SyntaxHighlighter
                    language={detectedLanguage}
                    style={highlighterStyle}
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
                    {state.generatedCode}
                  </SyntaxHighlighter>
                </Suspense>
              ) : (
                <LightweightCodeViewer
                  code={state.generatedCode}
                  language={detectedLanguage}
                />
              )}
            </div>
          </div>
        )}

        {/* Swarm Completed Files Viewer */}
        {completedFiles.length > 0 && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg mb-6 border border-slate-700 shadow-xl overflow-hidden">
            <div className="bg-slate-800/80 px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <div
                className="text-sm text-gray-300 font-medium"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                Swarm Completed Files
              </div>
              <div
                className="text-xs text-gray-400"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                {completedFiles.length} file
                {completedFiles.length > 1 ? "s" : ""}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] min-h-[320px]">
              <div className="border-r border-slate-700 bg-slate-950/50 p-3">
                <div
                  className="text-xs text-gray-400 mb-2"
                  style={{ fontFamily: "'Fira Code', monospace" }}
                >
                  Output Files
                </div>
                <div className="space-y-2 max-h-[300px] overflow-y-auto">
                  {completedFiles.map((file) => {
                    const isSelected =
                      selectedCompletedFile?.fileName === file.fileName;

                    return (
                      <button
                        key={file.fileName}
                        onClick={() =>
                          setSelectedCompletedFileName(file.fileName)
                        }
                        className={`w-full text-left px-3 py-2 rounded border transition-colors ${
                          isSelected
                            ? "bg-blue-600/20 border-blue-500 text-blue-200"
                            : "bg-slate-900/80 border-slate-700 text-gray-300 hover:bg-slate-800"
                        }`}
                        style={{ fontFamily: "'Fira Code', monospace" }}
                      >
                        <div className="text-xs font-semibold truncate">
                          {file.fileName}
                        </div>
                        <div className="text-[11px] opacity-70 mt-1">
                          {file.content.length} bytes
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="overflow-x-auto code-container">
                {selectedCompletedFile &&
                  (perfConfig?.syntaxHighlightingEnabled && highlighterStyle ? (
                    <Suspense
                      fallback={
                        <div className="p-6 text-gray-400 font-mono text-sm">
                          Loading syntax highlighter...
                        </div>
                      }
                    >
                      <SyntaxHighlighter
                        language={detectFileLanguage(
                          selectedCompletedFile.fileName,
                        )}
                        style={highlighterStyle}
                        customStyle={{
                          margin: 0,
                          padding: "1.5rem",
                          background: "transparent",
                          fontSize: "0.875rem",
                          fontFamily: "'Fira Code', monospace",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-all",
                          minHeight: "320px",
                        }}
                        showLineNumbers={true}
                        wrapLines={true}
                        lineNumberStyle={{ marginRight: "1rem", opacity: 0.5 }}
                      >
                        {selectedCompletedFile.content}
                      </SyntaxHighlighter>
                    </Suspense>
                  ) : (
                    <LightweightCodeViewer
                      code={selectedCompletedFile.content}
                      language={detectFileLanguage(
                        selectedCompletedFile.fileName,
                      )}
                    />
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Execution Logs with Terminal Styling */}
        <div className="bg-slate-900/50 backdrop-blur-md rounded-lg border border-slate-700 shadow-xl overflow-hidden">
          {/* Terminal Header Bar */}
          <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
            <WindowControls currentPhase={state.currentPhase} />
            <div
              className="text-sm text-gray-400 font-medium"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              System Logs
            </div>
            <div className="w-20"></div>
          </div>

          {/* Terminal Content */}
          <div className="p-6">
            {optimizedLogs.length === 0 ? (
              <div
                className="bg-slate-950/70 rounded-lg p-4 text-sm border border-slate-700"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                <p className="text-gray-500 italic">
                  No logs yet. Initialize the engine to begin.
                </p>
              </div>
            ) : perfConfig?.useVirtualScrolling ? (
              <VirtualizedLogViewer logs={optimizedLogs} maxHeight={400} />
            ) : (
              <div
                className="bg-slate-950/70 rounded-lg p-4 max-h-[400px] overflow-y-auto text-sm border border-slate-700"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                {optimizedLogs.map((log, idx) => (
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
                    <span className="text-blue-400 font-semibold">
                      [{log.phase}]
                    </span>{" "}
                    {log.message}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Error Display */}
        {state.error && (
          <div className="mt-6 bg-red-900/20 backdrop-blur-md border border-red-500 rounded-lg p-4 shadow-xl">
            <h3
              className="text-red-400 font-semibold mb-2"
              style={{ fontFamily: "'JetBrains Mono', monospace" }}
            >
              Error
            </h3>
            <p
              className="text-red-300 text-sm"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              {state.error}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgenticIDE;
