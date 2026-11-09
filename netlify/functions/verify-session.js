/* ============================================================
   POST /api/verify-session
   ------------------------------------------------------------
   Called by the browser after it returns from Stripe Checkout with a
   session_id. It asks Stripe whether that session was genuinely paid.

   Why this exists: the unlocked state lives in the browser's
   localStorage, so a signed webhook cannot reach it. This endpoint
   turns "did Stripe really take this payment" into a server-side
   question, and the browser can only unlock on a yes.

   Stripe's own words for the session are the only source of truth —
   never the redirect URL, which anyone can type by hand.

   Environment variables required:
     STRIPE_SECRET_KEY
     SITE_URL
   ============================================================ */

const Stripe = require("stripe");

const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 10;

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

const { resolve: resolveSite } = require("../lib/site");

const json = (statusCode, body, requestOrigin) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": resolveSite(requestOrigin).allow || "*",
    "Vary": "Origin"
  },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const requestOrigin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  if (event.httpMethod === "OPTIONS") {
    const origin = resolveSite(requestOrigin).allow || "*";
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" }, requestOrigin);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(500, { error: "Payments are not configured on the server." }, requestOrigin);

  const ip = event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown";
  if (rateLimited(ip)) return json(429, { error: "Too many attempts. Wait a minute." }, requestOrigin);

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch { /* checked below */ }

  const id = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  /* Stripe session ids look like cs_test_… / cs_live_… . Reject anything
     that could not be one before it reaches the API. */
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return json(400, { error: "Invalid session id." }, requestOrigin);

  try {
    const stripe = Stripe(secret);
    const session = await stripe.checkout.sessions.retrieve(id);

    /* All three must hold. payment_status is the decisive one: a session
       can exist, and be complete, without money having moved. */
    const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
    if (!paid || session.status !== "complete") {
      return json(200, { paid: false, status: session.payment_status }, requestOrigin);
    }

    return json(200, {
      paid: true,
      email: (session.metadata && session.metadata.tk_email) || (session.customer_details && session.customer_details.email) || "",
      amount: session.amount_total,
      currency: session.currency,
      livemode: session.livemode
    }, requestOrigin);
  } catch (err) {
    /* A bad id, a deleted session and a Stripe outage are not the same
       thing, but none of them is a payment. */
    console.error("verify-session failed:", err && err.message);
    return json(200, { paid: false, error: "Could not verify this payment." }, requestOrigin);
  }
};
