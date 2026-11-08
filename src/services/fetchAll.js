// ============================================================================
// fetchAllRows — read every row of a query, 1,000 at a time.
//
// Supabase/PostgREST returns at most 1,000 rows per request by default, so a
// plain `.select()` silently cut off products, customers and sales beyond that
// (POS could not find item #1,001, reports undercounted). Pass a function that
// builds a FRESH query each time; pages are requested with `.range()` and a
// stable `id` tie-break order so no row is skipped or repeated.
//
//   const { data, error } = await fetchAllRows(() =>
//     supabase.from('products').select('*').eq('shop_id', shopId).order('name'))
// ============================================================================
const PAGE_SIZE = 1000
const MAX_PAGES = 200 // safety stop: 200k rows

export async function fetchAllRows(buildQuery, { orderById = true } = {}) {
  const rows = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    let query = buildQuery()
    if (orderById) query = query.order('id', { ascending: true })
    const { data, error } = await query.range(from, from + PAGE_SIZE - 1)
    if (error) return { data: page === 0 ? null : rows, error }
    rows.push(...(data || []))
    if (!data || data.length < PAGE_SIZE) break
  }
  return { data: rows, error: null }
}
