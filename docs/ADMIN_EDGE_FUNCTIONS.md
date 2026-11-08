# Superadmin Edge Function (`admin-api`)

The Supabase **service-role key is no longer used in the browser**. Every privileged
superadmin operation in the POS app's `/admin` pages goes through one Edge Function,
`supabase/functions/admin-api`, which:

1. reads the caller's `x-session-token` (issued by the `secure_login` RPC),
2. checks it is an unexpired row in `sessions` with `shop_id IS NULL`, belonging to an
   active `users.role = 'superadmin'` account with no shop,
3. runs one allow-listed operation with the service role (which exists only as a
   server-side secret), and
4. writes the action to `audit_logs` (actor taken from the verified session).

Client side: `src/services/adminApi.js` (`adminDb.from(...)` for allow-listed table
reads/writes, `adminCall(action, params)` for dedicated actions).

| Action | Used by | Notes |
| --- | --- | --- |
| `db` | all admin pages | Table + verb allow-list in `TABLES`. `sessions` is never exposed. Tenant tables are read-only. `update`/`delete` require a filter. `users.password` is stripped from responses and `raw_password` is refused; superadmin rows cannot be created, promoted, edited or deleted here. |
| `rpc` | Analytics | Only `get_global_growth_stats`, `get_top_performing_shops`, `get_inactive_shops`. |
| `create_shop` | CreateShopModal | Shop + Supabase Auth owner + `users` row; rolls the shop back if the account fails. |
| `delete_shop` | ShopsList | Re-checks the typed shop name server-side, deletes shop data and sessions. |
| `impersonate` | ShopsList | Creates a 12h session for a shop user server-side and returns its token (handed off via `sessionStorage`, verified in `Login.jsx`). |
| `backup_shop` | ShopsList, Backups | Returns all backup sheets as JSON (paged past 1000 rows) and records `shop_backups`. |
| `log_action` | `auditService.logAction` | Semantic audit entries; actor comes from the session. |
| `logout` | AuthContext | Deletes the superadmin session row. |
| `reset_superadmin_password` | admin/ResetPassword | Authorized by the Supabase Auth **recovery** JWT (not a POS session); updates only the superadmin row for that email and signs out its sessions. |
| `whoami` | — | Session check helper. |

## Deploy (in this order)

1. **Run the SQL migration** `sql/superadmin_edge_functions_migration.sql` in the
   Supabase SQL Editor. It:
   - lets superadmin sessions have `shop_id = NULL` (tenant RLS never matches NULL, so a
     superadmin session sees no shop data through PostgREST),
   - **locks down `sessions`**: earlier scripts granted anon `ALL` plus an
     `USING (true)` policy, so anyone with the public anon key could list every session
     token or forge one. Now the browser can only read its own row,
   - blocks creating/promoting `role = 'superadmin'` through PostgREST,
   - replaces `secure_login` with one canonical version (session token + features +
     billing fields + superadmin support; superadmin sessions expire after 12h).
   Then run `sql/security_followups_migration.sql` (after deploying this app build):
   - `audit_logs` becomes session-scoped (shops see and write only their own rows;
     platform entries are service-role only). It previously had `USING (true)` read and
     `WITH CHECK (true)` insert policies,
   - drops `users.raw_password`, which stored every staff password in plaintext and
     was readable by any member of the same shop. Superadmins now set a new password in
     *Manage Users* and copy / WhatsApp it once; it is never stored readable.
2. **Deploy the function** (Supabase CLI, logged in and linked to the project):

   ```bash
   supabase functions deploy admin-api --no-verify-jwt
   ```

   `--no-verify-jwt` is required: callers authenticate with the POS session token
   (and the reset flow with a Supabase Auth JWT checked inside the function), and newer
   publishable anon keys are not JWTs.
3. **Secrets.** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected
   automatically into hosted Edge Functions — do not put them anywhere else. Optionally
   restrict CORS:

   ```bash
   supabase secrets set ADMIN_ALLOWED_ORIGINS="https://your-pos-domain.com,http://localhost:5173"
   ```

4. **Remove `VITE_SUPABASE_SERVICE_ROLE_KEY`** from every build environment (Vercel /
   CI env settings, `.env`, `superadmin/.env`). The app no longer reads it, but any
   `VITE_*` variable is still a public-bundle hazard.
5. Superadmins must **log out and sign in again** once: older superadmin logins never
   received a session token.

## Rotate the leaked key — required

The old service-role key shipped in public JS bundles **and is committed in git
history** (`.env`, `superadmin/.env`). Treat it as compromised:

1. Supabase Dashboard → Project Settings → API → roll the `service_role` secret (or, with
   the newer key system, create a new secret key and revoke the old one).
2. Redeploy `admin-api` (it picks up the new injected key automatically) and update any
   trusted server scripts that use it (e.g. `superadmin/migrate.mjs`, which reads it from
   the local environment only).
3. Delete the `VITE_SUPABASE_SERVICE_ROLE_KEY` line from `.env` and `superadmin/.env`,
   and consider untracking `.env` files (add them to `.gitignore`).
4. Review `audit_logs` / database logs for unexpected activity while the key was public.

## Legacy `superadmin/` app

Retired. Its entry point now only shows a "moved to /admin" notice and it creates no
privileged client (`superadmin/src/services/supabase.js` exports `supabaseAdmin = null`).
The old page modules remain on disk but are not imported or bundled; delete them when
convenient. If that app is still deployed separately, redeploy it so the old bundle
(with the key) is replaced.

## Local development

```bash
supabase functions serve admin-api --no-verify-jwt
```

Point `VITE_SUPABASE_URL` at the local stack, or deploy to a staging project. The client
calls `${VITE_SUPABASE_URL}/functions/v1/admin-api`.
