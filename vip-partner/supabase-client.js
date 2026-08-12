// ---------------------------------------------------------------
// Supabase client setup
// ---------------------------------------------------------------
// 1. Create a free project at https://supabase.com
// 2. Project Settings -> API -> copy your Project URL and anon/public key
// 3. Paste them below. The anon key is safe to expose in frontend code
//    as long as Row Level Security (RLS) policies are set on your tables
//    (see supabase-schema.sql for the policies that go with this page).
// ---------------------------------------------------------------

const SUPABASE_URL = "https://aezdluescnzwqvdpmdvx.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFlemRsdWVzY256d3F2ZHBtZHZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1MjAwODYsImV4cCI6MjEwMjA5NjA4Nn0.VIGsHR27MNh144a9FvsFX0s4JHzEIvHp5fW-hyLY5Uk";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
