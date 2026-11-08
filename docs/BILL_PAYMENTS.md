# Bill-wise payments, balance messages and bill links

Phase 1 of the delivery / loader strategy. A shop records a payment **against
specific bills**; every invoice and WhatsApp message shows
**previous balance + this bill − paid = new balance**; and each message can carry
a **no-login link** to the bill.

## Setup

1. Run `sql/bill_payments_migration.sql` in the Supabase SQL Editor (after
   `sql/security_hardening_migration.sql`). It is safe to run twice.
2. Re-deploy `supabase/functions/portal-api` (new actions `public_bill`,
   `staff_bill_link`; bills now include payments made against them). Keep
   "Verify JWT" off, as before.
3. Optional: Settings → WhatsApp → "Use recommended" for the bill and payment
   templates, then Save.

Until step 1 is done the app keeps working: the Receive Payment screen says the
database needs the update, POS drops `prev_balance`, links are left out of
messages.

## How it works

| Piece | Where |
|---|---|
| What a bill still owes | `(total_amount − discount) − paid_amount − Σ payments with sale_id = bill` (`customer_bills_due()`) |
| Record a payment | `record_bill_payment(customer, allocations, extra, mode, ref, note, paid_at, client_ref)` — one transaction: inserts `customer_payments` rows (linked by `sale_id`, grouped by `batch_ref`), lowers `customers.outstanding_balance`, returns per-bill results and previous/new balance. Rejects paying more than a bill owes; repeating the same `client_ref` saves nothing twice. SECURITY INVOKER, so tenant RLS applies. |
| Screen | Customer Ledger → **Receive Payment** (`src/components/ReceivePaymentModal.jsx`). Amount is spread over open bills oldest first; any bill can be edited or tapped to pay in full; the rest goes to old balance / advance. Online only — offline, use Add Transaction as before. |
| After saving | Receipt (print, or PDF on WhatsApp) and the payment message from `shops.wa_payment_template`. |
| Invoice | POS stores `sales.prev_balance` (balance before the bill). The receipt gets an ACCOUNT SUMMARY block on every template; reprints from other pages don't (no `account` data). |
| Bill link | `/b/<token>` → `PublicBill.jsx` → `portal-api public_bill`. 256-bit random token, only its SHA-256 stored in `bill_links` (service-role only), valid 90 days, shows first name, the bill, payments against it and the account balance. Created per message by `staff_bill_link` (staff session). `vercel.json` sends `no-referrer` + `noindex` for `/b/*`. |

`sales.paid_amount` keeps meaning "paid at the counter", so the ledgers (bills
add their unpaid part, payments subtract) and every existing balance stay
correct without migrating old data.

## Message placeholders

`[Name] [Shop Name] [ID] [Amount] [Portal Link]` plus
`[Bill Total] [Paid Now] [Bill Balance] [Previous Balance] [New Balance] [Bill Link]`,
and `[Bills]` (one line per bill) in the payment template. In a multi-line
template, a line whose value is missing (no link offline, walk-in customer) is
left out (`fillTemplate` in `src/utils/billMessages.js`).

## Limits / next phases

- Payments against bills need internet (the general "Add Transaction" still works offline).
- Goods returned are not tied to a bill yet; they lower the account balance only.
- Phase 2: loaders, dispatch sheet, loader settlement screen with a message queue.
