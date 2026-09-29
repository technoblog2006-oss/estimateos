// POST /api/webhook
// Configure this URL in your Stripe Dashboard so Stripe calls it after a
// successful payment. Do not call this from the frontend yourself.
//
// Stripe signature verification needs the RAW request body, so Vercel's
// automatic JSON body-parsing is turned off below (config.api.bodyParser)
// and the raw bytes are read manually.

const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const rawBody = await readRawBody(req);

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send("Webhook signature verification failed: " + err.message);
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    const userId = session.metadata && session.metadata.user_id;
    const credits = parseInt((session.metadata && session.metadata.credits) || "0", 10);

    if (userId && credits > 0) {
      const { data: profile, error: profErr } = await supabase
        .from("profiles")
        .select("credits")
        .eq("id", userId)
        .single();

      if (!profErr && profile) {
        await supabase
          .from("profiles")
          .update({ credits: profile.credits + credits })
          .eq("id", userId);
      }
    }
  }

  return res.status(200).json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
