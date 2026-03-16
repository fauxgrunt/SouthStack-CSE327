<!-- cSpell:words peerjs webllm Qwen PeerJS WebLLM STUN -->

# 🐝 SouthStack Swarm - Distributed AI Code Generation

A peer-to-peer distributed system for parallel AI code generation using WebRTC and WebLLM. Distribute complex coding tasks across multiple browser instances for faster, parallel execution.

## 🎯 Overview

The Swarm system enables:

- **Distributed Task Decomposition**: Break down complex projects into modular, independent tasks
- **Parallel Code Generation**: Execute multiple AI code generation tasks simultaneously across connected nodes
- **Automatic Result Collection**: Master node automatically collects and writes generated code to files
- **Zero Server Infrastructure**: Pure P2P communication using WebRTC (PeerJS)

## 🏗️ Architecture

```
┌─────────────┐
│ Master Node │ (Browser Instance 1)
│   👑 AI     │
└──────┬──────┘
       │ WebRTC
       ├─────────────┬─────────────┐
       │             │             │
┌──────▼──────┐ ┌───▼──────┐ ┌────▼─────┐
│ Worker Node │ │ Worker   │ │ Worker   │
│   ⚙️ AI     │ │   ⚙️ AI  │ │   ⚙️ AI  │
└─────────────┘ └──────────┘ └──────────┘
```

### Workflow

1. **Master Node**: Receives user request (e.g., "Build a todo app")
2. **Task Decomposition**: Uses 0.5B AI model to break into modular tasks
   ```json
   [
     { "fileName": "components/TodoList.tsx", "instructions": "..." },
     { "fileName": "hooks/useTodos.ts", "instructions": "..." },
     { "fileName": "utils/storage.ts", "instructions": "..." }
   ]
   ```
3. **Distribution**: Assigns tasks round-robin to connected workers via WebRTC
4. **Parallel Execution**: Each worker generates code using local AI
5. **Result Return**: Workers send completed code back to master
6. **File Writing**: Master automatically writes all files to the file system

## 📦 Components

### 1. `useSwarm` Hook

Core P2P connection management.

```typescript
const {
  peerId, // Your unique peer ID
  connections, // Array of active connections
  isMaster, // Master node status
  isInitialized, // Ready status
  connectToNode, // Connect to another peer
  broadcastTask, // Send to all nodes
  sendTaskToNode, // Send to specific node
  onData, // Register data handler
  disconnectAll, // Close all connections
} = useSwarm();
```

### 2. `useSwarmManager` Hook

High-level swarm orchestration with AI integration.

```typescript
const swarmManager = useSwarmManager(engine, writeFile);

// Distribute task across swarm (Master)
await swarmManager.distributeTask("Build a React dashboard");

// Execute task locally (Standalone)
await swarmManager.executeLocalTask("Button.tsx", "Create a button component");

// Get progress (Master)
const progress = swarmManager.getProgress();
// { total: 5, completed: 3, pending: 2, failed: 0, percentage: 60 }
```

### 3. `SwarmControlPanel` Component

Complete UI for swarm management.

```tsx
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
```

### 4. Orchestrator Service

AI-powered task decomposition and worker execution.

```typescript
import {
  orchestrateSwarm,
  executeWorkerTask,
} from "./services/swarmOrchestrator";

// Master: Decompose and distribute
const assignments = await orchestrateSwarm(
  userPrompt,
  engine,
  activeConnections,
  sendTaskToNode,
);

// Worker: Execute assigned task
const code = await executeWorkerTask(taskPayload, engine);
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install peerjs
```

### 2. Import Components

```typescript
import { useSwarmManager } from "./hooks/useSwarmManager";
import { SwarmControlPanel } from "./components/SwarmControlPanel";
```

### 3. Initialize in Your App

```typescript
function App() {
  const [engine, setEngine] = useState<webllm.MLCEngine | null>(null);

  // Initialize WebLLM engine
  useEffect(() => {
    (async () => {
      const engine = await webllm.CreateMLCEngine(
        "Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC"
      );
      setEngine(engine);
    })();
  }, []);

  // File write function
  const writeFile = async (fileName: string, content: string) => {
    await webContainerService.writeFile(fileName, content);
  };

  // Initialize swarm
  const swarmManager = useSwarmManager(engine, writeFile);

  return (
    <div>
      <SwarmControlPanel {...swarmManager} />
    </div>
  );
}
```

## 🎮 Usage Modes

### Standalone Mode

Run tasks locally without network connections.

```typescript
await swarmManager.executeLocalTask(
  "components/Header.tsx",
  "Create a responsive header with logo and navigation",
);
```

### Master Mode

Distribute tasks to worker nodes.

