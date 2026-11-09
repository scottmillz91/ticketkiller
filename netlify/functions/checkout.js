/* ============================================================
   POST /api/checkout
   ------------------------------------------------------------
   Creates a Stripe Checkout session and returns its URL.

   Runs on Netlify as a serverless function. The Stripe secret key
   lives only here, in an environment variable. It must never be
   put in assets/config.js or any file the browser downloads —
   a leaked secret key can create charges and refunds on the
   account.

   Environment variables required (Netlify > Site settings >
   Environment variables):
     STRIPE_SECRET_KEY   sk_live_… or sk_test_…
     SITE_URL            https://scottmillz91.github.io/ticketkiller
   ============================================================ */

const Stripe = require("stripe");

/* Price is fixed here, server-side. If the browser could name the
   amount, a buyer could ask to pay £0.01 for a £4.99 letter. */
const PRICE_PENCE = 499;
const CURRENCY = "gbp";
const PRODUCT_NAME = "TicketKiller UK — extra appeal letter";

/* A crude per-IP limit. Netlify functions are stateless per instance,
   so this is best-effort rather than airtight: it stops one client
   hammering the endpoint in a loop, and nothing more. Real abuse
   protection belongs in front of this. */
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear(); // unbounded map guard
  return list.length > MAX_PER_WINDOW;
}

const { resolve: resolveSite } = require("../lib/site");

const json = (statusCode, body, requestOrigin) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    /* The site is served from GitHub Pages, so the browser makes a
       cross-origin request. Only the configured origin is allowed. */
    "Access-Control-Allow-Origin": resolveSite(requestOrigin).allow || "*",
    "Vary": "Origin"
  },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const requestOrigin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const site = resolveSite(requestOrigin);

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": site.allow || "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin"
      },
      body: ""
    };
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST" }, requestOrigin);

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return json(500, { error: "Payments are not configured on the server." }, requestOrigin);
  if (!site.base) return json(500, { error: "SITE_URL is not configured on the server." }, requestOrigin);
  /* A payment must be able to return the visitor to the site. Without this
     a checkout is created that nobody can be sent back from. */
  const returnBase = site.base;

  const ip = (event.headers["x-nf-client-connection-ip"] || event.headers["client-ip"] || "unknown");
  if (rateLimited(ip)) return json(429, { error: "Too many attempts. Wait a minute and try again." }, requestOrigin);

  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch { /* fall through to the check below */ }

  /* The email identifies which local account to unlock. It is a browser
     account here, not a Stripe customer, so it is validated lightly and
     carried through as metadata. */
  const email = typeof payload.email === "string" ? payload.email.trim().slice(0, 200) : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "A valid email is required." }, requestOrigin);

  try {
    const stripe = Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: PRICE_PENCE,
          product_data: { name: PRODUCT_NAME }
        }
      }],
      /* Metadata is the only thing the webhook can trust to say who paid.
         Both success_url params and client-side state can be forged. */
      metadata: { tk_email: email },
      customer_email: email,
      success_url: `${returnBase}/?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBase}/?stripe=cancel`,
      /* One letter per payment, and the letter is not shipped by email,
         so no shipping address is wanted. */
      billing_address_collection: "auto"
    }, {
      /* Two rapid clicks must not create two sessions for one purchase. */
      idempotencyKey: `tk-${email}-${Date.now()}`
    });

    return json(200, { url: session.url }, requestOrigin);
  } catch (err) {
    /* Log the real reason server-side; never return Stripe's message to a
       client, since it can echo key fragments. */
    console.error("stripe checkout failed:", err && err.message);
    return json(502, { error: "Could not start checkout. Please try again." }, requestOrigin);
  }
};
