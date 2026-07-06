# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product context

Moodboard is a reference-organization tool for creative work — it collects not just visual references but also links and text notes onto a shared canvas.

Ships in two configurations from **one codebase, differing only by configuration — never by forked code**:
- **Personal** — the owner's own instance, for organizing references across the creative jobs they work on. Primary/active use.
- **Studio (Núcleo Zero)** — integrated into an existing studio system [A DEFINIR: qual sistema, e o que "integrado" significa na prática — SSO? banco compartilhado? embutido noutra interface?]. Implemented by someone else; the owner shares the code, not the deployment.

Consequence: anything environment-specific (Supabase URL/keys, domain, any deploy-specific value) lives in `.env`, never hardcoded (see **Constraints — do NOT**). Keep a committed `.env.example` listing every required variable (names only, no real values — the vars themselves are noted under Commands) so the studio deployment can be configured without the owner.

## Commands

```bash
npm install          # install deps
npm run dev           # vite dev server, --host --port 3000 (http://localhost:3000)
npm run build         # tsc-free production build (vite build), outputs to dist/
npm run preview       # serve the dist/ build locally
npx tsc --noEmit       # type-check (there is no separate lint script — tsconfig enables
                       # noUnusedLocals/noUnusedParameters, so this doubles as lint)
```

There is no test suite/framework in this project (no test script, no test runner dependency).

Requires a `.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — `src/supabase.ts` throws at import time if either is missing. Mirror these variable names (values omitted) in a committed `.env.example`.

## Git & deploy

- Commit at the end of every work block, not just at the end of the project.
- **`.gitignore` must exclude `.env`** — hard requirement, not a preference. The code is shared publicly via GitHub (`Ulysses-Ribas/moodboard`); committing `.env` would leak the live personal Supabase keys. (Verified clean: `.env` is gitignored and has never been committed, local or remote.)
- Keep `.env.example` in sync with `.env` whenever a variable is added (safe to commit).
- Deploy runs on **Vercel**, triggered by `git push origin master` (webhook → `vite build` → serves `dist/`). `vite build` transpiles **without type-checking**, so type errors do NOT block the deploy and ship silently to production. Non-blocking type-checking is intentional/deferred for now.

**Whenever the user asks to deploy, push, or run `git push origin master`:**
1. First run `npx tsc --noEmit` (see Commands) and report the result.
2. Warn explicitly that any type errors will still ship, since the Vercel build does not type-check.
3. Do **not** block or refuse the deploy — proceed once the user confirms.

Because `noUnusedLocals`/`noUnusedParameters` are on, `tsc --noEmit` also flags unused variables (some pre-existing and harmless) — do not treat those as deploy-blockers.

Limitation: this reminder only fires when the deploy goes through Claude; a direct terminal `git push` bypasses it. A pre-push git hook is the real fix — deferred by the user for now.

## Architecture

Vanilla TypeScript + Vite, no UI framework, no router, no bundler-level component system. DOM is built by hand (`document.createElement`, manual event listeners) in `main.ts` and `render.ts`. Screens (home list, board canvas, login, admin, public read-only view) are swapped by clearing/rebuilding the single `#app` element from `main.ts`.

**`src/main.ts` (~6800 lines) is the app.** It imports every other module and owns nearly all interaction logic: item CRUD, the contentEditable text/note editing toolbar, drag/resize/pan math, presentation mode + PNG/JPEG/SVG/PDF export, connections between items, comments, search, tag filters, alignment/distribute/layout tools, presence wiring, etc. There is no per-feature file split beyond what's listed below — when changing behavior, grep for the relevant function name in `main.ts` rather than expecting to find a dedicated module.

`src/render.ts` holds the DOM-building/rendering functions (`renderSidebar`, `renderToolbar`, `renderItem`, `renderAllItems`, `renderHome`, context menu, etc.) that `main.ts` calls after mutating state.

### Data model (`src/types.ts`)

- `Board` = `{ items: BoardItem[], connections: Connection[], viewport, ... }`.
- `BoardItem.type` is a union: `image | text | link | color | note | frame | board | draw | embed`.
  - `'board'` items embed a sub-board inline (the sub-board has `isSubBoard: true` and is hidden from the home list).
  - `'frame'` items define presentation slides (see `getPresentationFrames`/`startPresentation` in `main.ts`).
