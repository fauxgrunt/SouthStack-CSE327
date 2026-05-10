import React, { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Save, Loader2 } from "lucide-react";

interface EditablePreviewProps {
  previewUrl: string | null;
  generatedCode: string;
  onCodeSave: (code: string) => Promise<void>;
  error?: string | null;
}

export const EditablePreview: React.FC<EditablePreviewProps> = ({
  previewUrl,
  generatedCode,
  onCodeSave,
  error = null,
}) => {
  const [activeTab, setActiveTab] = useState<"preview" | "code">("preview");
  const [editableCode, setEditableCode] = useState(generatedCode);
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    setEditableCode(generatedCode);
  }, [generatedCode]);

  // Inject drag-and-drop functionality into preview iframe
  const injectDragAndDrop = useCallback(() => {
    if (!iframeRef.current?.contentDocument) return;

    const script = document.createElement("script");
    script.textContent = `
      (function() {
        let draggedElement = null;
        let offsetX = 0;
        let offsetY = 0;

        // Make all elements draggable
        function makeElementsDraggable() {
          const elements = document.querySelectorAll('div, button, section, header, main, footer, span, p, h1, h2, h3, h4, h5, h6, ul, ol, li');
          
          elements.forEach(el => {
            el.style.cursor = 'grab';
            
            el.addEventListener('mousedown', (e) => {
              if (e.button !== 0) return;
              draggedElement = el;
              draggedElement.style.cursor = 'grabbing';
              draggedElement.style.position = 'relative';
              draggedElement.style.zIndex = '9999';
              
              offsetX = e.clientX - el.getBoundingClientRect().left;
              offsetY = e.clientY - el.getBoundingClientRect().top;
              
              e.preventDefault();
            });
          });
        }

        document.addEventListener('mousemove', (e) => {
          if (!draggedElement) return;
          draggedElement.style.left = (e.clientX - offsetX) + 'px';
          draggedElement.style.top = (e.clientY - offsetY) + 'px';
        });

        document.addEventListener('mouseup', () => {
          if (draggedElement) {
            draggedElement.style.cursor = 'grab';
            draggedElement = null;
          }
        });

        makeElementsDraggable();
        const observer = new MutationObserver(makeElementsDraggable);
        observer.observe(document.body, { childList: true, subtree: true });
      })();
    `;

    iframeRef.current.contentDocument.body.appendChild(script);
  }, []);

  useEffect(() => {
    if (previewUrl && iframeRef.current) {
      const timer = setTimeout(() => {
        injectDragAndDrop();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [previewUrl, injectDragAndDrop]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await onCodeSave(editableCode);
    } catch (err) {
      console.error("Failed to save code:", err);
    } finally {
      setIsSaving(false);
    }
  }, [editableCode, onCodeSave]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(editableCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [editableCode]);

  return (
    <div className="flex flex-col h-full rounded-3xl border border-white/10 bg-slate-950/80 shadow-xl shadow-slate-950/30 backdrop-blur-xl">
      {/* Tab Navigation */}
      <div className="flex items-center justify-between gap-4 border-b border-white/10 px-5 py-3">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("preview")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeTab === "preview"
                ? "bg-cyan-400 text-slate-950"
                : "bg-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            Preview (Drag-enabled)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("code")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeTab === "code"
                ? "bg-cyan-400 text-slate-950"
                : "bg-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            Edit Code
          </button>
        </div>

        <div className="flex gap-2">
          {activeTab === "code" && (
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || editableCode === generatedCode}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/20 border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </button>
          )}

          <button
            type="button"
            onClick={handleCopy}
            disabled={!editableCode}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="flex h-full items-center justify-center rounded-2xl border border-rose-500/30 bg-rose-950/20 m-4 px-6 text-center">
            <div>
              <p className="text-[11px] uppercase tracking-[0.35em] text-rose-300">
                Error
              </p>
              <p className="mt-3 text-sm text-rose-200">{error}</p>
            </div>
          </div>
        ) : activeTab === "preview" ? (
          previewUrl ? (
            <div className="p-4 h-full">
              <iframe
                ref={iframeRef}
                src={previewUrl}
                title="Generated preview (drag-enabled)"
                className="h-full w-full rounded-2xl border border-white/10 bg-slate-900"
              />
              <div className="mt-2 text-xs text-slate-400 px-2">
                💡 Drag any element to reposition it (changes are not persisted
                to code)
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/5 text-center text-slate-400 m-4">
              <p>No preview available. Generate a UI first.</p>
            </div>
          )
        ) : (
          <div className="p-4 h-full flex flex-col overflow-hidden">
            <textarea
              value={editableCode}
              onChange={(e) => setEditableCode(e.target.value)}
              placeholder="Edit code here..."
              className="flex-1 w-full rounded-xl border border-white/10 bg-slate-900 p-3 text-xs leading-5 text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-400/40 font-mono overflow-y-auto"
            />
            <div className="mt-2 text-xs text-slate-400">
              {editableCode.length} characters
              {editableCode !== generatedCode && (
                <span className="ml-2 text-amber-300">• Unsaved changes</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
