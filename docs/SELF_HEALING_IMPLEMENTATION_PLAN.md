# Self-Healing Implementation Plan — SouthStack

> Purpose: Concrete phased implementation plan to add robust self-healing across the image→code pipeline. This document is architecture-level only and contains no executable code. Designed for Edge VRAM constrained environments and compatible with an upcoming Code Freeze.

---

## Overview and Constraints

- Primary goal: Automatically detect, repair, validate, and recover from common failures in the UI image→code pipeline while keeping user experience stable.
- Constraints for this rollout:
  - Edge devices have strict VRAM limits. Avoid heavy local model retraining or large extra model calls during interactive flows.
  - We are entering a Code Freeze; only documentation and planning work will be performed now. Implementation will be phased with lowest-risk items first.
  - Safety-first: repairs must be validated before auto-applying in production paths.

---

## Phased Implementation Plan (Concrete Tasks & Estimates)

Notes on estimates: effort is given in "engineer-days" (1 engineer-day = one full developer day). Estimates assume 1-2 engineers working part-time or full-time as described. Adjust by team size.

### Phase 0 — Preparation & Telemetry (0.5–1 week)

Purpose: Build observability and artifact capture so later fixes are data-driven rather than speculative.

Tasks:

- T0.1 Catalog failure modes and define error taxonomy (parse, runtime, resource, hallucination, timeout) — 0.5 day
- T0.2 Implement structured logging schema (phase, severity, classification, model config, prompt, sanitized preview) — 1 day
- T0.3 Capture artifacts: prompt, raw model output, sanitized output, execution logs — persist to localStorage (dev) and optional server sink (prod) — 1 day
- T0.4 Create internal README explaining where artifacts live and how to retrieve them — 0.5 day

Acceptance criteria:

- Failure artifacts consistently captured in dev environment for all failing executions.
- Logging fields documented and searchable in local debugging workflow.

Why first: Without artifacts, repairs will be brittle. This phase is low-risk and VRAM-neutral.

---

### Phase A — Quick Wins: Sanitizers, Retries, Fallbacks (1–2 weeks)

Purpose: Prevent the most common, high-frequency failures with lightweight fixes and immediate UX gains.

Tasks:

- A1. Consolidate lightweight sanitizers (export typos, quote balancing, remove stray slashes) and `autoCloseJsx()` — 1 day
- A2. Add sanitization-preview + auto-correct of trivial typos before execution (warn user in logs) — 0.5 day
- A3. Implement 1x auto-retry with `aggressiveSanitize()` on parse errors; log both attempts — 1 day
- A4. Add safe fallback templates: if generation totally fails, return a minimal safe React scaffold (no external calls) — 0.5 day
- A5. Instrument metric counters for retries, auto-fix success rate, and fallback triggers — 1 day

Acceptance criteria:

- Parse-syntax errors reduce by >40% in dev harness for captured failing payloads.
- All retries and auto-fixes are logged and reversible.

Why: Low implementation cost, immediate user-experience improvement, no extra model calls, VRAM-friendly.

---

### Phase B — Static Validation and Sandboxed Tests (2–4 weeks)

Purpose: Ensure fixes are validated automatically via static checks and sandboxed runtime smoke tests before being applied to the live preview.

Tasks:

- B1. Add static validation step: Prettier + ESLint + TypeScript `--noEmit` checks on sanitized or generated code (run in browser or server) — 2 days
- B2. Build a lightweight sandbox runner using current WebContainer harness to run a smoke mount test (mount the React component with jsdom or in WebContainer) — 3 days
- B3. Integrate static + runtime validation into the execution pipeline; fail-safe to fallback template if tests fail — 2 days
- B4. Create CI job or local dev script to run this validation against saved failing artifacts (repro harness) — 2 days
- B5. Provide developer UI / console log level to show validation results and diffs of sanitized vs original code — 1 day

Acceptance criteria:

- Any code reaching live preview passes lint/type checks and a minimal smoke-mount test.
- Validation runs in <10s (preferably background/async) for interactive flows.

Notes on VRAM: These checks are CPU-bound and do not require additional model loads. They can run locally and are compatible with Edge constraints.

---

### Phase C — Structured Repairs (AST-based) & Human-in-the-loop (3–6 weeks)

Purpose: Move beyond regex heuristics to AST-aware repairs and introduce gated human review for mid-risk fixes.

Tasks:

- C1. Adopt an AST engine (Babel/@babel/parser or TypeScript compiler API) to detect structural issues and apply safe transforms (e.g., recover missing parentheses, close tags, fix common JSX attribute problems) — 3 days
- C2. Implement reversible AST transforms with a preview diff and confidence score — 3 days
- C3. Add human-in-the-loop UI for Tier-2 repairs: show diff, allow accept/reject, optionally auto-apply for trusted users — 3 days
- C4. Add policy engine for gating auto-apply: per-user, per-environment, or per-confidence thresholds — 2 days
- C5. Run a 2-week canary where Tier-2 auto-apply is enabled for a small % of users — 5 days (plus monitoring)

Acceptance criteria:

- AST repairs reduce remaining failures by a detectable margin during canary.
- No security-sensitive transformations are auto-applied without human approval.

Trade-offs: AST transforms require more code and careful testing but avoid brittle regex changes.

---

### Phase D — LLM-Assisted Repair Loop (4–8 weeks)

Purpose: Use a small, constrained LLM (or remote cloud LLM) to propose semantic repairs (fix syntax, preserve content). Run only when cheaper heuristic repairs fail.

Tasks:

