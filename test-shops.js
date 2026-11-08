
import { createClient } from "@supabase/supabase-js";
const supabaseAdmin = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY);
const supabaseAnon = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

async function check() {
  const { data: adminData } = await supabaseAdmin.from("shops").select("id, name, status");
  console.log("Admin Shops:", adminData);

  const { data: anonData, error: anonError } = await supabaseAnon.from("shops").select("id, name, status");
  console.log("Anon Shops:", anonData || anonError);
}
check();

