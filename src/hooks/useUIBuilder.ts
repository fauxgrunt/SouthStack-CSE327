import { useEffect, useRef, useState } from "react";
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
    return new Promise<string>((resolve, reject) => {
      const container = webContainerService.getContainer();
      const timeout = window.setTimeout(() => {
        reject(
          new Error(
            "Timed out waiting for preview server startup. Device may be slow; retrying once.",
          ),
        );
      }, timeoutMs);

      container.on("server-ready", (port, url) => {
        if (port === 4173) {
          window.clearTimeout(timeout);
          resolve(url);
        }
      });
    });
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
        await webContainerService.boot();

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
          "/index.html",
          `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>SouthStack Canvas Preview</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
        );

        await webContainerService.writeFile(
          "/src/main.jsx",
          `import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./index.js";\n\nReactDOM.createRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
        );

        await webContainerService.writeFile(
          "/src/index.js",
          normalizeReactCode(generatedCode),
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
