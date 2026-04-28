import React from "react";

export interface SimpleLayoutGeneratorProps {
  description: string;
  className?: string;
}

type LayoutModel = {
  title: string;
  description: string;
  hasSidebar: boolean;
  hasTable: boolean;
  cardCount: number;
};

function detectCardCount(description: string): number {
  const match = description.match(/(\d+)\s+cards?/i);
  if (match) {
    return Math.max(1, Math.min(6, Number(match[1])));
  }

  if (/3\s+cards?|three\s+cards?/i.test(description)) {
    return 3;
  }

  if (/4\s+cards?|four\s+cards?/i.test(description)) {
    return 4;
  }

  if (/2\s+cards?|two\s+cards?/i.test(description)) {
    return 2;
  }

  return /dashboard|cards|metrics|tiles|stats/i.test(description) ? 3 : 1;
}

function buildLayoutModel(description: string): LayoutModel {
  const normalized = description.trim();
  return {
    title: normalized || "Simple Layout",
    description: normalized,
    hasSidebar: /sidebar|left nav|navigation rail|drawer/i.test(normalized),
    hasTable: /table|grid|list|records|rows/i.test(normalized),
    cardCount: detectCardCount(normalized),
  };
}

function escapeJsString(value: string): string {
  return JSON.stringify(value);
}

function buildCardMarkup(cardCount: number): string {
  return Array.from({ length: cardCount }, (_, index) => {
    const label = index + 1;
    return [
      `          <div className="rounded-2xl border border-white/10 bg-slate-900/80 p-5 shadow-lg shadow-cyan-950/20">`,
      `            <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300">Card ${label}</p>`,
      `            <h3 className="mt-3 text-lg font-semibold text-white">Summary ${label}</h3>`,
      `            <p className="mt-2 text-sm leading-6 text-slate-300">Simple, valid, and predictable layout block.</p>`,
      `          </div>`,
    ].join("\n");
  }).join("\n");
}

