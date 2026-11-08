# Copilot Instructions - Sanitary POS

Use the root [`AGENTS.md`](../AGENTS.md) file as the source of truth for this project. The previous Copilot instructions were stale and described an older architecture.

Quick reminders:

- Root app: React 18, Vite 5, Tailwind 4, React Router 6, Supabase, Dexie.
- `superadmin/` is a separate Vite app with its own dependencies and commands.
- Most app routes are `ProtectedRoute -> Layout -> page`.
- Preserve shop-scoped localStorage keys and offline sync behavior unless the task explicitly targets them.
- Do not re-import `src/App.css`; it contains stale Vite template styles.
- For mobile UI, avoid fixed viewport math and prefer responsive modals/card lists over wide tables on small screens.
