# Reference audit

The three local projects were inspected read-only (no files changed). None has a LICENSE file; they are the user's own work. Patterns were re-implemented, not copied.

| Project | Stack | Reused idea | Where | Not reused |
|---|---|---|---|---|
| Research_Agent (`research-harness`) | Python core, Tauri 2 shell with sidecar | Provider presets bound to canonical endpoints; env-key detection that rejects placeholders | `src-tauri/src/ai.rs` | Python sidecar architecture, PyInstaller packaging |
| NexUS | Node agent runtime, vanilla JS UI, Swift wrapper | Repeated-failure guard (two-attempt rule), project path policy (no escapes, no symlinks, protected names), SKILL-style skills, approval before writes | `packages/agents/src/run.ts`, `src-tauri/src/paths.rs`, `packages/agents/src/skills.ts` | Node runtime, MCP plumbing, memory system |
| StoryStudio_Blueprint | React/TS, Fastify, Node SQLite, zod | Strict zod contracts; Ollama JSON-schema output with capability checks; proposals shown as before/after diffs and applied only on acceptance; no automatic paid retries | `packages/*` schemas, `ai.rs`, `packages/agents/src/apply.ts` | Astryx design system, Fastify server, media pipeline |
