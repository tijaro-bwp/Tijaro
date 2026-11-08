import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve('c:/sanitary-pos/.env') });

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function main() {
    console.log('Fetching categories matching dura flow...');
    const { data: categories, error: fetchErr } = await supabase
        .from('categories')
        .select('*')
        .ilike('name', '%dura%');
    
    if (fetchErr) {
        console.error('Fetch error:', fetchErr);
        return;
    }

    console.log('Found categories:', categories);

    if (categories.length > 0) {
        const cat = categories[0];
        console.log(`Attempting to delete category: ${cat.name} (ID: ${cat.id})`);
        
        const { error: delErr } = await supabase
            .from('categories')
            .delete()
            .eq('id', cat.id);
            
        if (delErr) {
            console.error('DELETE ERROR:', JSON.stringify(delErr, null, 2));
        } else {
            console.log('Successfully deleted the category (wait, this means there was no DB error? Re-inserting...)');
            await supabase.from('categories').insert([cat]);
        }
    } else {
        console.log('No such category found. checking brands...');
        const { data: brands } = await supabase.from('brands').select('*').ilike('name', '%dura%');
        console.log('Found brands:', brands);
    }
}

main();
