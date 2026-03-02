import React, { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * Terminal Component
 *
 * A real terminal emulator using xterm.js that displays output from
 * WebContainer processes in real-time.
 */

interface TerminalProps {
  /** Optional: Stream from a WebContainer process to pipe to terminal */
  processStream?: ReadableStream<string> | null;
  /** Optional: Clear the terminal when this changes */
  clearTrigger?: number;
  /** Optional: Custom height */
  height?: string;
}

export const Terminal: React.FC<TerminalProps> = ({
  processStream,
  clearTrigger,
  height = "400px",
}) => {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Initialize xterm
  useEffect(() => {
    if (!terminalRef.current) return;

    // Create terminal instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Fira Code", "Courier New", monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#ffffff",
        cursor: "#ffffff",
        cursorAccent: "#000000",
        selectionBackground: "#4a4a4a",
        black: "#000000",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#d19a66",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#abb2bf",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#d19a66",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff",
      },
      allowTransparency: true,
      convertEol: true,
      scrollback: 10000,
    });

    // Create fit addon to auto-size terminal
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);

    // Open terminal in DOM
    xterm.open(terminalRef.current);

    // Fit to container
    fitAddon.fit();

    // Store refs
    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Welcome message
    xterm.writeln(
      "\x1b[1;32m================================================\x1b[0m",
    );
    xterm.writeln(
      "\x1b[1;32m   SouthStack Terminal - Ready                \x1b[0m",
    );
    xterm.writeln(
      "\x1b[1;32m================================================\x1b[0m",
    );
    xterm.writeln("");

    // Handle window resize
    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener("resize", handleResize);

    // Cleanup
    return () => {
      window.removeEventListener("resize", handleResize);
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Handle clear trigger
  useEffect(() => {
    if (clearTrigger && xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.writeln("\x1b[1;33m[Terminal Cleared]\x1b[0m");
      xtermRef.current.writeln("");
    }
  }, [clearTrigger]);

  // Handle process stream
  useEffect(() => {
    if (!processStream || !xtermRef.current) return;

    const xterm = xtermRef.current;
    let reader: ReadableStreamDefaultReader<string> | null = null;
    let isReading = false;

    const readStream = async () => {
      if (!processStream) return;

      isReading = true;
      reader = processStream.getReader();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            xterm.writeln("");
            xterm.writeln("\x1b[1;32m[Process Completed]\x1b[0m");
            break;
          }

          if (value) {
            // Write output to terminal
            xterm.write(value);
          }
        }
      } catch (error: unknown) {
        if (
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name !== "AbortError"
        ) {
          xterm.writeln("");
          const message =
            "message" in error ? String(error.message) : "Unknown error";
          xterm.writeln(`\x1b[1;31m[Stream Error: ${message}]\x1b[0m`);
        }
      } finally {
        reader?.releaseLock();
        isReading = false;
      }
    };

    readStream();

    // Cleanup: cancel the stream reader
    return () => {
      if (reader && isReading) {
        reader.cancel();
        reader.releaseLock();
      }
    };
  }, [processStream]);

  return (
    <div className="terminal-container rounded-lg overflow-hidden border border-[#334155]">
      {/* Terminal Header Bar */}
      <div className="bg-slate-800/80 px-4 py-3 flex items-center justify-between border-b border-[#334155]">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500"></div>
          <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
        </div>
        <div
          className="text-sm text-gray-400 font-medium"
          style={{ fontFamily: "'Fira Code', monospace" }}
        >
          Terminal
        </div>
        <div className="w-20"></div>
      </div>

      {/* Terminal Content */}
      <div
        ref={terminalRef}
        style={{ height, padding: "10px" }}
        className="terminal-wrapper bg-black"
      />
    </div>
  );
};

/**
 * Helper: Write a log message to the terminal
 */
export const writeToTerminal = (
  xterm: XTerm,
  message: string,
  type: "info" | "success" | "error" | "warning" = "info",
) => {
  const colors = {
    info: "\x1b[1;36m", // Cyan
    success: "\x1b[1;32m", // Green
    error: "\x1b[1;31m", // Red
    warning: "\x1b[1;33m", // Yellow
  };

  const reset = "\x1b[0m";
  const color = colors[type];

  xterm.writeln(`${color}${message}${reset}`);
};

export default Terminal;
