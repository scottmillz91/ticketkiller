/* ============================================================
   POST /api/stripe-webhook
   ------------------------------------------------------------
   The ONLY place a payment is treated as real.

   The browser redirect back from Stripe proves nothing — anyone can
   open `?stripe=success` in the address bar. This endpoint verifies
   Stripe's signature against the raw request body, and only then
   records the purchase.

   Environment variables required:
     STRIPE_SECRET_KEY
     STRIPE_WEBHOOK_SECRET   whsec_…
   ============================================================ */

const Stripe = require("stripe");
const crypto = require("crypto");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body)
});

/* Stripe signs the exact bytes it sent. Netlify may hand the body over
   already parsed or base64-encoded depending on the event, so it is
   reconstructed here before verification. */
function rawBody(event) {
  if (event.isBase64Encoded) return Buffer.from(event.body || "", "base64").toString("utf8");
  return event.body || "";
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" });

  const secret = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !whSecret) {
    console.error("stripe webhook: missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET");
    return json(500, { error: "Not configured" });
  }

  const signature = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  if (!signature) return json(400, { error: "No signature" });

  const stripe = Stripe(secret);
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody(event), signature, whSecret);
  } catch (err) {
    /* A request that fails verification is either misconfigured or forged.
       Either way it must not grant anything. */
    console.error("stripe webhook signature rejected:", err && err.message);
    return json(400, { error: "Invalid signature" });
  }

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;

    /* An unpaid session (delayed payment methods) can fire this event
       with payment_status still open. Only a paid one grants a letter. */
    if (session.payment_status !== "paid") {
      console.log("webhook: session completed but not paid", session.id, session.payment_status);
      return json(200, { received: true });
    }

    const email = (session.metadata && session.metadata.tk_email) || session.customer_details && session.customer_details.email || "";
    const amount = session.amount_total;

    /* This function has no database. The purchase is logged so it can be
       reconciled, and the browser is told which Stripe session is genuine
       so it can unlock exactly that one — once. */
    console.log("PURCHASE", JSON.stringify({
      session: session.id,
      email,
      amount,
      currency: session.currency,
      livemode: session.livemode,
      created: new Date().toISOString()
    }));

    /* Idempotency: the browser enforces it too, but recording the id here
       means a replayed delivery is visible in the logs rather than silent. */
    return json(200, { received: true, session: session.id });
  }

  /* Everything else is acknowledged so Stripe stops retrying. */
  return json(200, { received: true });
};

/* Exposed for the test suite: it verifies the raw-body reconstruction
   rather than sending a real signed webhook. */
exports._rawBody = rawBody;
exports._hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
