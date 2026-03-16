/**
 * Swarm Integration Example
 *
 * This file demonstrates how to integrate the P2P Swarm system into your React application.
 * The swarm allows distributed AI task execution across multiple browser instances.
 *
 * INTEGRATION STEPS:
 * ==================
 *
 * 1. Import the required hooks and components
 * 2. Initialize the swarm manager with your WebLLM engine
 * 3. Add the SwarmControlPanel UI component
 * 4. Use distributeTask() or executeLocalTask() to run AI tasks
 */

import React, { useState, useEffect, useRef } from "react";
import * as webllm from "@mlc-ai/web-llm";
import { useSwarmManager } from "./hooks/useSwarmManager";
import { SwarmControlPanel } from "./components/SwarmControlPanel";

/**
 * Example Component - Integrated Swarm Application
 */
export const SwarmExample: React.FC = () => {
  // WebLLM Engine initialization
  const [engine, setEngine] = useState<webllm.MLCEngine | null>(null);
  const [isInitializing, setIsInitializing] = useState(false);
  const engineRef = useRef<webllm.MLCEngine | null>(null);

  // File system mock (replace with your actual file system or WebContainer)
  const writeFile = async (fileName: string, content: string) => {
    console.log(`[FileSystem] Writing file: ${fileName}`);
    console.log(`[FileSystem] Content length: ${content.length} chars`);

    // In a real application, this would write to WebContainer or your virtual FS
    // Example: await webContainerService.writeFile(fileName, content);

    // For demo: just log to console
    console.log(`[FileSystem] ✓ File ${fileName} written successfully`);
  };

  // Initialize the Swarm Manager
  const swarmManager = useSwarmManager(engine, writeFile);

  /**
   * Initialize WebLLM Engine
   */
  const initializeEngine = async () => {
    if (engineRef.current || isInitializing) return;

    setIsInitializing(true);

    try {
      console.log("[Engine] Initializing WebLLM...");

      const newEngine = await webllm.CreateMLCEngine(
        "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC",
        {
          initProgressCallback: (progress) => {
            console.log(`[Engine] Loading: ${progress.text}`);
          },
        },
      );

      engineRef.current = newEngine;
      setEngine(newEngine);
      console.log("[Engine] ✓ WebLLM initialized successfully");
    } catch (error) {
      console.error("[Engine] Failed to initialize:", error);
    } finally {
      setIsInitializing(false);
    }
  };

  // Auto-initialize on mount
  useEffect(() => {
    initializeEngine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-4xl font-bold mb-2">🐝 SouthStack Swarm</h1>
          <p className="text-gray-400">Distributed AI Code Generation System</p>
        </div>

        {/* Engine Status */}
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h2 className="text-lg font-semibold mb-2">AI Engine Status</h2>
          {isInitializing && (
            <p className="text-yellow-400">Initializing WebLLM...</p>
          )}
          {engine && <p className="text-green-400">✓ Engine Ready</p>}
          {!engine && !isInitializing && (
            <button
              onClick={initializeEngine}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
            >
              Initialize Engine
            </button>
          )}
        </div>

        {/* Swarm Control Panel */}
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
          getProgress={swarmManager.getProgress}
        />

        {/* Info Panel */}
        <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
          <h2 className="text-lg font-semibold mb-3">How to Use</h2>
          <div className="space-y-2 text-sm text-gray-300">
            <div>
              <strong className="text-white">🔷 Standalone Mode:</strong>
              <p className="ml-4">Run tasks locally on your machine.</p>
            </div>
            <div>
              <strong className="text-white">👑 Master Mode:</strong>
              <ol className="ml-4 list-decimal">
                <li>Share your Peer ID with worker nodes</li>
                <li>Wait for workers to connect</li>
                <li>
                  Enter a task description and click "Distribute to Swarm"
                </li>
                <li>
                  Watch as tasks are distributed and completed automatically
                </li>
              </ol>
            </div>
            <div>
              <strong className="text-white">⚙️ Worker Mode:</strong>
              <ol className="ml-4 list-decimal">
                <li>Get the Master's Peer ID</li>
                <li>Enter it and click "Connect"</li>
                <li>Wait for tasks to arrive</li>
                <li>
                  Your browser will automatically execute tasks and send results
                  back
                </li>
              </ol>
            </div>
          </div>
        </div>

        {/* Task History */}
        {swarmManager.swarmMode === "master" &&
          swarmManager.distributedTasks.length > 0 && (
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h2 className="text-lg font-semibold mb-3">Distributed Tasks</h2>
              <div className="space-y-2">
                {swarmManager.distributedTasks.map((task, index) => (
                  <div key={index} className="bg-gray-900 rounded p-3 text-sm">
                    <div className="font-mono text-blue-400">
                      {task.fileName}
                    </div>
                    <div className="text-gray-400 mt-1">
                      {task.instructions}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
      </div>
    </div>
  );
};

// ============================================================================
// INTEGRATION INTO EXISTING APP
// ============================================================================

/**
 * To integrate the Swarm system into your existing application:
 *
 * 1. In your main App component, import and initialize useSwarmManager:
 *
 *    import { useSwarmManager } from './hooks/useSwarmManager';
 *    import { SwarmControlPanel } from './components/SwarmControlPanel';
 *
 *    // Inside your component:
 *    const swarmManager = useSwarmManager(engineRef.current, writeFile);
 *
 * 2. Add the SwarmControlPanel to your UI:
 *
 *    <SwarmControlPanel
 *      peerId={swarmManager.peerId}
 *      connectionStatus={swarmManager.connectionStatus}
 *      activeConnectionCount={swarmManager.activeConnectionCount}
 *      swarmMode={swarmManager.swarmMode}
 *      isProcessing={swarmManager.isProcessing}
 *      currentTask={swarmManager.currentTask}
 *      isInitialized={swarmManager.isInitialized}
 *      connectToNode={swarmManager.connectToNode}
 *      disconnectAll={swarmManager.disconnectAll}
 *      distributeTask={swarmManager.distributeTask}
 *      getProgress={swarmManager.getProgress}
 *    />
 *
 * 3. Implement your writeFile function to work with your file system:
 *
 *    const writeFile = async (fileName: string, content: string) => {
 *      await webContainerService.writeFile(fileName, content);
 *      // Or use your own virtual file system
 *    };
 *
 * 4. Optional: Add a button to trigger distributed task execution:
 *
 *    <button onClick={() => swarmManager.distributeTask("Build a React todo app")}>
 *      Distribute Task
 *    </button>
 *
 * See `src/utils/swarmExamples.ts` for usage examples of distributeTask, executeLocalTask, and connectToNode.
 */
