// ---------------------------------------------------------------
// Supabase client setup
// ---------------------------------------------------------------
// 1. Create a free project at https://supabase.com
// 2. Project Settings -> API -> copy your Project URL and anon/public key
// 3. Paste them below. The anon key is safe to expose in frontend code
//    as long as Row Level Security (RLS) policies are set on your tables
//    (see supabase-schema.sql for the policies that go with this page).
// ---------------------------------------------------------------

const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