export function buildSimpleLayoutComponentCode(description: string): string {
  const model = buildLayoutModel(description);
  const sidebarMarkup = model.hasSidebar
    ? [
        `        <aside className="rounded-3xl border border-white/10 bg-slate-900/80 p-5 shadow-lg shadow-slate-950/40">`,
        `          <p className="text-[11px] uppercase tracking-[0.35em] text-cyan-300">Sidebar</p>`,
        `          <nav className="mt-6 space-y-3 text-sm text-slate-300">`,
        `            <a href="#" className="block rounded-xl bg-white/5 px-3 py-2 text-white">Overview</a>`,
        `            <a href="#" className="block rounded-xl px-3 py-2 hover:bg-white/5">Reports</a>`,
        `            <a href="#" className="block rounded-xl px-3 py-2 hover:bg-white/5">Settings</a>`,
        `          </nav>`,
        `        </aside>`,
      ].join("\n")
    : "";

  const tableMarkup = model.hasTable
    ? [
        `        <section className="rounded-3xl border border-white/10 bg-slate-900/70 p-5 shadow-lg shadow-slate-950/30">`,
        `          <div className="flex items-center justify-between gap-4">`,
        `            <div>`,
        `              <p className="text-[11px] uppercase tracking-[0.35em] text-cyan-300">Primary Content</p>`,
        `              <h2 className="mt-2 text-2xl font-semibold text-white">Table View</h2>`,
        `            </div>`,
        `            <button className="rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100">Action</button>`,
        `          </div>`,
        `          <div className="mt-5 overflow-hidden rounded-2xl border border-white/10">`,
        `            <table className="w-full text-left text-sm text-slate-300">`,
        `              <thead className="bg-white/5 text-slate-200">`,
        `                <tr>`,
        `                  <th className="px-4 py-3 font-medium">Label</th>`,
        `                  <th className="px-4 py-3 font-medium">Status</th>`,
        `                  <th className="px-4 py-3 font-medium">Value</th>`,
        `                </tr>`,
        `              </thead>`,
        `              <tbody>`,
        `                <tr className="border-t border-white/10 bg-slate-950/40">`,
        `                  <td className="px-4 py-3">Row 1</td>`,
        `                  <td className="px-4 py-3 text-emerald-300">Active</td>`,
        `                  <td className="px-4 py-3">100</td>`,
        `                </tr>`,
        `                <tr className="border-t border-white/10 bg-slate-950/20">`,
        `                  <td className="px-4 py-3">Row 2</td>`,
        `                  <td className="px-4 py-3 text-amber-300">Pending</td>`,
        `                  <td className="px-4 py-3">64</td>`,
        `                </tr>`,
        `              </tbody>`,
        `            </table>`,
        `          </div>`,
        `        </section>`,
      ].join("\n")
    : "";

  const gridClassName =
    model.cardCount >= 3
      ? "grid grid-cols-1 gap-4 md:grid-cols-3"
      : "grid grid-cols-1 gap-4 md:grid-cols-2";

  return [
    `import React from "react";`,
    "",
    "export default function App() {",
    `  const description = ${escapeJsString(model.description)};`,
    "",
    "  return (",
    `    <main className="min-h-screen bg-slate-950 text-slate-100">`,
    `      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 p-6">`,
    `        <header className="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 to-slate-950 p-6 shadow-2xl shadow-cyan-950/20">`,
    `          <p className="text-[11px] uppercase tracking-[0.35em] text-cyan-300">Safe Mode Preview</p>`,
    `          <h1 className="mt-3 text-3xl font-semibold text-white">${model.title.replace(/</g, "&lt;")}</h1>`,
    `          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">Generated from structural text only. No local model code generation is used here.</p>`,
    `          <p className="mt-4 text-xs uppercase tracking-[0.25em] text-slate-500">{description}</p>`,
    `        </header>`,
    `        <section className="grid gap-6 ${model.hasSidebar ? "md:grid-cols-[260px_minmax(0,1fr)]" : "md:grid-cols-1"}">`,
    sidebarMarkup,
    `          <div className="space-y-6">`,
    `            <section className="${gridClassName}">`,
    buildCardMarkup(model.cardCount),
    `            </section>`,
    tableMarkup,
    `          </div>`,
    `        </section>`,
    `      </div>`,
    `    </main>`,
    "  );",
    "}",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const SimpleLayoutGenerator: React.FC<SimpleLayoutGeneratorProps> = ({
  description,
  className,
}) => {
  const model = buildLayoutModel(description);
  const gridColumns =
    model.cardCount >= 3 ? "md:grid-cols-3" : "md:grid-cols-2";

  return (
    <div className={className}>
      <div className="rounded-3xl border border-white/10 bg-slate-950 p-6 text-slate-100 shadow-xl shadow-slate-950/30">
        <div className="mb-6 rounded-2xl border border-white/10 bg-slate-900/80 p-5">
          <p className="text-[11px] uppercase tracking-[0.35em] text-cyan-300">
            Safe Mode Preview
          </p>
          <h2 className="mt-3 text-2xl font-semibold text-white">
            {model.title}
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Deterministic layout generated from the EdgeVision-V1 structure
            summary.
          </p>
        </div>

        <div
          className={`grid gap-5 ${model.hasSidebar ? "md:grid-cols-[240px_minmax(0,1fr)]" : ""}`}
        >
          {model.hasSidebar && (
            <aside className="rounded-2xl border border-white/10 bg-slate-900/80 p-4">
              <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300">
                Sidebar
              </p>
              <div className="mt-4 space-y-2 text-sm text-slate-300">
                <div className="rounded-xl bg-white/5 px-3 py-2 text-white">
                  Overview
                </div>
                <div className="rounded-xl px-3 py-2">Reports</div>
                <div className="rounded-xl px-3 py-2">Settings</div>
              </div>
            </aside>
          )}

          <div className="space-y-5">
            <div className={`grid gap-4 ${gridColumns}`}>
              {Array.from({ length: model.cardCount }).map((_, index) => (
                <div
                  key={index}
                  className="rounded-2xl border border-white/10 bg-slate-900/80 p-4"
                >
                  <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300">
                    Card {index + 1}
                  </p>
                  <p className="mt-3 text-lg font-semibold text-white">
                    Summary block {index + 1}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    Valid, simple, and stable React/Tailwind markup.
                  </p>
                </div>
              ))}
            </div>

            {model.hasTable && (
              <section className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/80">
                <div className="border-b border-white/10 px-4 py-3">
                  <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300">
                    Primary Content
                  </p>
                  <h3 className="mt-1 text-lg font-semibold text-white">
                    Table View
                  </h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-white/5 text-slate-200">
                      <tr>
                        <th className="px-4 py-3 font-medium">Label</th>
                        <th className="px-4 py-3 font-medium">Status</th>
                        <th className="px-4 py-3 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-white/10 bg-slate-950/40">
                        <td className="px-4 py-3">Row 1</td>
                        <td className="px-4 py-3 text-emerald-300">Active</td>
                        <td className="px-4 py-3">100</td>
                      </tr>
                      <tr className="border-t border-white/10 bg-slate-950/20">
                        <td className="px-4 py-3">Row 2</td>
                        <td className="px-4 py-3 text-amber-300">Pending</td>
                        <td className="px-4 py-3">64</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SimpleLayoutGenerator;
