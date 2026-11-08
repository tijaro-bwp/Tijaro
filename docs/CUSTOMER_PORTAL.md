# Customer Portal

Customers sign in on their shop's page with **mobile number + 6-digit PIN** and see
their bills, ledger statement and current balance. It is read-only.

| Piece | Where |
|---|---|
| Database | `sql/customer_portal_migration.sql` |
| Backend | `supabase/functions/portal-api/index.ts` (Edge Function) |
| Browser client | `src/services/portalApi.js` |
| Customer pages | Phase 3 — route `/c/:slug` (not built yet) |
| Staff controls | Phase 2 — customer ledger page (not built yet) |

## Setup

1. **Run the migration** in the Supabase SQL Editor: `sql/customer_portal_migration.sql`
   (after `superadmin_edge_functions_migration.sql` and `security_followups_migration.sql`).
   It is idempotent.
2. **Set secrets** (Supabase → Edge Functions → Secrets):
   - `PORTAL_PIN_PEPPER` — a long random string. Mixed into every PIN hash. **Never change it**
     after customers have PINs (all PINs would stop working).
   - `PORTAL_ALLOWED_ORIGINS` — e.g. `https://tijaro-psi.vercel.app,http://localhost:5173`.
3. **Deploy**: `supabase functions deploy portal-api --no-verify-jwt`
   (`--no-verify-jwt` because callers are identified by their own portal/staff tokens).
4. **Check duplicates** before giving out logins:
   `SELECT * FROM customer_portal_duplicate_phones WHERE shop_id = <id>;`
   The API refuses to enable a login while another customer in the shop has the same number.

## How a customer gets access

1. Staff open the customer and choose **Give portal login** (`staff_issue_pin`).
   The server creates a random 6-digit PIN, stores only its hash, and returns the PIN **once**.
2. Staff send it on WhatsApp (the usual manual `wa.me` message):
   link `https://<app>/c/<shop slug>`, the mobile number, and the PIN.
3. Bill messages may include the link and "log in with your mobile number" — **never the PIN**.
4. Forgotten PIN → staff choose **Reset PIN** (new PIN, all devices signed out).
   The shop can't see an existing PIN; it can only issue a new one.

Mobile numbers are matched in one canonical form, `92XXXXXXXXXX`
(`0301-2616367`, `+92 301 2616367` and `3012616367` are the same login).
Each shop has its own address (`shops.portal_slug`, backfilled as `<name>-<id>`), because one
person can be a customer of several shops.

## API

`POST {SUPABASE_URL}/functions/v1/portal-api` with `{ "action": ..., ... }`.
Responses are `{ data, error }`; errors carry `message`, `status` and sometimes `code`.

| Action | Auth | Params | Returns |
|---|---|---|---|
| `shop_info` | none | `shop` (slug) | name, phone, address, logo for the login page |
| `login` | none | `shop`, `phone`, `pin` | `token` (30 days), `must_change_pin`, customer + shop |
| `summary` | `x-portal-token` | — | balance, bill count, last bill/payment, 5 recent entries |
| `bills` | `x-portal-token` | `page`, `page_size` (≤50), `from`, `to` | paged bills: total, paid, due |
| `bill` | `x-portal-token` | `id` | one bill with items (name, qty, price, line total, returned) |
| `statement` | `x-portal-token` | `from`, `to` | opening/closing balance, debits/credits, entries with running balance |
| `change_pin` | `x-portal-token` | `current_pin`, `new_pin` | signs out other devices |
| `logout` | `x-portal-token` | — | ends this session |
| `staff_status` | `x-session-token` | `customer_id` | enabled?, login number, last login, lock state, shop slug |
| `staff_issue_pin` | `x-session-token` | `customer_id` | `pin` (shown once), login number, shop slug. 409 `duplicate_phone` lists clashing customers |
| `staff_disable` | `x-session-token` | `customer_id` | turns the login off, signs out devices |

Staff actions accept admin, manager and cashier sessions (and superadmin impersonation) of the
customer's own shop.

## Security

- **Separate from staff auth.** Customers never get a row in `sessions` or the shop-wide
  "Tenant Isolation" RLS. `portal-api` uses the service role and filters every query by the
  session's `(shop_id, customer_id)`.
- **Allow-listed output.** Never returns `cost_price`, `created_by`, payment `details`, or other
  customers' data. Quotations are excluded from bills and balances.
- **Secrets stay server-side.** PIN hashes (PBKDF2-SHA256, 100k iterations, per-PIN salt, pepper)
  and session token hashes (SHA-256) live in `customer_portal_accounts` / `customer_sessions`,
  which are RLS-locked with all grants revoked — shop staff can't read them either.
- **Brute force.** 5 wrong PINs lock the account for 15 minutes; also ≤20 failures per IP per
  15 min and ≤15 per shop+number per hour (`customer_portal_login_failures`). Unknown numbers
  take the same time as wrong PINs. Weak PINs (`123456`, `000000`, …) are refused on change.
- **Revocation.** Disabling a login, resetting or changing the PIN, a suspended shop, or
  `shops.portal_enabled = false` all end sessions.
- **Audit.** Logins, lockouts, PIN changes and staff actions go to `audit_logs`
  (`PORTAL_*` action types).
- **Caching.** The PWA service worker only caches `/rest/` Supabase calls; `/functions/v1/` is not
  cached, and responses send `Cache-Control: no-store`.

## Balance

The portal's balance is computed from transactions (bills minus amounts paid at sale, plus charges,
minus payments and returns; cash refunds don't change it). This is the same logic as the shop's
customer ledger page (`src/pages/CustomerLedger.jsx`) **except quotations are excluded**. The shop
page currently counts an unpaid quotation as owed, so the two can differ for customers with
quotations; `customers.outstanding_balance` can also drift (the ledger page's *Reconcile* fixes
that). Aligning the shop ledger with the portal is a follow-up.

## Not built yet

- Phase 2 — staff UI: Give portal login / Reset PIN / Turn off, WhatsApp message with the PIN,
  portal link in bill messages, shop on/off switch in Settings.
- Phase 3 — customer pages at `/c/:slug`: login, home, bills, bill detail + PDF, statement + PDF,
  change PIN. Must stay outside `ProtectedRoute`/`Layout` and be `noindex`.
- Plan gating (`customer_portal` feature flag).
