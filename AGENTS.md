# EdgeX POS Agent Context

Read this first, then inspect only the modules needed. Treat this as the compact source of truth; see `docs/PROJECT_AUDIT.md` for verified risks and product-quality priorities.

## Architecture

- Root is the shop-facing POS: React 18, Vite 5, Tailwind 4, React Router 6, Supabase, Dexie, and PWA support. Routes are in `src/App.jsx`; most shop pages follow `ProtectedRoute -> Layout -> Page`.
- Platform administration is currently embedded under `/admin` in the root app (`src/components/admin`, `src/pages/admin`). The separate `superadmin/` Vite app is retired (renders a "moved to /admin" notice; old modules are unbundled leftovers).
- `src/components/Layout.jsx` owns the full-screen shell and inner scrolling. Business features are mostly page-local under `src/pages/`; POS, Products, Inventory, Sales, Purchases, Customers, Dashboard, Settings, and ledgers are high-traffic.
- Business presets/pricing configuration live in `src/utils/businessPresets.js` (verify actual path before editing); global styling is Tailwind utilities and `src/index.css`. `src/App.css` is not part of the current styling path; do not import template CSS that constrains `#root`.

## Commands And Baseline

Root: `npm run dev`, `npm run build`, `npm run lint`, `npm run preview`.
Standalone admin: `cd superadmin`, then the same npm scripts.

- Root lint currently exits successfully with 0 errors and 113 warnings (hook dependencies, unused values, empty catches, and related cleanup).
- Latest root build compiled, but the command exited nonzero during PWA/temp dependency initialization with Windows `EPERM` resolving `C:\Users\...\AppData`; Vite also warned that the 500.86 kB shared JS chunk exceeds its 500 kB threshold. Recheck in the deployment/CI environment before treating this as a code build failure.
- Route chunks and action-time PDF/XLSX loading are already in use; do not assume the app is one monolithic entry bundle.

## Data, Auth, Offline

- Supabase/RLS header helpers: `src/services/supabase.js`; Dexie schema: `src/services/db.js`; queue runner: `src/services/syncService.js` (30-second interval and `online` event, started by app bootstrap).
- Login is in `src/pages/Login.jsx`, auth state in `src/context/AuthContext.jsx`. Current offline design persists identity/session material and password hashes in browser storage; this is a security-sensitive legacy constraint, not a secure authorization boundary.
- **Never put service-role credentials in browser/Vite `VITE_*` variables.** Privileged superadmin work goes through the `admin-api` Edge Function (`supabase/functions/admin-api`, client `src/services/adminApi.js`), which verifies a superadmin session token and allow-lists tables/actions; see `docs/ADMIN_EDGE_FUNCTIONS.md`. The old key leaked (bundle + git history) and must be rotated.
- `sessions` is server-written only (`secure_login`, Edge Functions); the browser may read only its own row. Superadmin sessions have `shop_id NULL`. Schema: `sql/superadmin_edge_functions_migration.sql`.
- Customer portal: customers log in with mobile + 6-digit PIN via the `portal-api` Edge Function (`supabase/functions/portal-api`, client `src/services/portalApi.js`, schema `sql/customer_portal_migration.sql`). Customers never get staff `sessions` or tenant RLS; portal tables are service-role only and the function scopes every query to `(shop_id, customer_id)` with allow-listed columns. See `docs/CUSTOMER_PORTAL.md`.
- Never store or display plaintext passwords (`users.raw_password` was dropped in `sql/security_followups_migration.sql`). `audit_logs` is session-scoped like other tenant tables; platform entries (shop_id NULL) are written only by `admin-api`.
- Enforce tenant isolation and roles in database RLS/RPC/server code, not only frontend filters or `ProtectedRoute`. Review SQL migrations together; order and duplicate policies materially affect security.
- Preserve shop-scoped localStorage key patterns (`shop_name_${shopId}`, `shop_logo_${shopId}`, `shop_settings_${shopId}`, plan and print settings). Avoid casual changes to sync queue, session, or offline-login behavior. Do not discard queued business writes silently; use idempotency and observable recovery.

