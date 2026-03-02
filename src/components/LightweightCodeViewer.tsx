import { memo } from "react";

/**
 * LightweightCodeViewer - A plain text code viewer without syntax highlighting
 * Used on low-end devices to avoid the performance hit of SyntaxHighlighter
 */
interface LightweightCodeViewerProps {
  code: string;
  language?: string;
}

export const LightweightCodeViewer = memo<LightweightCodeViewerProps>(
  ({ code }) => {
    return (
      <pre className="bg-gray-950 text-gray-100 p-4 rounded-lg overflow-auto font-mono text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    );
  },
);

LightweightCodeViewer.displayName = "LightweightCodeViewer";
