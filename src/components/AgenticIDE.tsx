import React, { useState, useEffect, useRef } from 'react';
import { useAgenticLoop } from '../hooks/useAgenticLoop';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

/**
 * AgenticIDE - Professional IDE interface showcasing the autonomous coding workflow
 */
export const AgenticIDE: React.FC = () => {
  const { state, initializeEngine, executeAgenticLoop, cancelExecution, isReady } = useAgenticLoop();
  const [userPrompt, setUserPrompt] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.logs]);

  // Glow effect when code updates
  useEffect(() => {
    if (state.generatedCode) {
      setCodeCopied(false);
    }
  }, [state.generatedCode]);

  const handleExecute = async () => {
    if (!userPrompt.trim()) return;
    
    // In production, fetch RAG context from your vector store (e.g., voy)
    const mockRagContext = [
      '// Example: Previous project files',
      'const express = require("express");',
      'const app = express();'
    ];

    await executeAgenticLoop(userPrompt, mockRagContext);
  };

  const handleCopyCode = async () => {
    if (state.generatedCode) {
      await navigator.clipboard.writeText(state.generatedCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  const getPhaseColor = () => {
    switch (state.currentPhase) {
      case 'generating': return 'text-blue-400';
      case 'executing': return 'text-yellow-400';
      case 'fixing': return 'text-orange-400';
      case 'completed': return 'text-green-400';
      case 'error': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  const getPhaseEmoji = () => {
    switch (state.currentPhase) {
      case 'generating': return '🤖';
      case 'executing': return '⚙️';
      case 'fixing': return '🔧';
      case 'completed': return '✅';
      case 'error': return '❌';
      default: return '💤';
    }
  };

  const isPhaseLoading = () => {
    return ['generating', 'executing', 'fixing'].includes(state.currentPhase);
  };

  const detectLanguage = (code: string): string => {
    if (code.includes('import') || code.includes('export') || code.includes('const') || code.includes('let')) {
      return code.includes('tsx') || code.includes('jsx') ? 'tsx' : 'javascript';
    }
    return 'javascript';
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
          <h1 className="text-5xl font-bold mb-2 bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 bg-clip-text text-transparent" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
            SouthStack AI IDE
          </h1>
          <p className="text-gray-400 text-lg" style={{ fontFamily: "'Fira Code', monospace" }}>
            Offline-First Agentic Coding • Zero Cloud Compute • Self-Healing AI
          </p>
        </div>

        {/* Initialization */}
        {!state.isInitialized && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-6 mb-6 border border-slate-700 shadow-xl">
            <h2 className="text-xl font-semibold mb-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>Step 1: Initialize WebLLM</h2>
            <button
              onClick={initializeEngine}
              disabled={state.isLoading}
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-all shadow-lg"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              {state.isLoading ? '⏳ Loading Model...' : '🚀 Initialize AI Engine'}
            </button>
            {state.isLoading && (
              <div className="mt-4 text-sm text-gray-400" style={{ fontFamily: "'Fira Code', monospace" }}>
                <p>Downloading Qwen-2.5-Coder model (~1GB)...</p>
                <p className="text-xs mt-2">This happens once - then fully offline!</p>
              </div>
            )}
          </div>
        )}

        {/* Status Bar */}
        {state.isInitialized && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-4 mb-6 border border-slate-700 shadow-xl flex items-center justify-between">
            <div className="flex items-center gap-4" style={{ fontFamily: "'Fira Code', monospace" }}>
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${isReady ? 'bg-green-500 heartbeat-pulse' : 'bg-gray-500'}`} />
                <span className="text-sm font-medium">
                  {isReady ? '[READY] Offline' : '[BUSY]'}
                </span>
              </div>
              <div className={`text-sm font-medium ${getPhaseColor()} flex items-center gap-2`}>
                {getPhaseEmoji()} 
                <span>{state.currentPhase.toUpperCase()}</span>
                {isPhaseLoading() && (
                  <svg className="spinner w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                )}
              </div>
              {state.retryCount > 0 && (
                <div className="text-sm text-orange-400">
                  🔄 Self-healing attempt: {state.retryCount}/3
                </div>
              )}
            </div>
            {state.isExecuting && (
              <button
                onClick={cancelExecution}
                className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded text-sm font-medium transition-colors"
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                ⏹ Cancel
              </button>
            )}
          </div>
        )}

        {/* Prompt Input */}
        {isReady && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg p-6 mb-6 border border-slate-700 shadow-xl">
            <h2 className="text-xl font-semibold mb-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>Agentic Prompt</h2>
            <textarea
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              placeholder="Example: Create an Express.js server with a /health endpoint..."
              className="w-full bg-slate-950/70 border border-slate-600 rounded-lg p-4 text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/50 min-h-[100px] text-sm transition-all"
              style={{ fontFamily: "'Fira Code', monospace" }}
              disabled={state.isExecuting}
            />
            <button
              onClick={handleExecute}
              disabled={state.isExecuting || !userPrompt.trim()}
              className="mt-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 disabled:from-gray-700 disabled:to-gray-700 disabled:cursor-not-allowed px-6 py-3 rounded-lg font-medium transition-all shadow-lg"
              style={{ fontFamily: "'Fira Code', monospace" }}
            >
              {state.isExecuting ? '⚡ Executing Agentic Loop...' : '⚡ Execute Agentic Loop'}
            </button>
          </div>
        )}

        {/* Generated Code Preview - Professional IDE Style */}
        {state.generatedCode && (
          <div className="bg-slate-900/50 backdrop-blur-md rounded-lg mb-6 border border-slate-700 shadow-xl overflow-hidden">
            {/* Code Editor Top Bar */}
            <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
              {/* Window Control Dots */}
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 transition-colors cursor-pointer"></div>
                <div className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 transition-colors cursor-pointer"></div>
                <div className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 transition-colors cursor-pointer"></div>
              </div>
              
              {/* Filename */}
              <div className="absolute left-1/2 transform -translate-x-1/2 text-sm text-gray-400 font-medium" style={{ fontFamily: "'Fira Code', monospace" }}>
                index.js
              </div>
              
              {/* Copy Button */}
              <button
                onClick={handleCopyCode}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${
                  codeCopied 
                    ? 'bg-green-600 text-white' 
                    : 'bg-blue-600 hover:bg-blue-700 text-white copy-btn-glow'
                }`}
                style={{ fontFamily: "'Fira Code', monospace" }}
              >
                {codeCopied ? '✓ Copied!' : '📋 Copy Code'}
              </button>
            </div>
            
            {/* Syntax Highlighted Code */}
            <div className="overflow-x-auto min-h-[200px] code-container pb-10">
              <SyntaxHighlighter
                language={detectLanguage(state.generatedCode)}
                style={vscDarkPlus}
                customStyle={{
                  margin: 0,
                  padding: '1.5rem',
                  paddingBottom: '2.5rem',
                  background: 'transparent',
                  fontSize: '0.875rem',
                  fontFamily: "'Fira Code', monospace",
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  minHeight: '200px',
                }}
                showLineNumbers={true}
                wrapLines={true}
                lineNumberStyle={{ marginRight: '1rem', opacity: 0.5 }}
              >
                {state.generatedCode}
              </SyntaxHighlighter>
            </div>
          </div>
        )}

        {/* Execution Logs with Terminal Styling */}
        <div className="bg-slate-900/50 backdrop-blur-md rounded-lg border border-slate-700 shadow-xl overflow-hidden">
          {/* Terminal Header Bar */}
          <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-slate-700">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
            </div>
            <div className="text-sm text-gray-400 font-medium" style={{ fontFamily: "'Fira Code', monospace" }}>
              System Logs
            </div>
            <div className="w-20"></div>
          </div>
          
          {/* Terminal Content */}
          <div className="p-6">
            <div className="bg-slate-950/70 rounded-lg p-4 max-h-[400px] overflow-y-auto text-sm border border-slate-700" style={{ fontFamily: "'Fira Code', monospace" }}>
              {state.logs.length === 0 ? (
                <p className="text-gray-500 italic">No logs yet. Initialize the engine to begin.</p>
              ) : (
                state.logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`mb-2 pb-2 border-b border-slate-800 last:border-0 ${
                      log.type === 'error' ? 'text-red-400' :
                      log.type === 'success' ? 'text-green-400' :
                      log.type === 'warning' ? 'text-yellow-400' :
                      'text-gray-300'
                    }`}
                  >
                    <span className="text-gray-500 text-xs">
                      [{log.timestamp.toLocaleTimeString()}]
                    </span>{' '}
                    <span className="text-blue-400 font-semibold">[{log.phase}]</span>{' '}
                    {log.message}
                  </div>
                ))
              )}
              <div ref={logsEndRef} />
            </div>
          </div>
        </div>

        {/* Error Display */}
        {state.error && (
          <div className="mt-6 bg-red-900/20 backdrop-blur-md border border-red-500 rounded-lg p-4 shadow-xl">
            <h3 className="text-red-400 font-semibold mb-2" style={{ fontFamily: "'JetBrains Mono', monospace" }}>⚠️ Error</h3>
            <p className="text-red-300 text-sm" style={{ fontFamily: "'Fira Code', monospace" }}>{state.error}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgenticIDE;
