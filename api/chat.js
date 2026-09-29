// POST /api/chat  (Vercel serverless function — Node.js runtime)
// Body: { messages, tools, turnId }
// Header: Authorization: Bearer <supabase access token>
//
// Same job as before: verify the caller, charge exactly one credit per turn,
// proxy to Groq (OpenAI-compatible chat completions) using a key that only
// lives here, refund the credit if Groq fails to actually respond.

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "missing_auth" });

    const { data: userData, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return res.status(401).json({ error: "invalid_auth" });
    }
    const userId = userData.user.id;

    const body = req.body || {};
    const { messages, tools, turnId } = body;
    if (!turnId || typeof turnId !== "string") {
      return res.status(400).json({ error: "missing_turn_id" });
    }
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: "missing_messages" });
    }

    // --- Charge exactly once per turn ---
    const { error: insertErr } = await supabase
      .from("charged_turns")
      .insert({ turn_id: turnId, user_id: userId });

    const alreadyChargedThisTurn = !!insertErr;
    const chargedNow = !alreadyChargedThisTurn;

    if (!alreadyChargedThisTurn) {
      const { data: profile, error: profErr } = await supabase
        .from("profiles")
        .select("credits")
        .eq("id", userId)
        .single();

      if (profErr || !profile) {
        return res.status(500).json({ error: "profile_lookup_failed", detail: profErr ? profErr.message : "no profile row" });
      }
      if (profile.credits <= 0) {
        await supabase.from("charged_turns").delete().eq("turn_id", turnId);
        return res.status(402).json({ error: "no_credits" });
      }
      await supabase
        .from("profiles")
        .update({ credits: profile.credits - 1 })
        .eq("id", userId);
    }

    async function refundIfCharged() {
      if (!chargedNow) return;
      const { data: p } = await supabase.from("profiles").select("credits").eq("id", userId).single();
      if (p) await supabase.from("profiles").update({ credits: p.credits + 1 }).eq("id", userId);
      await supabase.from("charged_turns").delete().eq("turn_id", turnId);
    }

    // --- Proxy to Groq, with one retry on a transient rate-limit/server error ---
    const callGroqOnce = async () => {
      return fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          tools: tools && tools.length ? tools : undefined,
          tool_choice: tools && tools.length ? "auto" : undefined
        })
      });
    };

    let groqRes;
    try {
      groqRes = await callGroqOnce();
      if (groqRes.status === 429 || groqRes.status === 503) {
        await new Promise((r) => setTimeout(r, 1500));
        groqRes = await callGroqOnce();
      }
    } catch (e) {
      await refundIfCharged();
      return res.status(502).json({ error: "groq_unreachable", detail: String((e && e.message) || e) });
    }

    if (groqRes.status === 429) {
      await refundIfCharged();
      return res.status(429).json({
        error: "rate_limited",
        detail: "Groq's free-tier rate limit was hit. Try again in a minute."
      });
    }
    if (!groqRes.ok) {
      await refundIfCharged();
      const errText = await groqRes.text().catch(() => "");
      return res.status(502).json({ error: "groq_request_failed", status: groqRes.status, detail: errText.slice(0, 300) });
    }

    let data;
    try {
      data = await groqRes.json();
    } catch (e) {
      await refundIfCharged();
      return res.status(502).json({ error: "groq_bad_response", detail: "Groq returned a non-JSON response." });
    }
    return res.status(200).json(data);
  } catch (e) {
    // Catch-all: anything unexpected lands here as a readable error instead of
    // a raw platform crash (Vercel's FUNCTION_INVOCATION_FAILED).
    console.error("chat.js unhandled error:", e);
    return res.status(500).json({
      error: "internal_error",
      detail: String((e && e.stack) || (e && e.message) || e)
    });
  }
};
