/* Exchanges a Google OAuth authorization code for tokens, then stores
   the refresh token in Supabase (google_calendar_tokens table, service-
   role access only — see supabase-setup.sql).

   This has to be a server-side function, not something the browser can
   do itself: the token exchange requires GOOGLE_CLIENT_SECRET, which
   must never be shipped to a browser. Everything before this step
   (redirecting to Google's consent screen) happens entirely client-
   side in js/google-calendar.js, since only the exchange step needs
   the secret.

   No npm dependencies — plain fetch calls to Google's token endpoint
   and Supabase's REST/Auth APIs, matching the rest of this project's
   no-build-step approach. Vercel runs any .js file under /api as a
   Node serverless function automatically; nothing else to configure.

   Required environment variables (Vercel → Project Settings →
   Environment Variables):
     GOOGLE_CLIENT_ID          (same value as js/config.js's GOOGLE_CLIENT_ID)
     GOOGLE_CLIENT_SECRET      (from Google Cloud Console — server-side only)
     SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API — server-side only)
*/

const SUPABASE_URL = "https://hgsqpvvneudwwfemdirc.supabase.co"; // same project as js/config.js — not secret, just the project's address

async function getSupabaseUser(accessToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, // service-role key also works as the apikey header here
    },
  });
  if (!res.ok) return null;
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const authHeader = req.headers.authorization || "";
  const supabaseToken = authHeader.replace(/^Bearer\s+/i, "");
  const { code, redirectUri } = req.body || {};
  if (!supabaseToken) return res.status(401).json({ error: "Missing LifeOS session token" });
  if (!code || !redirectUri) return res.status(400).json({ error: "Missing code or redirectUri" });

  const user = await getSupabaseUser(supabaseToken);
  if (!user || !user.id) return res.status(401).json({ error: "Invalid or expired LifeOS session" });

  // Exchange the authorization code for tokens.
  let tokenRes, tokenData;
  try {
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    tokenData = await tokenRes.json();
  } catch (e) {
    return res.status(502).json({ error: "Could not reach Google's token endpoint" });
  }
  if (!tokenRes.ok) {
    return res.status(400).json({ error: tokenData.error_description || tokenData.error || "Google rejected the authorization code" });
  }

  // Google only returns a refresh_token on the FIRST consent (or when
  // prompt=consent is forced — see google-calendar.js, which always
  // forces it, precisely so this branch reliably has one to store).
  if (!tokenData.refresh_token) {
    return res.status(200).json({ ok: true, note: "No new refresh token returned — a previously stored one (if any) is still in use." });
  }

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/google_calendar_tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ user_id: user.id, refresh_token: tokenData.refresh_token, updated_at: new Date().toISOString() }),
  });
  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    return res.status(500).json({ error: "Got a refresh token from Google but failed to store it: " + errText });
  }

  return res.status(200).json({ ok: true });
};