```typescript
// 1. Share your peer ID with workers
console.log("My Peer ID:", swarmManager.peerId);

// 2. Wait for workers to connect
// (Workers use connectToNode with your ID)

// 3. Distribute task
await swarmManager.distributeTask(
  "Create a full-stack blog with React, Express, and MongoDB",
);

// 4. Monitor progress
const progress = swarmManager.getProgress();
console.log(`${progress.completed}/${progress.total} tasks completed`);
```

### Worker Mode

Connect to master and process tasks.

```typescript
// 1. Get master's peer ID
const masterPeerId = "abc-123-def-456"; // From master node

// 2. Connect
await swarmManager.connectToNode(masterPeerId);

// 3. Worker automatically:
//    - Receives tasks
//    - Generates code using local AI
//    - Sends results back to master
```

## 🔧 Configuration

### System Prompts

Customize AI behavior by modifying prompts in `swarmOrchestrator.ts`:

```typescript
// Task decomposition prompt (Master)
export const SWARM_MANAGER_PROMPT = `You are a Technical Project Manager...`;

// Code generation prompt (Worker)
export const WORKER_PROMPT = `You are a Code Generation AI Worker...`;
```

### Connection Settings

Configure PeerJS options in `useSwarm.ts`:

```typescript
const peer = new Peer({
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
  },
});
```

## 📊 Task Tracking

The `SwarmTaskTracker` class provides detailed progress monitoring:

```typescript
const tracker = new SwarmTaskTracker();

// Add task
tracker.addTask(taskId, assignment, nodeId);

// Update status
tracker.completeTask(taskId, code);
tracker.failTask(taskId, error);

// Query status
const pending = tracker.getPendingTasks();
const completed = tracker.getCompletedTasks();
const progress = tracker.getProgress();
const allDone = tracker.isAllCompleted();
```

## 🎯 Example Use Cases

### 1. Multi-Component UI Library

```typescript
await swarmManager.distributeTask(
  "Create a React component library with Button, Input, Card, Modal, and Dropdown components",
);
// Result: 5 separate files generated in parallel
```

### 2. Full-Stack Application

```typescript
await swarmManager.distributeTask(
  "Build a task management app with React frontend, Express REST API, SQLite database, and authentication",
);
// Result: Frontend, backend, database, and auth modules generated simultaneously
```

### 3. Utility Functions

```typescript
await swarmManager.distributeTask(
  "Create utility functions for date formatting, string manipulation, array operations, and validation",
);
// Result: Multiple utility files created at once
```

## 🔒 Security Considerations

1. **Peer ID Sharing**: Only share your peer ID with trusted collaborators
2. **Code Validation**: Always review generated code before executing
3. **Network Security**: Uses WebRTC encryption for P2P communication
4. **STUN Servers**: Configure your own STUN/TURN servers for production

## 🐛 Troubleshooting

### Connection Issues

- Ensure both peers have internet connectivity
- Check browser console for WebRTC errors
- Verify firewall allows WebRTC traffic

### Task Distribution Failures

- Confirm AI engine is initialized (`engine !== null`)
- Check that workers are connected (`activeConnectionCount > 0`)
- Verify task decomposition JSON is valid

### Worker Execution Errors

- Monitor worker console logs for AI generation errors
- Ensure sufficient GPU memory for WebLLM
- Check task instructions are clear and specific

## 📈 Performance Tips

1. **Optimal Worker Count**: 3-5 workers for best performance
2. **Task Granularity**: Break into 5-10 independent tasks
3. **Worker Resources**: Ensure each worker has sufficient GPU memory
4. **Network Latency**: Local network connections work best

## 🔄 API Reference

See the following files for detailed API documentation:

- [`useSwarm.ts`](./src/hooks/useSwarm.ts) - Core P2P hook
- [`useSwarmManager.ts`](./src/hooks/useSwarmManager.ts) - Orchestration hook
- [`swarmOrchestrator.ts`](./src/services/swarmOrchestrator.ts) - AI services
- [`SwarmControlPanel.tsx`](./src/components/SwarmControlPanel.tsx) - UI component

## 🎓 Advanced Examples

See [`SwarmIntegrationExample.tsx`](./src/SwarmIntegrationExample.tsx) for:

- Complete integration guide
- Usage examples
- Step-by-step tutorials

## 🤝 Contributing

The swarm system is modular and extensible:

- Add custom task types in `SwarmTaskPayload`
- Implement custom orchestration strategies
- Create alternative UI components
- Add monitoring and analytics

## 📄 License

Part of the SouthStack Agentic IDE project.

---

**Built with:**

- [PeerJS](https://peerjs.com/) - WebRTC wrapper
- [WebLLM](https://github.com/mlc-ai/web-llm) - In-browser AI
- [React](https://react.dev/) - UI framework
