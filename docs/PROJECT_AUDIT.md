# EdgeX POS: Engineering And Product Audit

Audit date: 2026-09-30  
Scope: static review of the current workspace, parallel security/mobile reviews, and root lint/build commands. Existing working-tree edits were preserved. Database policies and deployment secrets were not independently inspected in the live Supabase project; SQL findings below apply if the checked-in scripts are deployed.

## Verification Snapshot

- `npm run lint`: exits 0; 0 errors and 113 warnings. Warnings include missing React hook dependencies, unused variables, empty catches, and refresh-boundary warnings. Prioritize hook warnings that can cause stale or missed data refreshes; avoid suppressing the rules globally.
- `npm run build`: Vite transformed 4,045 modules and rendered production chunks, then the process exited 1 in a dependency attempting to resolve `C:\Users\...\AppData` (`EPERM`, `temp-dir`). This appears environment/Windows-profile related, but a clean CI/deploy build is still needed. Vite reported a 500.86 kB minified shared chunk over its 500 kB warning threshold; route splitting is already present.
- No live mobile-browser, accessibility, load, or database-policy validation was performed. Findings are static unless stated otherwise.

## Critical: Fix Before Production Exposure

### C1. Supabase service-role keys are wired into browser bundles

**Evidence:** `src/services/supabaseAdmin.js:3-7` reads `VITE_SUPABASE_SERVICE_ROLE_KEY` and creates an admin client; `superadmin/src/services/supabase.js:6-23` repeats the pattern. Vite `VITE_*` values are client-visible by design.

**Impact:** If configured in a production frontend build, a visitor can extract the key and bypass RLS, potentially reading or changing every tenant's data. Frontend route protection does not mitigate this.

**Action:** Remove service-role credentials from both client apps. Move privileged operations to authenticated server/Edge Functions with explicit authorization and audit logging. Check deployed bundles/configuration and rotate any key that has ever been exposed. Keep only the Supabase anon/publishable key in the browser, with restrictive RLS.

### C2. Checked-in SQL policies permit cross-tenant access

**Evidence:** `audit_logs_rls.sql:29-33` permits public inserts with `WITH CHECK (true)`; `:40-47` allows public reads for any non-null `shop_id`. `sql/add_brand_categories.sql:21-22` permits all operations with `USING (true) WITH CHECK (true)` and `:28-32` grants anon access. `sql/add_units.sql:14-16` does the same.

**Impact:** Anonymous clients can forge audit events and query other shops' rows by omitting/altering client filters. This undermines tenant confidentiality and audit integrity if these policies are active.

**Action:** Inventory actual deployed policies first. Replace permissive policies with authenticated/session-backed tenant predicates and role checks in the database; add negative cross-shop tests for SELECT/INSERT/UPDATE/DELETE before deployment. Do not treat UI filters as security controls.

## High Priority

### H1. Public email endpoint can become an unauthenticated relay

**Evidence:** `api-server.js:12` uses unrestricted `cors()`. `:23-55` accepts caller-provided recipient, subject, and HTML body and dispatches through the server's Resend key, with no authentication, authorization, recipient/domain policy, rate limit, or meaningful size/content validation.

**Impact:** If reachable in production, third parties can abuse the sending quota, damage sender reputation, and use the endpoint to deliver arbitrary HTML.

**Action:** Require a verified user/session and server-side permission; constrain allowed templates/recipients, validate size and content, rate-limit by actor/IP, configure explicit origins, and avoid returning provider internals. Disable the route if not used in deployed architecture.

### H2. PWA may retain private Supabase responses between users

**Evidence:** `vite.config.js:44` configures service-worker caching for Supabase REST/auth endpoints (review the exact strategy and cache key).

**Impact:** Cached API/auth data can remain on a shared POS device after logout or account/shop switching. Client-side shop-scoped Dexie storage does not make shared REST cache safe.

**Action:** Exclude authenticated Supabase REST/auth traffic from generic runtime caching. Use network-only/no-store for private responses, and explicitly clear app-owned offline data on logout/account switch according to the supported offline workflow. Verify two-user behavior on one device.

