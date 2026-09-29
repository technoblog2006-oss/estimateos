// POST /api/checkout
// Body: { pack: "starter" | "value" | "power" }
// Header: Authorization: Bearer <supabase access token>
// Returns { url } — redirect the browser to this Stripe-hosted checkout page.

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PACKS = {
  starter: { priceId: process.env.STRIPE_PRICE_STARTER, credits: 100 },
  value: { priceId: process.env.STRIPE_PRICE_VALUE, credits: 300 },
  power: { priceId: process.env.STRIPE_PRICE_POWER, credits: 1000 }
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "missing_auth" });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) return res.status(401).json({ error: "invalid_auth" });

  const body = req.body || {};
  const chosen = PACKS[body.pack];
  if (!chosen || !chosen.priceId) return res.status(400).json({ error: "unknown_pack" });

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [{ price: chosen.priceId, quantity: 1 }],
      success_url: (process.env.SITE_URL || "") + "/?checkout=success",
      cancel_url: (process.env.SITE_URL || "") + "/?checkout=cancelled",
      client_reference_id: userData.user.id,
      metadata: { user_id: userData.user.id, credits: String(chosen.credits) }
    });
  } catch (e) {
    return res.status(502).json({ error: "stripe_failed", detail: String((e && e.message) || e) });
  }

  return res.status(200).json({ url: session.url });
};
