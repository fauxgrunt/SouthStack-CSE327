import React from "react";
import ReactDOM from "react-dom/client";
import { AgenticIDE } from "./components/AgenticIDE";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

// Suppress non-critical runtime errors from extensions and service workers
const originalError = console.error;
const originalWarn = console.warn;

// Filter out noise from extensions and service workers
console.error = function (...args: any[]) {
  const message = args[0]?.toString?.() || String(args[0]);

  // Suppress non-critical errors
  if (
    message.includes("message port closed") ||
    message.includes("Browsing Topics API") ||
    message.includes("runtime.lastError")
  ) {
    return;
  }

  originalError.apply(console, args);
};

console.warn = function (...args: any[]) {
  const message = args[0]?.toString?.() || String(args[0]);

  // Suppress non-critical warnings
  if (
    message.includes("message port closed") ||
    message.includes("Browsing Topics API") ||
    message.includes("preloaded using link preload") ||
    message.includes("powerPreference")
  ) {
    return;
  }

  originalWarn.apply(console, args);
};

// Suppress unhandled promise rejections from extensions
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason?.message || String(event.reason);
  if (reason?.includes("message port closed")) {
    event.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AgenticIDE />
    </ErrorBoundary>
  </React.StrictMode>,
);