### H3. Offline identity is editable and based on fast client-side hashes

**Evidence:** `src/pages/Login.jsx` stores `session_token` and `user_pw_hash` in `localStorage` and writes password-hash material to IndexedDB; `src/utils/authUtils.js:1` uses frontend SHA-256; auth state is restored from browser storage in `src/context/AuthContext.jsx`.

**Impact:** Same-origin script or a user with browser storage access can copy/alter identity and role material. A fast unsalted SHA-256 password hash is brute-forceable and is not a safe password verifier. Offline role data cannot authorize privileged online operations.

**Action:** Plan an auth/session redesign: server-side slow salted password hashing, short-lived revocable sessions, server-enforced roles, and explicit device/offline policy. If offline access is required, use a limited local PIN/device unlock with least privilege and conflict-safe reauthentication rather than treating cached identity as online authorization.

### H4. Offline queue can lose writes or replay business operations

**Evidence:** `src/services/syncService.js:140-158` deletes UPDATE/DELETE queue items when IDs are missing; `:164-170` deletes failures after five attempts or selected database errors, without a durable dead-letter/reconciliation UX. Interval and online-event triggers can overlap, and replay after a remote write/local cleanup failure can duplicate inserts unless operations are idempotent.

**Impact:** A cashier may believe a sale/purchase is recorded while it remains local, gets dropped after retries, or is duplicated on replay. This is a financial/inventory integrity issue.

**Action:** Preserve failed operations with status/error/attempt metadata; never silently delete financial writes. Add per-operation idempotency keys enforced by the server/database, serialize queue processing with a single-flight lock, classify retryable vs permanent errors, and provide a visible pending/failed sync reconciliation screen. Test disconnect/reconnect, duplicate events, partial success, and account switching.

### H5. POS checkout controls and held bills need accessible touch/keyboard behavior

**Evidence:** `src/pages/POS.jsx:976` nests an interactive quantity input inside a product button. `:1502` uses a clickable `div` for held bills and hides the resume button until hover; the max-height class is misspelled as `max-height-[400px]`. Payment/quick-cash controls near `:1158-1223` use very small text/padding for frequent touch actions.

**Impact:** Invalid interactive nesting makes keyboard/focus behavior unreliable; touch users may not see a resume affordance; checkout actions are hard to hit accurately on phones. POS accessibility failures also slow cashier throughput.

**Action:** Give each card separate semantic add/quantity controls; make held bills keyboard-operable with a permanently visible, labeled resume button and valid `max-h-*`; target at least 44px touch controls for critical actions, visible focus states, explicit labels, and screen-reader announcements for cart/checkout state.

### H6. Purchases still uses fixed `100vh` subtraction

**Evidence:** `src/pages/Purchases.jsx` uses `height: calc(100vh - 112px)` for the page and `h-[calc(100vh-80px)]` for the mobile cart.

**Impact:** Mobile browser chrome, layout banners, and safe areas can clip or double-scroll the purchase workflow.

**Action:** Inherit available height from the app shell with flex + `min-h-0` and internal scrolling; use `dvh` only where truly needed. Validate at narrow phone sizes and with the on-screen keyboard open.

## Medium Priority: Mobile, Reliability, Maintainability

### M1. Customer management hides key data/actions in a wide mobile table

**Evidence:** `src/pages/Customers.jsx:435` uses horizontal table scrolling. `src/pages/Products.jsx`, `Inventory.jsx`, and `Sales.jsx` retain table patterns alongside some existing mobile variants; inspect every breakpoint rather than assuming broad coverage.

**Impact:** Repeated mobile tasks require lateral scrolling and can separate identity, balances/status, and actions.

**Action:** Add a compact customer list/card under the desktop breakpoint, showing name/contact, balance, and primary action; audit all high-traffic tables for an actually usable mobile representation.

### M2. Header touch targets and form labels are inconsistent

**Evidence:** `src/components/Layout.jsx:324` hamburger is `w-8 h-8`; `:356` notification trigger is approximately 40px. POS search/barcode/customer/price/discount inputs near `src/pages/POS.jsx:935-1085` rely on placeholders or lack associated labels.

