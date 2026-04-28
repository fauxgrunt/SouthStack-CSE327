import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion } from "framer-motion";
import { Loader2, PauseCircle, PlayCircle, Sparkles } from "lucide-react";
import Editor, { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";

interface CollaborativeCodeEditorProps {
  generatedCode: string | null;
  language: string;
  isAgentBusy: boolean;
  pauseAgentEdits: boolean;
  onPauseAgentEditsChange: (paused: boolean) => void;
  focusRequest?: number;
}

const AGENT_STREAM_CHUNK_SIZE = 18;
const AGENT_STREAM_INTERVAL_MS = 34;

export const CollaborativeCodeEditor: React.FC<
  CollaborativeCodeEditorProps
> = ({
  generatedCode,
  language,
  isAgentBusy,
  pauseAgentEdits,
  onPauseAgentEditsChange,
  focusRequest,
}) => {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const bindingRef = useRef<MonacoBinding | null>(null);

  const yDocRef = useRef<Y.Doc | null>(null);
  const yTextRef = useRef<Y.Text | null>(null);

  const streamTimerRef = useRef<number | null>(null);
  const streamStateRef = useRef<{ code: string; offset: number } | null>(null);

  const lastReceivedCodeRef = useRef<string | null>(null);
  const lastAppliedCodeRef = useRef<string | null>(null);
  const pendingCodeRef = useRef<string | null>(null);

  const highlightDecorationIdsRef = useRef<string[]>([]);
  const cursorDecorationIdsRef = useRef<string[]>([]);

  const [isAgentTyping, setIsAgentTyping] = useState(false);

  const clearStreamTimer = useCallback(() => {
    if (streamTimerRef.current !== null) {
      window.clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  }, []);

  const clearDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    highlightDecorationIdsRef.current = editor.deltaDecorations(
      highlightDecorationIdsRef.current,
      [],
    );
    cursorDecorationIdsRef.current = editor.deltaDecorations(
      cursorDecorationIdsRef.current,
      [],
    );
  }, []);

  const applyAgentDecorations = useCallback(
    (startOffset: number, endOffset: number) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;

      if (!editor || !monaco) {
        return;
      }

      const model = editor.getModel();
      if (!model) {
        return;
      }

      const safeEnd = Math.max(0, Math.min(endOffset, model.getValueLength()));
      const safeStart = Math.max(0, Math.min(startOffset, safeEnd));

      const startPos = model.getPositionAt(safeStart);
      const endPos = model.getPositionAt(safeEnd);

      highlightDecorationIdsRef.current = editor.deltaDecorations(
        highlightDecorationIdsRef.current,
        [
          {
            range: new monaco.Range(
              startPos.lineNumber,
              startPos.column,
              endPos.lineNumber,
              endPos.column,
            ),
            options: {
              inlineClassName: "agent-inline-highlight",
            },
          },
        ],
      );

      cursorDecorationIdsRef.current = editor.deltaDecorations(
        cursorDecorationIdsRef.current,
        [
          {
            range: new monaco.Range(
              endPos.lineNumber,
              endPos.column,
              endPos.lineNumber,
              endPos.column,
            ),
            options: {
              after: {
                content: "▍",
                inlineClassName: "agent-cursor-indicator",
              },
            },
          },
        ],
      );
    },
    [],
  );

  const stopAgentStream = useCallback(() => {
    clearStreamTimer();
    streamStateRef.current = null;
    setIsAgentTyping(false);
  }, [clearStreamTimer]);

  const startAgentStream = useCallback(
    (code: string) => {
      const yDoc = yDocRef.current;
      const yText = yTextRef.current;
      const editor = editorRef.current;

      if (!yDoc || !yText || !editor) {
        pendingCodeRef.current = code;
        return;
      }

      clearStreamTimer();
      streamStateRef.current = { code, offset: 0 };
      setIsAgentTyping(true);

      yDoc.transact(() => {
        if (yText.length > 0) {
          yText.delete(0, yText.length);
        }
      }, "agent-reset");

      clearDecorations();

      streamTimerRef.current = window.setInterval(() => {
        if (pauseAgentEdits) {
          return;
        }

        const streamState = streamStateRef.current;
        const yDocInner = yDocRef.current;
        const yTextInner = yTextRef.current;

        if (!streamState || !yDocInner || !yTextInner) {
          stopAgentStream();
          return;
        }

        const nextChunk = streamState.code.slice(
          streamState.offset,
          streamState.offset + AGENT_STREAM_CHUNK_SIZE,
        );

        if (nextChunk.length === 0) {
          stopAgentStream();
          lastAppliedCodeRef.current = streamState.code;
          window.setTimeout(() => {
            clearDecorations();
          }, 1000);
          return;
        }

        const insertAt = streamState.offset;
        streamState.offset += nextChunk.length;

        yDocInner.transact(() => {
          yTextInner.insert(insertAt, nextChunk);
        }, "agent");

        applyAgentDecorations(insertAt, streamState.offset);
      }, AGENT_STREAM_INTERVAL_MS);
    },
    [
      applyAgentDecorations,
      clearDecorations,
      clearStreamTimer,
      pauseAgentEdits,
      stopAgentStream,
    ],
  );

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      if (!yDocRef.current) {
        yDocRef.current = new Y.Doc();
        yTextRef.current = yDocRef.current.getText("main");
      }

      const model = editor.getModel();
      if (!model || !yTextRef.current) {
        return;
      }

      bindingRef.current?.destroy();
      bindingRef.current = new MonacoBinding(
        yTextRef.current,
        model,
        new Set([editor]),
        undefined,
      );

      const queued = pendingCodeRef.current;
      if (queued && queued !== lastAppliedCodeRef.current && !pauseAgentEdits) {
        startAgentStream(queued);
      }
    },
    [pauseAgentEdits, startAgentStream],
  );

  useEffect(() => {
    // If parent requested focus, move caret to document end and focus editor
    if (typeof focusRequest === "number" && focusRequest) {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (editor && monaco) {
        const model = editor.getModel();
        if (model) {
          const endPos = model.getPositionAt(model.getValueLength());
          editor.focus();
          editor.setPosition(endPos);
          editor.revealPositionInCenter(endPos);
        }
      }
    }
  }, [focusRequest]);

  useEffect(() => {
    if (!generatedCode) {
      return;
    }

    if (generatedCode === lastReceivedCodeRef.current) {
      return;
    }

    lastReceivedCodeRef.current = generatedCode;
    pendingCodeRef.current = generatedCode;

    if (!pauseAgentEdits) {
      startAgentStream(generatedCode);
    }
  }, [generatedCode, pauseAgentEdits, startAgentStream]);

  useEffect(() => {
    if (!pauseAgentEdits) {
      const queued = pendingCodeRef.current;
      if (queued && queued !== lastAppliedCodeRef.current) {
        startAgentStream(queued);
      }
    }
  }, [pauseAgentEdits, startAgentStream]);

  useEffect(() => {
    return () => {
      stopAgentStream();
      clearDecorations();
      bindingRef.current?.destroy();
      bindingRef.current = null;
      yDocRef.current?.destroy();
      yDocRef.current = null;
      yTextRef.current = null;
      editorRef.current = null;
      monacoRef.current = null;
    };
  }, [clearDecorations, stopAgentStream]);

  const showAgentBanner = useMemo(
    () => isAgentTyping || (isAgentBusy && !pauseAgentEdits),
    [isAgentBusy, isAgentTyping, pauseAgentEdits],
  );

  const showTakeControl = useMemo(
    () => isAgentBusy || isAgentTyping || Boolean(pendingCodeRef.current),
    [isAgentBusy, isAgentTyping],
  );

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950">
      <style>{`
        .agent-inline-highlight {
          background: rgba(168, 85, 247, 0.25);
          border-bottom: 1px solid rgba(216, 180, 254, 0.6);
        }

        .agent-cursor-indicator {
          color: rgb(216, 180, 254);
          font-weight: 700;
          margin-left: 1px;
          animation: agentCursorPulse 0.7s ease-in-out infinite alternate;
        }

        @keyframes agentCursorPulse {
          from { opacity: 0.45; }
          to { opacity: 1; }
        }
      `}</style>

      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-300">
            Collaborative Code Surface
          </span>
          {showAgentBanner && (
            <motion.span
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-200"
            >
              {pauseAgentEdits ? (
                <PauseCircle className="h-3.5 w-3.5" />
              ) : isAgentTyping ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Agent{" "}
              {pauseAgentEdits
                ? "Paused"
                : isAgentTyping
                  ? "Typing"
                  : "Working"}
            </motion.span>
          )}
        </div>

        {showTakeControl && (
          <button
            type="button"
            onClick={() => onPauseAgentEditsChange(!pauseAgentEdits)}
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition ${
              pauseAgentEdits
                ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                : "border-amber-400/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
            }`}
          >
            {pauseAgentEdits ? (
              <PlayCircle className="h-3.5 w-3.5" />
            ) : (
              <PauseCircle className="h-3.5 w-3.5" />
            )}
            {pauseAgentEdits ? "Resume Agent" : "Take Control"}
          </button>
        )}
      </div>

      <Editor
        height="100%"
        defaultLanguage={language}
        language={language}
        defaultValue=""
        onMount={handleEditorMount}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          smoothScrolling: true,
          automaticLayout: true,
          lineNumbersMinChars: 3,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          scrollBeyondLastLine: false,
          tabSize: 2,
          wordWrap: "on",
          glyphMargin: false,
          folding: true,
          padding: { top: 12, bottom: 12 },
        }}
        theme="vs-dark"
      />
    </div>
  );
};

export default CollaborativeCodeEditor;
