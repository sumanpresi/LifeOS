/* ============================================================
   LifeOS configuration — the only file you need to edit.
   Get both values from Supabase → Project Settings → API.
   Leave them blank to run LifeOS in local-only mode.
   ============================================================ */
export const SUPABASE_URL = "https://hgsqpvvneudwwfemdirc.supabase.co";
   export const SUPABASE_ANON_KEY = "sb_publishable_9t_tXW5K4t2oaljyFA_YUw_XpvO8vm-";

/* Google Calendar sync — get this from Google Cloud Console → APIs &
   Services → Credentials → your OAuth 2.0 Client ID. This value is
   public/safe to expose (it identifies the app, it doesn't authorize
   anything by itself) — the actual secret (GOOGLE_CLIENT_SECRET) is a
   Vercel environment variable used only by /api/google-oauth-callback.js
   and /api/google-calendar-sync.js, never shipped to the browser.
   Leave blank to leave Google Calendar sync disabled. */
export const GOOGLE_CLIENT_ID = "446350109199-j08bgqrp2d197n6adoaa8vb53mndc9q2.apps.googleusercontent.com";
