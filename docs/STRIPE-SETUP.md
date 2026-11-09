# Stripe setup, step by step

Everything the code needs is already in the repo. This document is the part that
has to happen in browser tabs: Stripe, Netlify, and three values in `config.js`.

Work in **test mode** throughout. Stripe test keys begin `sk_test_`, live keys
`sk_live_`, and the test mode switch is in the top-right of the Stripe dashboard.
Nothing in test mode moves real money.

Do not skip to live mode until a test card has produced a paid, unlocked letter.

---

## Before you start

Three things need to be true. If any is false, stop — the rest will not work.

| Check | Why |
| --- | --- |
| You have a Stripe account | It must be activated for live payments, but test mode works before activation |
| The repo is on GitHub (`scottmillz91/ticketkiller`) | Netlify deploys from it |
| You know your **seller details** — legal name, postal address, contact email | The site will not sell without them, by design |

---

## Step 1 — Create the Netlify site

1. Sign in at [app.netlify.com](https://app.netlify.com).
2. **Add new site → Import an existing project → GitHub**, then pick
   `scottmillz91/ticketkiller`.
3. Netlify will read `netlify.toml` and fill everything in itself. Leave the
   build command empty and the publish directory as `/`. The site has no build
   step; only the functions matter.
4. Deploy. When it finishes you get a URL like
   `https://cheerful-pastry-123abc.netlify.app`. **Write it down** — it is used
   twice more.

> The site itself stays on GitHub Pages. Netlify is only hosting `/api/*`.

**Checkpoint.** Visit `https://<your-site>.netlify.app/api/checkout` in a
browser. You should get `{"error":"Use POST"}`. If you get a 404, the functions
did not deploy — check that `netlify/functions/` is in the repo and that
`netlify.toml` is at the root.

---

## Step 2 — Add the environment variables

Netlify → your site → **Site configuration → Environment variables → Add a
variable**. Add these two now. The third comes in step 3.

| Key | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` from Stripe → **Developers → API keys** |
| `SITE_URL` | `https://scottmillz91.github.io/ticketkiller,https://your-site.netlify.app` |

Two things people get wrong here:

- `SITE_URL` is a **comma-separated list** of every address the site is served
  from, with no trailing slash. It is the origin the browser calls *from*, and
  it decides which site may call these functions and where a visitor is sent
  back after paying. The site is published to both GitHub Pages and the
  Netlify deploy, so **list both** — a single value makes the other host fail
  with *"SITE_URL is not configured"* or a CORS error.
- No trailing slash. `…/ticketkiller/` will look right and fail CORS.

After adding variables you must **redeploy** for them to take effect:
**Deploys → Trigger deploy → Deploy site**.

---

## Step 3 — Create the webhook

Stripe → **Developers → Webhooks → Add endpoint**.

| Field | Value |
| --- | --- |
| Endpoint URL | `https://<your-netlify-site>/api/stripe-webhook` |
| Events | `checkout.session.completed` |

Save, then click **Reveal** under *Signing secret*. It begins `whsec_`.

Back in Netlify, add it as the third variable:

| Key | Value |
| --- | --- |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |

Redeploy again.

> The webhook is what records a purchase. Without it, a payment can be verified
> once in the buyer's browser but there is no server-side record to reconcile
> against if they clear their site data.

---

## Step 4 — Point the site at Netlify

Open `assets/config.js` and set:

```js
payments: {
  apiBase: "https://<your-netlify-site>",   // no trailing slash
  ...
}
```

Commit and push. GitHub Pages rebuilds in about a minute.

Also fill in the seller details in the same file:

```js
business: {
  legalName: "Your full name",              // or the company name
  address: "1 Example Street, London, AB1 2CD",
  email: "you@yourdomain.co.uk"
}
```

Both `address` and `email` may repeat into `contact.email`, which is the address
shown on the contact page.

**These are legally required before you take money.** The site treats any value
still beginning `TODO` as unfilled and keeps payments switched off, so a
half-finished setup cannot accidentally charge anyone.

---

## Step 5 — Check it

```bash
node tools/check-stripe-setup.js https://<your-netlify-site>
```

or `npm run check:stripe -- https://<your-netlify-site>`.

It checks the config, then calls all three endpoints, and tells you which
specific thing is wrong. A clean run looks like this:

```
1. Site config (assets/config.js)
  ok    payments.apiBase = https://…netlify.app
  ok    business.legalName = …
  ok    business.address = …
  ok    business.email = …

2. Checkout endpoint (…/api/checkout)
  ok    a Checkout session was created
  ok    the URL is a Stripe-hosted checkout page
  ok    CORS allows https://scottmillz91.github.io

3. Verify endpoint (…/api/verify-session)
  ok    a made-up session id is correctly refused (paid: false)

4. Webhook endpoint (…/api/stripe-webhook)
  ok    an unsigned payload is rejected (400)
```

Anything marked `FAIL` includes the likely cause underneath it.

---

## Step 6 — The real test

1. Open the live site, log in, and generate your free letter.
2. Go back to **Enter ticket details** — the paywall should appear.
3. Click **Pay £4.99 by card**.
4. You should land on Stripe's hosted page. Pay with:

   | Field | Value |
   | --- | --- |
   | Card | `4242 4242 4242 4242` |
   | Expiry | any future date |
   | CVC | any three digits |
   | Name / postcode | anything |

5. You are returned to the site. Expected: *"Payment confirmed — £4.99."* and
   the generate button unlocked.
6. Stripe → **Payments** should list a £4.99 test payment.
7. Stripe → **Developers → Webhooks → your endpoint** → the delivery should show
   **Succeeded** and the function log should contain a `PURCHASE` line.

### Then try to break it

These are the things that actually go wrong in production.

| Test | Expected |
| --- | --- |
| Reload the success URL | "That payment has already been applied to this browser" — no second letter |
| Change `session_id` in the URL to nonsense | "Stripe has no record of that payment" — nothing unlocked |
| Log out, pay, then log in | Payment held and released: "…1 paid letter unlocked" |
| Cancel at Stripe | "Payment cancelled — nothing was charged" |
| Open `/api/checkout` in a browser | `{"error":"Use POST"}` |
| Post an unsigned body to `/api/stripe-webhook` | `400 Invalid signature` |

If any of these behaves differently, **do not go live** — the same paths protect
real money.

---

## Step 7 — Going live

Only after step 6 passes end to end.

1. Complete Stripe's activation (business details, bank account).
2. Stripe → API keys → copy the **live** secret key, `sk_live_…`.
3. Netlify → replace `STRIPE_SECRET_KEY` with the live key. **Redeploy.**
4. Stripe → Webhooks → add a **second** endpoint for live mode, same URL, same
   event, and put its `whsec_…` into `STRIPE_WEBHOOK_SECRET`.
5. Make one real £4.99 payment yourself and **refund it** from the dashboard.
6. Confirm the refund page and the receipt copy still read correctly.

### Switched on, in plain terms

- Test keys on the live site will show Stripe's "test mode" banner at checkout.
  Anyone can see it. That is normal, and it is not taking real money.
- Refunds are **manual**: Stripe → Payments → the payment → Refund. The refunds
  page already describes the 14-day position.
- Credits live in the buyer's browser. Clearing site data loses a paid letter;
  find the purchase in Stripe and grant a new one by hand.

---

## When it does not work

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Payments are not configured on the server" | `STRIPE_SECRET_KEY` missing | Add it in Netlify, then **redeploy** |
| "SITE_URL is not configured" | the variable is empty in Production | Add it, then **redeploy** |
| "Could not start checkout" | key rejected by Stripe | Check the Netlify function log for the real reason |
| Browser console: CORS error | `SITE_URL` missing this host, or has a trailing slash | List every host, comma-separated, **without** trailing slashes |
| Paid, but "Could not reach the payment server" | `apiBase` wrong in `config.js` | It must be the Netlify URL, with no trailing slash |
| Paid, but "Stripe has no record of that payment" | Wrong `STRIPE_SECRET_KEY` mode — live key looking up a test session, or the reverse | Keys and payments must be in the same mode |
| Webhook delivery shows `400` | `STRIPE_WEBHOOK_SECRET` wrong | Copy it again from the endpoint page, then redeploy |
| Pay button missing | Seller details still `TODO` | Fill in step 4 |
| Paid twice, one letter | Second payment was a new session | Each session is one letter by design; refund the duplicate |

Netlify function logs are under **Deploys → Functions → `checkout` / `verify-session` / `stripe-webhook`**.
That is where the real Stripe error appears; the browser only ever gets a
generic message, so no key fragments can leak.

---

## What this does not do

Stating these plainly, because each one costs money to get wrong:

- **No subscription or refund automation.** Manual, from the Stripe dashboard.
- **No server-side account database.** Credits are browser-side. The webhook
  logs every purchase with the account email, which is what makes a manual
  restore possible.
- **No fraud screening beyond Stripe's own.** Rate limiting on the endpoints is
  per-instance and best-effort.
- **No VAT handling.** If you register for VAT, the price and the legal pages
  both need revisiting — the terms page currently says prices include VAT where
  applicable, which is only true once you are actually VAT-registered.
