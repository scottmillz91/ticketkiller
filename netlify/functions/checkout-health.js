/* GET diagnostic for the payment wiring.
 *
 * This exists because "Invalid API Key" is indistinguishable from at least
 * four different mistakes when you can only see one generic error. It reports
 * facts about the configuration that are safe to publish — never any part of
 * the key beyond the standard prefix, and never the key length of a live key
 * in a way that helps anyone.
 *
 * GET /api/checkout-health
 */

const Stripe = require("stripe");
const { parse, originOf } = require("../lib/site");

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  },
  body: JSON.stringify(body, null, 2)
});

/* Describe a secret without disclosing it. The prefix is public knowledge
   (Stripe documents sk_test_ / sk_live_), so it is safe; nothing else is. */
function describeKey(raw) {
  const present = typeof raw === "string" && raw.length > 0;
  if (!present) return { present: false };
  const trimmed = raw.trim();
  /* Known prefixes only. Anything else is echoed as "unrecognised" rather
     than sliced, so a mis-pasted value is never partially printed. */
  const known = ["sk_test_", "sk_live_", "pk_test_", "pk_live_", "rk_test_", "rk_live_"];
  const prefix = known.find((p) => trimmed.startsWith(p)) || "unrecognised";
  return {
    present: true,
    prefix,
    isSecretKey: prefix === "sk_test_" || prefix === "sk_live_",
    isLive: prefix.endsWith("_live_"),
    length: trimmed.length,
    /* The single most common paste accident. */
    hadSurroundingWhitespace: trimmed !== raw
  };
}

exports.handler = async () => {
  const rawKey = process.env.STRIPE_SECRET_KEY;
  const key = describeKey(rawKey);

  const sites = parse(process.env.SITE_URL);
  const siteUrl = {
    present: sites.length > 0,
    count: sites.length,
    origins: [...new Set(sites.map(originOf))],
    /* A trailing slash is stripped by parse(), so report whether the raw
       value had one rather than silently hiding the mistake. */
    hadTrailingSlash: /\/\s*(,|$)/.test(String(process.env.SITE_URL || ""))
  };

  let stripe = { checked: false };
  if (key.present && key.isSecretKey) {
    try {
      const client = Stripe(String(rawKey).trim());
      /* Cheapest read-only call: proves the key is accepted without creating
         anything or moving money. */
      const balance = await client.balance.retrieve();
      stripe = { checked: true, auth: "ok", livemode: balance.livemode };
    } catch (err) {
      const type = (err && err.type) || "";
      stripe = {
        checked: true,
        auth: type === "StripeAuthenticationError" ? "rejected" : "error",
        /* Stripe's own type only; the message can echo key fragments. */
        type: type || "unknown"
      };
    }
  }

  const problems = [];
  if (!key.present) problems.push("STRIPE_SECRET_KEY is not set in this deploy's environment");
  else if (!key.isSecretKey) problems.push(`STRIPE_SECRET_KEY is ${key.prefix}, which cannot create a checkout`);
  if (key.hadSurroundingWhitespace) problems.push("STRIPE_SECRET_KEY has surrounding whitespace");
  if (stripe.auth === "rejected") problems.push("Stripe rejected the key: it is wrong, revoked, or from another account/sandbox");
  else if (stripe.auth === "error") problems.push("Could not reach Stripe from this function — transient network fault, try again");
  if (!siteUrl.present) problems.push("SITE_URL is not set in this deploy's environment");

  return json(200, {
    ok: problems.length === 0 && stripe.auth === "ok",
    problems,
    key,
    siteUrl,
    stripe
  });
};