## UI And Product Conventions

- Keep the app shell full-screen; let `Layout` own available height and pages scroll inside `<main>`. Prefer flex + `min-h-0`/`h-full`, and `dvh` when viewport sizing is unavoidable. Avoid page-local `100vh` subtraction.
- Modals should fit phones: `w-full max-w-*`, bounded `max-h-[90dvh]`, internal scroll, visible close affordance, and stacked actions. For data-heavy mobile workflows prefer compact card/list views over horizontal-only tables.
- POS is the primary repeated-action workflow: keep barcode/search, quantity, cart/totals, customer, tender, and completion reachable with touch and keyboard. Use semantic controls, explicit labels, visible focus, and generous tap targets; do not nest interactive controls.
- Keep changes scoped because business rules are often embedded in page components. Document genuinely new shared patterns here.
- Price tiers: products carry `cost_price`, `c_rate`, `sale_price` (retail) and optional `wholesale_price`. Resolve selling prices with `getUnitPrice(product, tier)` from `src/utils/businessPresets.js`; gate wholesale UI/data with `isWholesaleEnabled(getShopSettings(shopId))` (plan feature `wholesale` AND shop setting `wholesale_enabled`; `hasFeature` alone defaults to allowed). Only send `wholesale_price`/`price_tier` columns when enabled so un-migrated databases keep working. Schema: `sql/wholesale_mode_migration.sql`.
- Theme: colours are semantic tokens in `src/index.css` (`@theme inline`). Use `bg-surface`/`bg-surface-2..5`, `bg-app`, `text-fg`/`fg-2`/`fg-3`/`fg-muted`/`fg-subtle`/`fg-faint`, `border-line`/`line-subtle`/`line-strong`, and role colours `{primary|success|danger|warning|info|wholesale}` with variants `-soft`, `-muted`, `-line`, `-edge`, solid (no suffix), `-hover`, `-fg` (text), `-strong` (text on tints). Do not add raw Tailwind palette classes (`bg-blue-600`, `text-gray-500`) to migrated pages; `text-white` on solid fills and `bg-black/NN` scrims are fine. Wholesale UI uses `wholesale-*` (fixed amber); generic warnings use `warning-*`. Print/receipt HTML keeps literal colours. Theme mode/accent live in `shop_settings_${shopId}` (`theme_mode`, `theme_accent`) via `ThemeProvider`/`useTheme` in `src/context/ThemeContext.jsx`. Prefer the primitives (`btn btn-primary`, `input`, `card`, `badge badge-*`, `modal-backdrop`/`modal-panel`, or `src/components/ui`) when touching UI. Never write `*/` inside a CSS comment in `index.css` (it silently drops the theme block).
- Branding is white-label: never hard-code the product name, company, support phone or logo. Use `BRAND` from `src/config/brand.js` (values from `VITE_BRAND_*` env vars, EdgeX defaults). `vite.config.js` uses `resolveBrand()` for the PWA manifest and the `%BRAND_TITLE%`/`%BRAND_ICON%` placeholders in `index.html`; `api-server.js` uses it for email sender names.

## Operational Guardrails

- `api-server.js` exposes email dispatch; require authentication/authorization, strict validation, rate limits, and origin policy before production use.
- PWA caching must not retain authenticated/private API responses across logout or account switching.
- `.env` files are git-ignored (they were tracked with secrets before; rotate any key that was committed). `.env.example` lists every variable; real values live in local `.env` and Vercel project settings.
- `README.md` is still Vite-template content; do not rely on it for setup/deployment truth. Verify environment names from code/examples without printing secret values.
- For root changes run build/lint as feasible; run standalone admin checks when touching `superadmin/`. Report environment-limited failures distinctly from source failures.
