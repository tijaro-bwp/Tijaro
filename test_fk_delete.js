import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://flzcohjqlatscgdkkwmw.supabase.co'
const supabaseKey = 'sb_publishable_klPv8zgjHGaXWZp_6LZhig_6U-roC-a'

const supabase = createClient(supabaseUrl, supabaseKey)

async function testFKDelete() {
    // Let's get a product that has a sale item or purchase item
    const { data: pItems } = await supabase.from('purchase_items').select('product_id').limit(1)
    if (pItems && pItems.length > 0) {
        const pid = pItems[0].product_id
        console.log('Attempting to delete product with purchase history:', pid)
        const { data, error, status } = await supabase.from('products').delete().eq('id', pid)
        console.log('Data:', data)
        console.log('Error:', error)
        console.log('Status:', status)
    } else {
        console.log('No purchase items found')
    }
}

testFKDelete()