- Text/note item `content` is raw HTML from a contentEditable div. Each visual line is a browser-inserted `<div>` (only created after the first `Enter`); see `ensureFirstLineWrapped`/`getSelectedLineEls` in `main.ts` for the pattern used to apply per-line formatting (checklist, bullet list) across a multi-line selection.

### Dual persistence model

- `state.ts` — local-only `localStorage` fallback (`BoardState { boards[], activeBoardId }`), with a `migrate()` step for older schema versions. Used offline / pre-login.
- `boardStore.ts` — Supabase-backed persistence. Boards live in a `boards` table with a JSONB `data` column holding the rest of the `Board` object (`name` is a separate column). `saveBoardToSupabase` does UPDATE-then-INSERT-if-no-row-matched (preserves `owner_id`, safe for editors who can't set it). `debouncedSave` batches writes (2s). `subscribeToBoardChanges` wires Postgres realtime `UPDATE` events back in; `markLocalSave`/`ignoreBoardIds` suppress the echo of your own writes.

### Image storage — three tiers

1. Freshly picked file → `data:` URL.
2. `imageStore.ts` — IndexedDB, keyed as `idb://<uuid>`, keeps `localStorage` small.
3. `storageUpload.ts` — Supabase Storage public URL, uploaded lazily by `boardStore.expandIdbRefs` when a board is saved, so `idb://` refs (only valid on the local machine) never leak into what other users load. `compressToIdb`/`resyncIdbContent`/`migrateIdbToStorage` move content between tiers.

### Canvas / viewport

`canvas.ts` owns pan/zoom as a CSS transform on `#canvas-layer` and the `screenToBoard`/`boardToScreen` coordinate conversions. It exposes a `--inv-zoom` CSS var so zoom-independent UI (resize handles) can counter-scale.

Resize/scale math lives in the `resizing` state + its mousemove handler in `main.ts`. Multi-select resize anchors on the bounding box of the *whole selected group* (computed once at drag start), not just the dragged item's own opposite corner — important if touching that code, since per-item anchoring silently breaks group scaling.

### Realtime collaboration

Three independent Supabase Realtime channels, all wired together in `main.ts` (`setupPresence`, `setupCommentSync`, `setupBoardSync`):
- `presence.ts` — online users, remote cursor broadcast, "follow another user" mode.
- `comments.ts` — per-item comment threads with realtime subscription.
- `boardStore.ts` — board content sync (see above).

### Auth & views

`auth.ts` wraps Supabase email/password auth plus a `profiles` table row. `loginView.ts` and `adminView.ts` render full-screen views swapped into `#app`. `enterPublicView` (in `main.ts`) loads a board read-only via a share token, no auth/presence.

### History

Two unrelated undo mechanisms — don't conflate them:
- `history.ts` — in-memory undo/redo stack (`pushSnapshot`/`undo`/`redo`), cleared on reload.
- `versionHistory.ts` — persisted full-board JSON snapshots (`board_snapshots` table), for the user-facing "restore an earlier version" panel.

### Styling

`tokens.css` defines CSS custom properties for light theme on `:root` and dark theme under `[data-theme="dark"]`. `style.css` holds all component styles (no CSS modules/scoping). UI copy is in Portuguese; keep new UI strings consistent with that.

## Architecture direction

The app works and is in production. Do **not** undertake architectural rewrites. `main.ts`'s size (see the note at the top of Architecture) is accepted debt, not a task. If a file is ever split, do it incrementally and only while already touching that feature — one extraction, committed and type-checked separately — never as a standalone refactoring project.

## Constraints — do NOT

- Introduce a UI framework (React, Vue, Svelte…) — this app is intentionally vanilla TypeScript + hand-built DOM.
- Add npm dependencies without asking first.
- Refactor `main.ts` wholesale (see Architecture direction).
- Commit secrets (`.env`, Supabase keys, tokens).
- Hardcode environment-specific values — they belong in `.env`.