**Impact:** Small controls and placeholder-only labels reduce usability for touch, keyboard, and assistive-technology users.

**Action:** Make navigation/notification hit areas at least 44px with accessible names and `aria-expanded`; use associated labels/aria-labels, focus indicators, and logical tab order for POS inputs.

### M3. SQL setup has competing login/session definitions

**Evidence:** `create_secure_login.sql` defines a `secure_login` response without the `session_token` expected by `src/pages/Login.jsx`; `database_migration_audit_fixes.sql:28-...` defines another version that creates/returns a token.

**Impact:** Fresh installs and upgraded environments can have different login/RLS behavior based on migration order.

**Action:** Establish one ordered, versioned migration source; remove ambiguous manual setup alternatives, and add a fresh-database migration check plus contract test that validates the RPC response expected by the client.

### M4. Build has a large shared chunk and environment-dependent failure

**Evidence:** latest output includes `index-CpLDnbaW.js` at 500.86 kB minified; Vite emitted the >500 kB warning. Build rendering completed but command failed in `temp-dir` at Windows `AppData` resolution (`EPERM`). Heavy chunks include XLSX (424 kB), jsPDF (390 kB), and chart code (344 kB), many already split.

**Impact:** Startup and repeat navigation can be slow on low-end devices, and an environment-specific build failure weakens release confidence.

**Action:** Reproduce in CI/clean Windows environment and identify the failing plugin/temp path rather than hiding the error. Inspect the shared 500 kB chunk's module composition; defer rarely used admin/chart/report dependencies and confirm gzip/real-device startup budgets.

### M5. Lint passes but 113 warnings dilute signal

**Evidence:** `npm run lint` exits 0 with 113 warnings, including stale hook dependencies, unused code, and empty catch blocks across app and standalone admin.

**Impact:** Real stale closure/data-refresh defects and cleanup debt are harder to spot during review.

**Action:** Triage hook warnings by behavior/risk first, then unused values and empty catches. Reduce warning count incrementally and make CI fail on newly introduced warnings rather than mass-fixing unrelated code.

### M6. README is unrelated starter-template guidance

**Evidence:** `README.md:1-16` describes generic React/Vite setup rather than EdgeX POS.

**Impact:** New maintainers cannot reliably find environment setup, local Supabase requirements, migrations, deployment, or offline/PWA operational constraints.

**Action:** Replace with concise real setup, environment-variable names (never values), database/migration bootstrap, dev/build/lint commands, deployment/API topology, and support/backup notes.

## Product Roadmap: Professional Retail POS

Prioritize predictable sales and data integrity over visual polish alone:

1. **Cashier speed:** reliable barcode scanner focus, keyboard-first product search, quick quantity/discount controls with permission checks, suspend/resume carts, clear tender/change due, and one-handed mobile checkout.
2. **Trustworthy transactions:** atomic sale + line items + stock movement + payment/ledger updates; idempotent offline sync; visible pending/failed status; audit trails and reconciliation for returns/voids.
3. **Retail operations:** stock receiving/adjustments/transfers, low-stock and reorder workflows, customer credit/partial payment, supplier balances, returns/exchanges, tax/discount controls, and multi-register/outlet support where required.
4. **Hardware and resilience:** validate thermal printer/scanner flows on target devices, safe invoice reprint, backups with tested restore, offline mode indicators, and recovery from power/browser closure.
5. **Quality gates:** representative phone/tablet/desktop visual checks, keyboard and screen-reader checks, realistic cashier acceptance flows, tenant-isolation tests, and load tests for large catalogs/history.

## Recommended Order

1. Remove/rotate exposed service-role credentials and verify database RLS before production use.
2. Lock down email dispatch and private service-worker caching.
3. Make offline writes durable/idempotent and redesign local credential trust.
4. Fix POS semantics/touch controls and the Purchases viewport sizing; add mobile customer list.
5. Resolve the reproducible build environment failure, then reduce lint warnings and replace the starter README.
