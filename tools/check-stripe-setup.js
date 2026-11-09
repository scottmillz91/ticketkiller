#!/usr/bin/env node
/* ============================================================
   Stripe setup check
   ------------------------------------------------------------
   Run this once the Netlify functions are deployed, before trying a
   real payment. It answers one question: will a customer's payment
   actually arrive, and will the site believe it?

   Usage:
     node tools/check-stripe-setup.js https://your-site.netlify.app

   Exits 0 when everything it can test has passed, 1 otherwise.
   ============================================================ */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const base = (process.argv[2] || "").replace(/\/$/, "");

let failures = 0;
const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m, hint) => { failures++; console.log(`  FAIL  ${m}`); if (hint) console.log(`        -> ${hint}`); };
const info = (m) => console.log(`        ${m}`);

async function post(url, body, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log("\nTicketKiller UK — Stripe setup check\n");

  if (!base) {
    console.log("  Usage: node tools/check-stripe-setup.js https://your-site.netlify.app\n");
    process.exit(1);
  }
  if (!/^https:\/\//.test(base)) {
    console.log(`  Warning: ${base} is not https. Stripe will not accept a non-HTTPS return URL.`);
  }

  /* ---------- 1. the site's own config ---------- */
  console.log(`1. Site config (assets/config.js)`);
  const cfgSrc = fs.readFileSync(path.join(root, "assets", "config.js"), "utf8");

  const grab = (re) => { const m = cfgSrc.match(re); return m ? m[1] : ""; };
  const apiBase = grab(/apiBase:\s*"([^"]*)"/);
  const legalName = grab(/legalName:\s*"([^"]*)"/);
  const address = grab(/address:\s*"([^"]*)"/);
  const email = grab(/email:\s*"([^"]*)"/);

  const isPlaceholder = (v) => !v || /^TODO\b/i.test(v) || /^your |^you@/i.test(v);

  if (apiBase && apiBase !== base) {
    fail(`payments.apiBase is "${apiBase}", not "${base}"`, "the browser will call the wrong host");
  } else if (!apiBase) {
    fail("payments.apiBase is empty", "set it to this Netlify URL, otherwise /api goes to GitHub Pages, which has no functions");
  } else {
    pass(`payments.apiBase = ${apiBase}`);
  }

  if (isPlaceholder(legalName)) fail("business.legalName is a placeholder", "selling stays off until this is your real name or company name");
  else pass(`business.legalName = ${legalName}`);

  if (isPlaceholder(address)) fail("business.address is a placeholder", "required before taking money");
  else pass(`business.address = ${address}`);

  if (isPlaceholder(email)) fail("business.email is a placeholder", "required before taking money");
  else pass(`business.email = ${email}`);

  /* ---------- 2. the checkout endpoint ---------- */
  console.log(`\n2. Checkout endpoint (${base}/api/checkout)`);
  let checkoutUrl = null;
  try {
    const r = await post(`${base}/api/checkout`, { email: "setup-check@example.com" });
    if (r.status === 200 && r.json && r.json.url) {
      checkoutUrl = r.json.url;
      pass("a Checkout session was created");
      info(checkoutUrl.slice(0, 72) + (checkoutUrl.length > 72 ? "…" : ""));
      if (!/^https:\/\/checkout\.stripe\.com\//.test(checkoutUrl)) {
        fail("the returned URL is not a Stripe Checkout URL", checkoutUrl);
      } else {
        pass("the URL is a Stripe-hosted checkout page");
      }
    } else if (r.status === 500) {
      fail(`server said: ${(r.json && r.json.error) || "500"}`,
        "almost always a missing STRIPE_SECRET_KEY or SITE_URL environment variable");
    } else if (r.status === 404) {
      fail("404 — no function at that path", "check netlify.toml redirects and that the site deployed");
    } else {
      fail(`unexpected ${r.status}: ${(r.json && r.json.error) || JSON.stringify(r.json)}`);
    }
  } catch (err) {
    fail(`could not reach the endpoint (${err.message})`, "is the Netlify site deployed and the URL correct?");
  }

  /* CORS matters because the site is served from GitHub Pages. */
  const origin = "https://scottmillz91.github.io";
  try {
    const res = await fetch(`${base}/api/checkout`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" }
    });
    const allow = res.headers.get("access-control-allow-origin");
    if (allow === origin || allow === "*") pass(`CORS allows ${origin}`);
    else if (!allow) fail("no Access-Control-Allow-Origin on the preflight", "SITE_URL is probably unset on the server");
    else fail(`CORS allows "${allow}", not ${origin}`, "set SITE_URL to the exact site origin, with no trailing slash");
  } catch (err) {
    fail(`preflight failed (${err.message})`);
  }

  /* ---------- 3. the verify endpoint ---------- */
  console.log(`\n3. Verify endpoint (${base}/api/verify-session)`);
  try {
    const r = await post(`${base}/api/verify-session`, { session_id: "cs_test_definitelynotareal1" });
    if (r.status === 200 && r.json && r.json.paid === false) {
      pass("a made-up session id is correctly refused (paid: false)");
    } else if (r.status === 200 && r.json && r.json.paid === true) {
      fail("a made-up session id reported as PAID", "stop. do not take real money until this is fixed");
    } else if (r.status === 500) {
      fail(`server said: ${(r.json && r.json.error) || "500"}`, "check STRIPE_SECRET_KEY");
    } else {
      fail(`unexpected ${r.status}: ${(r.json && JSON.stringify(r.json)) || "no body"}`);
    }
  } catch (err) {
    fail(`could not reach the endpoint (${err.message})`);
  }

  /* ---------- 4. the webhook endpoint ---------- */
  console.log(`\n4. Webhook endpoint (${base}/api/stripe-webhook)`);
  try {
    const r = await post(`${base}/api/stripe-webhook`, { type: "checkout.session.completed" });
    if (r.status === 400) {
      pass("an unsigned payload is rejected (400)");
    } else if (r.status === 500) {
      fail(`server said: ${(r.json && r.json.error) || "500"}`, "STRIPE_WEBHOOK_SECRET is probably unset");
    } else if (r.status === 200) {
      fail("an unsigned payload was accepted", "the webhook must reject anything Stripe did not sign");
    } else {
      fail(`unexpected ${r.status}`);
    }
  } catch (err) {
    fail(`could not reach the endpoint (${err.message})`);
  }

  /* ---------- summary ---------- */
  console.log("");
  if (failures === 0) {
    console.log("Everything reachable checks out.\n");
    console.log("Two things this script cannot test, so do them by hand:");
    console.log("  1. Pay with 4242 4242 4242 4242 and confirm you land back on the site");
    console.log("     with 'Payment confirmed' — then check the letter unlocks.");
    console.log("  2. Stripe > Developers > Webhooks > your endpoint: confirm a");
    console.log("     checkout.session.completed delivery shows as Succeeded.\n");
    console.log("If step 1 charges you but says it cannot verify, the webhook secret or");
    console.log("SITE_URL is wrong. Test mode costs nothing, so test it now.\n");
  } else {
    console.log(`${failures} problem(s) to fix before taking money.\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
