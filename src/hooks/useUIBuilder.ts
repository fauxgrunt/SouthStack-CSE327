import { useEffect, useRef, useState } from "react";
import { cleanGeneratedCode } from "../pipeline/cleaning";
import { validateGeneratedCode } from "../pipeline/validation";
import { webContainerService } from "../services/webcontainer";

type LogType = "info" | "success" | "error" | "warning";

interface UIBuilderOptions {
  onLog?: (phase: string, message: string, type?: LogType) => void;
}

interface WebContainerProcess {
  kill: () => void;
  exit: Promise<number>;
}

const PREVIEW_SERVER_TIMEOUT_MS = 60000;
const PREVIEW_SERVER_RETRY_TIMEOUT_MS = 90000;

function normalizeReactCode(code: string): string {
  if (/export\s+default/.test(code)) {
    return code;
  }

  if (/function\s+App\s*\(/.test(code) || /const\s+App\s*=/.test(code)) {
    return `${code}\n\nexport default App;`;
  }

  return `export default function App() {\n  return (\n    <div style={{ padding: "1rem", fontFamily: "system-ui, sans-serif" }}>\n      <h1>Generated UI</h1>\n      <pre style={{ whiteSpace: "pre-wrap" }}>${JSON.stringify(code)}</pre>\n    </div>\n  );\n}`;
}

export function useUIBuilder(
  generatedCode: string | null,
  options?: UIBuilderOptions,
) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dependenciesInstalledRef = useRef(false);
  const devServerProcessRef = useRef<WebContainerProcess | null>(null);
  const devServerUrlRef = useRef<string | null>(null);
  const previewSupportedRef = useRef(true);
  const onLog = options?.onLog;

  const waitForPreviewServer = async (timeoutMs: number): Promise<string> => {
    try {
      return await webContainerService.waitForServerUrl(4173, timeoutMs);
    } catch (_e) {
      throw new Error(
        "Timed out waiting for preview server startup. Device may be slow; retrying once.",
      );
    }
  };

  useEffect(() => {
    return () => {
      if (devServerProcessRef.current) {
        devServerProcessRef.current.kill();
        devServerProcessRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!generatedCode || !generatedCode.trim()) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      if (!previewSupportedRef.current) {
        onLog?.(
          "execution",
          "Live preview is unavailable on this device/browser.",
          "warning",
        );
        setIsBuilding(false);
        return;
      }

      setIsBuilding(true);
      setError(null);
      onLog?.("execution", "[Executing] Bundling and launching UI...", "info");

      try {
        const cleanedCode = cleanGeneratedCode(generatedCode);
        const cleanedValidation = validateGeneratedCode(cleanedCode);
        const originalValidation = validateGeneratedCode(generatedCode);

        // Cleaning can occasionally over-fix valid JSX; preserve original if it validates.
        const codeForPreview =
          cleanedValidation.valid || !originalValidation.valid
            ? cleanedCode
            : generatedCode;

        const effectiveValidation = validateGeneratedCode(codeForPreview);

        if (!effectiveValidation.valid) {
          const message = `Preview rejected invalid code: ${effectiveValidation.errors.join("; ")}`;
          setError(message);
          onLog?.("execution", message, "error");
          setIsBuilding(false);
          return;
        }

        // Boot WebContainer only if not already ready. Handle single-instance boot errors gracefully.
        try {
          if (!webContainerService.isReady()) {
            // Add a short timeout for boot attempt - if it takes more than 15 seconds, fall back to code view
            const bootPromise = webContainerService.boot();
            const bootTimeoutPromise = new Promise((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "WebContainer boot timeout - switching to code-only view",
                    ),
                  ),
                15000,
              );
            });

            await Promise.race([bootPromise, bootTimeoutPromise]);
          }
        } catch (bootErr: any) {
          const msg = String(bootErr?.message || bootErr);

          // Check for various boot failure scenarios
          if (/Only a single WebContainer instance can be booted/i.test(msg)) {
            onLog?.(
              "execution",
              "WebContainer already booted in this browser context. Live preview will be unavailable in this tab.",
              "warning",
            );
            previewSupportedRef.current = false;
            setError(
              "Live preview unavailable: single WebContainer instance already active in this browser.",
            );
            setIsBuilding(false);
            return;
          }

          // For timeout or other boot failures, fall back to code-only display
          if (/timeout|Failed to boot|SharedArrayBuffer/i.test(msg)) {
            onLog?.(
              "execution",
              `Live preview unavailable (${msg}). Displaying generated code instead.`,
              "warning",
            );
            previewSupportedRef.current = false;

            // Still validate the code but just show it without running it
            if (!cancelled) {
              setPreviewUrl(null);
              setError(null);
              setIsBuilding(false);
              onLog?.(
                "execution",
                `✓ Code generated and validated (${codeForPreview.length} chars). Live preview unavailable - showing code only.`,
                "success",
              );
            }
            return;
          }

          // For other unexpected errors, rethrow
          throw bootErr;
        }

        await webContainerService.mkdir("/src");

        await webContainerService.writeFile(
          "/package.json",
          JSON.stringify(
            {
              name: "southstack-canvas-preview",
              private: true,
              version: "0.0.1",
              type: "module",
              scripts: {
                start: "vite --host 0.0.0.0 --port 4173",
                build: "vite build",
              },
              dependencies: {
                react: "^18.3.1",
                "react-dom": "^18.3.1",
              },
              devDependencies: {
                tailwindcss: "^3.4.4",
                postcss: "^8.4.38",
                autoprefixer: "^10.4.19",
                vite: "^5.3.1",
                "@vitejs/plugin-react": "^4.3.1",
              },
            },
            null,
            2,
          ),
        );

        await webContainerService.writeFile(
          "/vite.config.js",
          `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({\n  plugins: [react()],\n  server: {\n    host: "0.0.0.0",\n    port: 4173,\n  },\n});\n`,
        );

        await webContainerService.writeFile(
          "/tailwind.config.js",
          `/** @type {import('tailwindcss').Config} */\nexport default {\n  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],\n  theme: {\n    extend: {},\n  },\n  plugins: [],\n};\n`,
        );

        await webContainerService.writeFile(
          "/postcss.config.js",
          `export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`,
        );

        await webContainerService.writeFile(
          "/src/styles.css",
          `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nhtml, body, #root {\n  width: 100%;\n  height: 100%;\n  margin: 0;\n}\n\nbody {\n  font-family: Segoe UI, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;\n  background: #020617;\n}\n\n@keyframes fadeIn {\n  from {\n    opacity: 0;\n    transform: translateY(12px);\n  }\n\n  to {\n    opacity: 1;\n    transform: translateY(0);\n  }\n}\n\n@keyframes pulseSlow {\n  0%,\n  100% {\n    opacity: 1;\n  }\n\n  50% {\n    opacity: 0.5;\n  }\n}\n\n.animate-fadeIn {\n  animation: fadeIn 0.7s ease-out both;\n}\n\n.animate-pulse-slow {\n  animation: pulseSlow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;\n}\n\n.animation-delay-2000 {\n  animation-delay: 2s;\n}\n\n/* Prevent oversized SVGs/images from overflowing the preview */\nsvg, img {\n  max-width: 100%;\n  height: auto;\n  display: block;\n}\n\n/* Normalize basic form control appearance in the preview */\ninput, button, textarea, select {\n  font-family: inherit;\n  box-sizing: border-box;\n}\n`,
        );

        await webContainerService.writeFile(
          "/index.html",
          `<!DOCTYPE html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Preview</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
        );

        await webContainerService.writeFile(
          "/src/main.jsx",
          `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./index.jsx";\nimport "./styles.css";\n\nclass ErrorBoundary extends React.Component {\n  constructor(props) {\n    super(props);\n    this.state = { hasError: false, error: null };\n  }\n\n  static getDerivedStateFromError(error) {\n    return { hasError: true, error };\n  }\n\n  componentDidCatch(error, errorInfo) {\n    console.error("Error in generated preview:", error, errorInfo);\n  }\n\n  render() {\n    if (this.state.hasError) {\n      return (\n        <div style={{\n          padding: "24px",\n          fontFamily: "system-ui, sans-serif",\n          color: "#fff",\n          background: "#1a1a2e",\n          minHeight: "100vh",\n          display: "flex",\n          alignItems: "center",\n          justifyContent: "center"\n        }}>\n          <div style={{\n            maxWidth: "500px",\n            padding: "24px",\n            background: "#16213e",\n            borderRadius: "8px",\n            border: "1px solid #e94560"\n          }}>\n            <h1 style={{ margin: "0 0 16px 0", color: "#e94560" }}>Preview Error</h1>\n            <p style={{ margin: "0 0 12px 0", fontSize: "14px", color: "#ccc" }}>\n              The generated code encountered a runtime error:\n            </p>\n            <pre style={{\n              background: "#0f3460",\n              padding: "12px",\n              borderRadius: "4px",\n              overflow: "auto",\n              fontSize: "12px",\n              color: "#58ff3d",\n              margin: "0"\n            }}>\n              {this.state.error?.message || "Unknown error"}\n            </pre>\n            <p style={{\n              marginTop: "16px",\n              fontSize: "12px",\n              color: "#999"\n            }}>\n              Common issues:\n              <br/>• Using undefined components (e.g., &lt;Button /&gt; without defining it)\n              <br/>• Missing imports\n              <br/>• Syntax errors in JSX\n            </p>\n          </div>\n        </div>\n      );\n    }\n\n    return this.props.children;\n  }\n}\n\nReactDOM.createRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <ErrorBoundary>\n      <App />\n    </ErrorBoundary>\n  </React.StrictMode>,\n);\n`,
        );

        await webContainerService.writeFile(
          "/src/index.jsx",
          normalizeReactCode(codeForPreview),
        );

        if (!dependenciesInstalledRef.current) {
          onLog?.("execution", "Installing UI preview dependencies...", "info");
          const install = await webContainerService.exec("npm", ["install"]);
          if (install.exitCode !== 0) {
            throw new Error(
              "npm install failed while preparing preview runtime.",
            );
          }

          dependenciesInstalledRef.current = true;
        }

        if (devServerProcessRef.current && devServerUrlRef.current) {
          if (!cancelled) {
            setPreviewUrl(devServerUrlRef.current);
          }
          onLog?.(
            "execution",
            "Preview updated from generated source.",
            "success",
          );
          return;
        }

        const startPreviewServer = async (): Promise<string> => {
          const process = (await webContainerService.spawn("npm", [
            "start",
          ])) as WebContainerProcess;
          devServerProcessRef.current = process;

          process.exit.then(() => {
            devServerProcessRef.current = null;
            devServerUrlRef.current = null;
          });

          return waitForPreviewServer(PREVIEW_SERVER_TIMEOUT_MS);
        };

        let url: string;
        try {
          url = await startPreviewServer();
        } catch (startupError) {
          onLog?.(
            "execution",
            "Preview server startup is slow. Retrying once...",
            "warning",
          );

          if (devServerProcessRef.current) {
            devServerProcessRef.current.kill();
            devServerProcessRef.current = null;
          }

          const process = (await webContainerService.spawn("npm", [
            "start",
          ])) as WebContainerProcess;
          devServerProcessRef.current = process;

          process.exit.then(() => {
            devServerProcessRef.current = null;
            devServerUrlRef.current = null;
          });

          url = await waitForPreviewServer(PREVIEW_SERVER_RETRY_TIMEOUT_MS);
        }

        devServerUrlRef.current = url;

        if (!cancelled) {
          setPreviewUrl(url);
        }

        onLog?.("execution", "UI preview is live.", "success");
      } catch (runError) {
        const message =
          runError instanceof Error
            ? runError.message
            : "Failed to launch UI preview.";

        if (
          /SharedArrayBuffer|COOP|COEP|Failed to boot WebContainer/i.test(
            message,
          )
        ) {
          previewSupportedRef.current = false;
        }

        if (!cancelled) {
          setError(message);
        }
        onLog?.("execution", `[Executing] ${message}`, "error");
      } finally {
        if (!cancelled) {
          setIsBuilding(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [generatedCode, onLog]);

  return {
    previewUrl,
    isBuilding,
    error,
  };
}