- D1. Create a specialized repair prompt/flow that instructs the model to "ONLY fix syntax and keep text exact" and return diff or JSON suggestions — 3 days
- D2. Implement a remote LLM call (or local tiny model if available) to produce candidate repairs; limit tokens and calls to remain VRAM/cost efficient — 3 days
- D3. Validate LLM suggestions with static checks and sandbox tests; require human approval for non-trivial changes — 4 days
- D4. Add rate-limiting, caching, and replay logs to avoid repeated cost/latency hits — 2 days
- D5. A/B test LLM-driven repairs vs AST repairs to determine quality and false-positive rates — 5 days

Acceptance criteria:

- LLM repairs pass static/runtimes checks ≥90% of the time during a monitored trial.
- Cost and latency per repair are within acceptable SLA (configurable).

VRAM/Cost note: LLM-assisted repairs may call remote models — design so interactive preview falls back to local sanitizers and only non-interactive background tasks use LLM repairs when necessary.

---

### Phase E — Advanced: Visual Regression & Automated Rollforward/Rollback (4–8 weeks)

Purpose: Ensure visual fidelity and safe rollforward/rollback when auto-repair is applied.

Tasks:

- E1. Implement snapshot/visual regression harness (headless browser + pixel or DOM comparison) for generated UI — 5 days
- E2. Create a release/rollback ledger for generated artifacts (store 1–3 previous working snapshots) — 2 days
- E3. Implement automated rollforward: if repair creates a regression (test fails), automatically rollback and mark payload for human review — 3 days
- E4. Build dashboards and SLO monitoring for visual drift and repair performance — 5 days

Acceptance criteria:

- Visual checks detect major regressions and trigger rollback automatically during canary.

Notes: Visual regression testing is resource-heavy; run it in CI or worker nodes, not on low-VRAM devices directly.

---

## Governance, Safety, and Rollout Strategy

- Default policy: auto-apply only Tier 0–1 fixes (sanitizers + minor autocorrections). All Tier 2+ repairs should require human review in production.
- Feature flags: Implement feature flags to toggle auto-apply vs review mode and to limit canary percentages.
- Explicit safe-listing: Do not auto-apply any repair that introduces network calls, eval, or file-system write operations. Block any suspicious code patterns automatically.
- Data retention & privacy: Rotate and purge captured artifacts regularly. Mask PII before persisting logs.

---

## Quick Implementation Roadmap (Calendar View)

Assuming 1–2 engineers and prioritizing low-risk work first, a conservative calendar:

- Week 0 (Code Freeze): Finalize this plan and instrument artifact capture (Phase 0) — documentation only.
- Weeks 1–2: Phase A (sanitizers, preview, 1x retry, telemetry). Deploy to dev and user teaching instances.
- Weeks 3–5: Phase B (static validation + sandbox tests + CI harness). Integrate with preview flow.
- Weeks 6–10: Phase C (AST-based repairs + human review + canary). Rollout to small fraction of users.
- Weeks 11–18: Phase D (LLM-assisted repairs) and Phase E (visual regression) in parallel with strong monitoring.

Adjust cadence if team size grows or higher-priority issues appear.

---

## Metrics to Track (KPIs)

- Failure rate (per 1k generation requests)
- Auto-fix invocation rate and success rate
- Retry success rate (successful after 1 automatic retry)
- Manual intervention rate (how often human approval required)
- Time-to-resolve (TTR) for a failed generation
- Regression detection / rollback count

---

## Minimum Viable Self-Heal (MVS) Recommendation — what to ship first

To maximize safety and impact under VRAM and code-freeze constraints, ship the following as the MVS:

1. Phase 0 artifact capture and structured logging
2. Phase A sanitizers + preview + 1x aggressive retry
3. Phase B static validation (TypeScript + Prettier) before execution
4. Save failure artifacts for rapid iteration and manual fixes

This MVS gives immediate reliability gains without adding model load or heavy background compute.

---

## Risk, Trade-offs and Mitigations

- Risk: Over-aggressive fixes silently change author intent.
  - Mitigation: require human approval for Tier 2+; keep a visible diff and preserve the original payload.
- Risk: Increased latency on interactive flows.
  - Mitigation: keep sanitizers and quick checks inline; run heavier repairs in background and show a best-effort preview.
- Risk: Cost from extra LLM calls.
  - Mitigation: use local deterministic fixes first; limit LLM repairs to low-frequency, higher-value cases.

---

## Appendix: Suggested Tools & Libraries

- Static analysis: TypeScript `--noEmit`, ESLint, Prettier
- AST transforms: Babel (`@babel/parser`, `@babel/traverse`, `recast`) or TypeScript Compiler API
- Runtime sandboxing: WebContainer (existing), or Docker-based CI runners
- Visual regression: Playwright + pixelmatch or Percy (for paid services)
- Observability: Sentry (error capture), Prometheus/Grafana for metrics

---

## Ownership & Roles

- Engineering Lead: architecture review, sign-off on auto-apply policies
- Reliability Engineer: telemetry, CI integration, rollback automation
- Frontend Developer: AST transform rules, smoke tests, developer UI
- Product Owner/Professor Liaison: acceptance criteria and rollout policy

---

## Final Notes

This plan is intentionally conservative to meet the constraints you described (Edge VRAM limits and an imminent Code Freeze). The recommended MVS gives the largest reliability improvement with the lowest implementation risk and should be safe to land shortly after the freeze is lifted.

If you want, I can now generate a Gantt-style task breakdown with sprint-level checkpoints and a minimal PR checklist for each task (still as documentation only).

---
