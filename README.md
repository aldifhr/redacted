# FarayAgent — Playwright QA Browser Agent

FarayAgent is a QA-focused AI chat application that controls a real Chromium browser through Playwright. It can explore websites, create QA test-plan documents, save structured test cases, run Playwright specs, collect screenshots, and explain grounded results in English.

## Features

- Real-time browser exploration with SSE progress: `Planning` → `Browsing` → `Testing` → `Reporting`
- Human-in-the-loop: `browser_bash` pauses for explicit Approve/Deny in the chat UI before running
- QA-only agent scope with browser, test, memory, and delegation tools
- Test plan documents with ten sections: objective, scope, strategy, deliverables, environment, roles, schedule, risks, and approval
- Structured `.cases.json` test cases with area summaries and quality-gate metadata
- Playwright spec save and run support
- Screenshot evidence, tool timeline, artifact preview, and quality-gate reporting
- Collapsible Agent activity summaries based on actual browser actions
- Persistent chat sessions, drafts, memory, provider settings, and model selection
- Skills marketplace at `/skills`, backed by the `skills.sh` ecosystem
- English UI and agent responses

## Stack

- Next.js 16 App Router, React 19, TypeScript, and Tailwind CSS
- Vercel AI SDK with OpenAI and Anthropic providers
- Playwright Chromium and `@playwright/test`
- Framer Motion and Lucide icons

## Getting Started

```bash
npm install
npx playwright install chromium
npm run dev
```

Open `http://localhost:3000`.

`dev` and `start` pass `-H 127.0.0.1`, so the server listens on loopback only and is never reachable from the LAN. Next's default is `0.0.0.0`, which would expose every `/api/*` route to the network. Dropping the flag is not safe today even with `APP_TOKEN` set: `/api/chat/stream` and `/api/docs/convert` skip `guardApi`, so they never reach the token check.

Configure the provider, API key, base URL, and model at `/settings`. Settings are stored in the browser's local storage. Browser-only Playwright checks do not require an LLM API key.

### Remote browser (optional)

Set `BROWSER_CDP_URL` to drive a shared Chromium instead of launching a local one:

```bash
# WebSocket endpoint (e.g. browserless, Bright Data) or http(s) CDP endpoint
BROWSER_CDP_URL="wss://example.com/playwright" npm run dev
```

If the variable is unset or the connection fails, the app falls back to local headless Chromium. Remote browsers are never killed — only the session context is closed.

Set `BRIGHTDATA_BROWSER_AUTH` (`zone username:password`) instead to use the Bright Data managed anti-bot browser without a CDP URL. Set `BROWSER_HEADLESS=false` to run the local browser headed for visual debugging.

## Routes

- `/` — landing page
- `/chat` — QA chat with multi-session history
- `/chat/{chatId}` — deep link to a specific chat
- `/tests` — saved Playwright specs, run results, cases, and history
- `/settings` — provider, model, API key, base URL, and Chromium check
- `/memory` — manage durable facts stored in `MEMORY.md`
- `/logs` — inspect tool calls, inputs, outputs, durations, and errors
- `/prompt` — inspect the composed system prompt per section
- `/skills` — search, install, and remove agent skills

## Chat Workflow

The chat supports:

- Multi-session history with automatic titles
- Draft persistence per session
- Text-file attachments and drag-and-drop for supported text formats
- Copy, edit, regenerate, retry, stop, and jump-to-latest controls
- Main-agent and sub-agent indicators
- Live activity summaries based on real tools and selectors
- Test plan and test-case artifact previews
- Screenshots with a lightbox viewer

For a QA test plan request, the agent explores only as much as needed, creates a Markdown test-plan document, runs a quality gate, and reports the saved artifact. Detailed test cases are stored separately as `.cases.json` when requested.

## Security posture (local-first)

FarayAgent is designed for a **single-user trusted local environment**, not public multi-user deployment:

- Browser navigation blocks loopback/private/link-local/cloud-metadata targets (pre- and post-redirect); custom LLM `baseUrl` values are validated the same way (loopback allowed for local gateways like Ollama).
- `browser_bash` runs without a shell (allowlisted commands only, no pipes/redirects) and pauses for explicit user approval; without an approval channel it is denied except for read-only commands (`ls`, `cat`, `grep`, …).
- Uploads (Excel/PDF/Word) are parsed **client-side only** — the server never touches binary uploads. Spreadsheet import (XLSX/CSV) uses `exceljs` plus a built-in CSV parser; legacy binary `.xls` is rejected with a prompt to re-save as `.xlsx`/`.csv`.
- Secrets are rejected from memory and redacted from tool logs; chat request bodies are Zod-validated with size caps.
- Each agent run gets an isolated `BrowserContext` (closed on run end); manual `/api/browser` use shares one page.
- `guardApi` applies a per-IP sliding-window rate limit to most `/api/*` routes. **`/api/chat/stream` and `/api/docs/convert` are exempt** — they skip `guardApi` entirely, which means they also never reach the `APP_TOKEN` check (`requireAuth` lives inside `guardApi`). Set `APP_TOKEN` to require bearer auth on the routes that do use `guardApi` (open by default for local use); the two exempt routes are unprotected either way, which is why the server binds loopback only.
- CI runs `tsc`, `lint`, unit tests (`tests/lib.spec.ts`), `npm audit`, and `npm run build` as the deterministic gate, plus a separate job for the full Playwright suite against live demo sites (`.github/workflows/ci.yml`).

## Skills

FarayAgent supports two skill sources:

### `.skills/`

Skills installed from the in-app `/skills` page. The page searches `skills.sh`, shows install counts and source links, and stores selected `SKILL.md` files locally.

### `.agents/skills/`

Skills installed with the `npx skills add` CLI for OpenCode and other agent ecosystems. Only audited, allowlisted skills are loaded by FarayAgent:

- `playwright-best-practices`
- `playwright-explore-website`
- `playwright-stealth-verify`
- `senior-qa-engineer`

Installed skills are treated as untrusted reference instructions. They cannot add tools, grant permissions, override the system prompt, or bypass QA and security rules. High-risk skills are not loaded automatically.

Example installation:

```bash
npx skills add https://github.com/currents-dev/playwright-best-practices-skill --skill playwright-best-practices --agent opencode --yes
```

Review every external skill and its security assessment before enabling it. A Vercel OIDC token is not required for local skills usage; the app falls back to a curated catalog and GitHub `SKILL.md` retrieval when the public `skills.sh` API returns `401`.

## Memory

`MEMORY.md` is loaded into the system prompt on every request. It is intended for durable preferences, public demo-site facts, important URLs, and robust locators. Passwords, API keys, tokens, and real secrets are rejected automatically.

## API

- `POST /api/chat/stream` — SSE chat stream with status, screenshot, artifact, approval, done, aborted, and error events
- `POST /api/chat/cancel` — cancel an active run
- `POST /api/chat/approve` — resolve a pending tool approval (`{ runId, id, approved }`)
- `POST /api/models` — load live models from a configured provider
- `GET|POST /api/browser` — manual browser control
- `GET|POST /api/memory` — list, save, and forget memory facts
- `GET|POST /api/logs` — read and clear tool logs
- `GET|POST /api/skills` — search, install, enable/disable, and remove skills
- `GET|POST /api/tests` — list, read, delete, and run Playwright specs

## Project Structure

```text
SOUL.md, MEMORY.md             Agent personality and durable memory
src/app/page.tsx               Landing page
src/app/chat/page.tsx          Chat route
src/app/chat/[chatId]/page.tsx   Deep link to a chat
src/app/tests/page.tsx         Spec list, run results, cases, history
src/app/settings/page.tsx      Provider and browser settings
src/app/memory/page.tsx        Memory management
src/app/logs/page.tsx          Tool-log viewer
src/app/skills/page.tsx        skills.sh skill manager
src/app/api/                   Chat, browser, memory, logs, skills, and test APIs
src/components/Chat.tsx        Chat UI, stream reader, artifacts, and activity
src/lib/agent.ts               AI tools and test-plan schemas
src/lib/providers.ts            Providers and the English QA system prompt
src/lib/skills.ts               skills.sh client and local skill loader
src/lib/specs.ts               Spec, test-case, artifact, and quality-gate storage
src/lib/soul.ts                 Prompt composition for soul, rules, memory, and skills
tests/                          Playwright specs and artifacts, grouped per site (tests/qabrains-ecommerce/, tests/saucedemo/)
```

## Verification

```bash
npm run typecheck
npm run lint
npm run test:unit   # tests/lib.spec.ts — no network, no browser
npm test            # full Playwright suite — hits live demo sites
npm run build
```

The build may report existing Turbopack warnings for dynamic filesystem access used by the browser sandbox and artifact routes.
