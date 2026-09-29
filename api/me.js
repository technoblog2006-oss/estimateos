// GET /api/me
// Header: Authorization: Bearer <supabase access token>
// Returns { credits, email }

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "missing_auth" });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return res.status(401).json({ error: "invalid_auth" });
  }

  const { data: profile, error: profErr } = await supabase
    .from("profiles")
    .select("credits, email")
    .eq("id", userData.user.id)
    .single();

  if (profErr || !profile) return res.status(500).json({ error: "profile_lookup_failed" });

  return res.status(200).json({ credits: profile.credits, email: profile.email });
};
