/**
 * Type definitions for SouthStack Agentic IDE
 * 
 * This file contains all shared TypeScript interfaces and types
 * used throughout the application.
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export type AgenticPhase = 
  | 'idle' 
  | 'generating' 
  | 'executing' 
  | 'fixing' 
  | 'completed' 
  | 'error';

export type LogLevel = 'info' | 'success' | 'error' | 'warning' | 'debug';

export type FileLanguage = 
  | 'javascript' 
  | 'typescript' 
  | 'jsx' 
  | 'tsx' 
  | 'json' 
  | 'markdown' 
  | 'html' 
  | 'css';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

export interface AgenticLoopState {
  isInitialized: boolean;
  isLoading: boolean;
  isExecuting: boolean;
  currentPhase: AgenticPhase;
  logs: LogEntry[];
  generatedCode: string | null;
  error: string | null;
  retryCount: number;
  metadata?: ExecutionMetadata;
}

export interface LogEntry {
  id?: string;
  timestamp: Date;
  phase: string;
  message: string;
  type: LogLevel;
  data?: any;
}

export interface ExecutionMetadata {
  startTime: number;
  endTime?: number;
  duration?: number;
  tokensGenerated?: number;
  retries: number;
  modelUsed: string;
}

// ============================================================================
// WEBLLM INTEGRATION
// ============================================================================

export interface ModelConfig {
  id: string;
  name: string;
  size: string;
  vramRequired: number;
  contextWindow: number;
  specialization?: string;
}

export interface InferenceOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string[];
}

export interface GenerationResult {
  code: string;
  language: FileLanguage;
  confidence: number;
  reasoning?: string;
  metadata: {
    model: string;
    tokens: number;
    duration: number;
  };
}

// ============================================================================
// EXECUTION ENVIRONMENT
// ============================================================================

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  stackTrace?: string;
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  duration?: number;
}

export interface WebContainerConfig {
  workdir?: string;
  env?: Record<string, string>;
  timeout?: number;
  memoryLimit?: number;
}

export interface VirtualFile {
  path: string;
  content: string;
  language: FileLanguage;
  size: number;
  lastModified: Date;
}

export interface VirtualFileSystem {
  files: Map<string, VirtualFile>;
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  deleteFile: (path: string) => Promise<void>;
  listFiles: (directory?: string) => Promise<string[]>;
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

export type ErrorType = 
  | 'syntax' 
  | 'runtime' 
  | 'missing-module' 
  | 'timeout' 
  | 'oom' 
  | 'webgpu' 
  | 'network' 
  | 'fatal';

export interface ErrorClassification {
  type: ErrorType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recoverable: boolean;
  confidence: number;
  suggestion?: string;
  relatedFiles?: string[];
}

export interface ErrorAnalysis {
  original: Error;
  classification: ErrorClassification;
  context: {
    code: string;
    lineNumber?: number;
    stackTrace?: string;
  };
  suggestedFix?: string;
}

// ============================================================================
// RAG & CONTEXT
// ============================================================================

export interface RAGDocument {
  id: string;
  content: string;
  metadata: {
    filePath: string;
    language: FileLanguage;
    lastModified: Date;
    tokens: number;
  };
  embedding?: number[];
}

export interface RAGSearchResult {
  document: RAGDocument;
  score: number;
  relevance: 'high' | 'medium' | 'low';
}

export interface ContextWindow {
  systemPrompt: string;
  userPrompt: string;
  ragContext: RAGSearchResult[];
  conversationHistory?: Message[];
  totalTokens: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

// ============================================================================
// AGENT SYSTEM
// ============================================================================

export type AgentRole = 
  | 'coordinator' 
  | 'coder' 
  | 'debugger' 
  | 'tester' 
  | 'refactor' 
  | 'reviewer';

export interface Agent {
  id: string;
  role: AgentRole;
  name: string;
  capabilities: string[];
  systemPrompt: string;
  config: InferenceOptions;
}

export interface AgentTask {
  id: string;
  type: string;
  description: string;
  assignedAgent: AgentRole;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  input: any;
  output?: any;
  error?: string;
  startTime?: number;
  endTime?: number;
}

export interface MultiAgentWorkflow {
  id: string;
  name: string;
  tasks: AgentTask[];
  currentTask?: AgentTask;
  status: 'idle' | 'running' | 'completed' | 'failed';
  results: Record<string, any>;
}

// ============================================================================
// TESTING
// ============================================================================

export interface TestCase {
  id: string;
  name: string;
  description: string;
  code: string;
  expected: any;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  duration?: number;
  error?: string;
}

export interface TestSuite {
  name: string;
  tests: TestCase[];
  totalTests: number;
  passedTests: number;
  failedTests: number;
  coverage?: number;
}

// ============================================================================
// PROJECT STRUCTURE
// ============================================================================

export interface Project {
  id: string;
  name: string;
  description: string;
  rootPath: string;
  files: VirtualFile[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  config: ProjectConfig;
  createdAt: Date;
  lastModified: Date;
}

export interface ProjectConfig {
  language: 'javascript' | 'typescript';
  framework?: 'react' | 'vue' | 'svelte' | 'express' | 'none';
  buildTool?: 'vite' | 'webpack' | 'rollup' | 'none';
  packageManager: 'npm' | 'yarn' | 'pnpm';
  testFramework?: 'jest' | 'vitest' | 'mocha' | 'none';
}

// ============================================================================
// PERFORMANCE MONITORING
// ============================================================================

export interface PerformanceMetrics {
  modelLoadTime: number;
  inferenceLatency: number[];
  executionTime: number[];
  totalRequests: number;
  successRate: number;
  averageRetries: number;
  gpuMemoryUsage?: number;
  ramUsage?: number;
}

export interface BenchmarkResult {
  name: string;
  duration: number;
  iterations: number;
  averageTime: number;
  minTime: number;
  maxTime: number;
  standardDeviation: number;
}

// ============================================================================
// UI COMPONENTS
// ============================================================================

export interface EditorConfig {
  theme: 'dark' | 'light';
  fontSize: number;
  tabSize: number;
  lineNumbers: boolean;
  minimap: boolean;
  autoSave: boolean;
  formatOnSave: boolean;
}

export interface ChatMessage extends Message {
  id: string;
  isUser: boolean;
  artifacts?: {
    code?: string;
    files?: VirtualFile[];
    executionResult?: ExecutionResult;
  };
}

export interface ToastNotification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  message: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// ============================================================================
// STORAGE & PERSISTENCE
// ============================================================================

export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  expiresAt?: number;
  metadata?: Record<string, any>;
}

// ============================================================================
// VECTOR STORE
// ============================================================================

export interface VectorStoreConfig {
  dimension: number;
  metric: 'cosine' | 'euclidean' | 'dot';
  indexType: 'flat' | 'hnsw' | 'ivf';
}

export interface VectorStore {
  add(documents: RAGDocument[]): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<RAGSearchResult[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

export interface SearchOptions {
  topK?: number;
  threshold?: number;
  filter?: Record<string, any>;
}

// ============================================================================
// HOOKS RETURN TYPES
// ============================================================================

export interface UseAgenticLoopReturn {
  state: AgenticLoopState;
  initializeEngine: () => Promise<void>;
  executeAgenticLoop: (
    userPrompt: string,
    ragContext?: string[]
  ) => Promise<{ success: boolean; code?: string; output?: string; error?: string }>;
  cancelExecution: () => void;
  isReady: boolean;
}

export interface UseTestAgentReturn {
  initialize: (engine: any) => Promise<void>;
  generateTests: (
    sourceCode: string,
    framework?: 'jest' | 'vitest' | 'mocha'
  ) => Promise<{ testCode: string; coverage: string[]; success: boolean }>;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type Nullable<T> = T | null;

export type Optional<T> = T | undefined;

export type AsyncFunction<T = void> = () => Promise<T>;

export type EventHandler<T = any> = (event: T) => void;

export type Callback<T = void> = (data: T) => void;

// ============================================================================
// CONSTANTS
// ============================================================================

export const SUPPORTED_LANGUAGES: FileLanguage[] = [
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'json',
  'markdown',
  'html',
  'css',
];

export const MODEL_PRESETS: ModelConfig[] = [
  {
    id: 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC',
    name: 'Qwen 2.5 Coder 1.5B',
    size: '1GB',
    vramRequired: 2,
    contextWindow: 2048,
    specialization: 'code',
  },
  {
    id: 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC',
    name: 'Qwen 2.5 Coder 0.5B',
    size: '350MB',
    vramRequired: 1,
    contextWindow: 2048,
    specialization: 'code',
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    name: 'Llama 3.2 1B',
    size: '600MB',
    vramRequired: 1.5,
    contextWindow: 2048,
    specialization: 'general',
  },
];

export const DEFAULT_INFERENCE_OPTIONS: InferenceOptions = {
  temperature: 0.7,
  top_p: 0.95,
  max_tokens: 1024,
  presence_penalty: 0,
  frequency_penalty: 0,
};
