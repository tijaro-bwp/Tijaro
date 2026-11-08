# POS Counter / Delivery modes (phase A)

The POS has two billing modes, switched at the top of the cart (or **F7**);
the choice is remembered per device (`pos_mode_<shopId>` in localStorage).

| | 🧾 Counter | 🚚 Delivery |
|---|---|---|
| Who | Customer at the counter | Shop customer; goods go with a loader |
| Customer | Optional (walk-in name). Required only if something is left unpaid — the POS points at the customer box instead of an alert | Required before billing |
| Payment default | Cash, full amount | Credit, Rs 0 now (advance allowed) |
| Saved as | `channel = 'counter'` (column default) | `channel = 'delivery'`, `delivery_status = 'out'`, address (prefilled from the customer), loader name, note, `dispatched_at` |
| After saving | Auto-prints when Settings → Print mode is **Auto** | Dialog: 🖨️ Bill (customer copy with account summary), 🚚 Slip (delivery slip: items, amount to collect, blanks for cash collected and signatures), 💬 WhatsApp "your order is on the way" |

A delivery bill counts against the customer's balance as soon as it is made
(the goods have left the shop). When the loader is back, record the money with
**Receive Payment** (Customer Ledger or the Deliveries page) and **Mark
delivered**.

## Deliveries page (`/deliveries`)

Tabs Out for delivery / Delivered (30 days) / All (30 days); filter by loader;
search by customer, phone, bill number or address. Shows what each bill still
has to collect (net − paid at sale − payments against the bill) and the total
still out. Actions: Receive payment, Mark delivered, print Slip, open Ledger.
Online only.

## Per-shop bill numbers

`sql/pos_modes_migration.sql` adds a `BEFORE INSERT` trigger on `sales` that
gives every new non-quotation bill the shop's next number in
`sales.invoice_number` (`INV-0001`, or `<invoice_prefix>-0001`; the prefix is
cleaned to letters and digits) and `sales.invoice_no`, from
`shop_invoice_counters` (service-role only). The database assigns it, so two
tills or a device syncing offline bills later never collide. Old bills keep
showing the last 8 digits of their id; a bill saved offline shows that too
until it syncs. Show numbers with `saleBillNo(sale)` from
`src/utils/billMessages.js`.

`customer_bills_due()` / `record_bill_payment()` return and store this number
(`bill_no`, `customer_payments.bill_number`); both migrations define the same
versions, but run `sql/bill_payments_migration.sql` before this one.

## Setup

1. SQL Editor: run `sql/pos_modes_migration.sql` (after `sql/bill_payments_migration.sql`).
2. Re-deploy `supabase/functions/portal-api` (bill numbers in the portal and bill links).

Without step 1 the POS keeps working: delivery fields are dropped on save
(older database), bills keep id-based numbers, and the Deliveries page asks for
the update.

## Not yet (phase B / C)

Loaders list and trips, dispatch sheet per trip, loader settlement screen with
a WhatsApp queue, items returned at delivery, credit limits.
