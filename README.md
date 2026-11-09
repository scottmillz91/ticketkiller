# TicketKiller UK

**Got a parking ticket? Fight it in two minutes.**

A web app that helps UK motorists challenge private parking charges (PCNs). Enter the details from your notice and it gives you the legal grounds that actually apply to your case, drafts a formal appeal letter, drafts the POPLA / IAS escalation if you get rejected, and tracks your deadline.

Static site — no framework, no build step, no backend.

---

## Contents

- [What it does](#what-it-does)
- [Run it locally](#run-it-locally)
- [Before you take real money](#before-you-take-real-money)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [How the appeal letter is generated](#how-the-appeal-letter-is-generated)
- [Deadline tracker](#deadline-tracker)
- [Operator intelligence](#operator-intelligence)
- [Payments](#payments)
- [Data and privacy](#data-and-privacy)
- [Editing content](#editing-content)
- [SEO and sharing](#seo-and-sharing)
- [Testing](#testing)
- [Deploying](#deploying)
- [Known limitations](#known-limitations)
- [Disclaimer](#disclaimer)

---

## What it does

| Feature | Detail |
| --- | --- |
| Landing page | Hero with sourced statistics, three-step explainer, and a real sample letter generated live |
| Deadline tracker | Counts down the operator appeal window and the reduced-payment window; tests the POFA Notice to Keeper timing |
| Ticket capture | Operator, PCN reference, date, location, contravention, amount, VRM, keeper name and address |
| Legal grounds | Eight drafting grounds tagged to POFA 2012, the BPA/IPC code, landowner authority and *Beavis*, each toggleable |
| Appeal letter | Recomputed live as you edit; declares keeper status, declines to name the driver, demands the evidence pack |
| Escalation letter | POPLA / IAS escalation with the verification code, generated for you after a rejection |
| Evidence request | A UK GDPR Article 15 request for the ANPR stills, signage, site plan and landowner contract |
| Appeal history | Every letter saved per account, with a countdown and won / lost / escalated status |
| Operator intelligence | Per-operator notes on what usually decides appeals, and the correct appeal route |
| Appeal guides | Seven per-operator pages designed as search landing pages |
| Legal pages | Privacy notice, terms, refund policy and contact page |
| Data page | Every statistic quoted, with its source and what it does *not* prove |
| Export | Copy to clipboard and PDF download (jsPDF, vendored locally) |
| Pricing | First appeal free, £4.99 per extra appeal, paid by card via Stripe |

Target audience: **private** parking charges from operators such as ParkingEye, UKPC, Euro Car Parks and NCP. Council PCNs follow a different statutory process and are out of scope — the FAQ says so.

---

## Run it locally

Nothing to install. Serve the folder over HTTP:

```bash
npm run serve          # python3 -m http.server 8000
# or
python3 -m http.server 8000
# or
npx serve .
```

Then open <http://localhost:8000>.

Serve it rather than double-clicking `index.html`: the app fetches `assets/data/*.json`, which `file://` blocks, and the login hashing uses `crypto.subtle`, which browsers only expose in a secure context. For the same reason any deployed copy must be served over **HTTPS**.

---

## Before you take real money

One block controls this. Open `assets/config.js`:

```js
business: {
  tradingName: "TicketKiller UK",
  legalName: "",     // ← your full name, or the company name
  address: "",       // ← a real postal or service address
  email: "",         // ← a working contact address
}
```

**Leave them blank and the site stays safe by default:**

| With blanks | Behaviour |
| --- | --- |
| Paying | Switched off automatically. Every letter is free; the paywall, Stripe buttons and pricing note adapt. |
| Privacy / terms pages | Identify the trading name only, with no invented legal identity. No bracketed placeholders are shown. |
| Contact page | Says no address is configured rather than printing an empty label. |
| Setup banner | Appears **only on localhost**, never on the deployed site, so it doesn't advertise an unfinished build. |

**Fill them in and the legal pages populate.** Payments stay off until you also
fill in the seller details — see [Payments](#payments). That is deliberate:
the site will not take money while it cannot verify it received any.

Verify the gate with:

```bash
npm test     # asserts selling is off and no placeholders leak
```

Also update the canonical and `og:` URLs in `index.html` if you move off
`scottmillz91.github.io`.

## Project structure

```
ticketkiller/
├── index.html                  # Markup for every page + SEO metadata
├── assets/
│   ├── config.js               # ← everything you'll want to change
│   ├── app.js                  # All application logic (one IIFE)
│   ├── styles.css              # Design tokens, components, all CSS
│   ├── data/
│   │   ├── grounds.json        # Legal grounds + escalation grounds
│   │   └── operators.json      # Operator reference data
│   ├── fonts/                  # Self-hosted Figtree + Bricolage Grotesque (OFL)
│   ├── vendor/jspdf.umd.min.js # jsPDF 2.5.1, vendored (no CDN)
│   └── og-image.jpg            # 1200×630 social preview card
├── tools/smoke-test.js         # jsdom test suite (38 checks)
└── package.json                # Only for the test dependency; no build
```

Pages are `<section class="page">` blocks toggled with an `.active` class. The router reads `location.hash`, so `#details`, `#guide/parkingeye` and `#refunds` are all linkable and shareable.

Navigation ids: `home` · `auth` · `history` · `details` · `evidence` · `results` · `pricing` · `faq` · `operators` · `guide` · `stats` · `privacy` · `terms` · `refunds` · `contact`

---

## Configuration

Everything lives in `assets/config.js`:

| Block | What it controls |
| --- | --- |
| `business` | Legal name, trading name, address, contact email — feeds the legal pages and footer |
| `pricing` | The displayed price and currency symbol |
| `payments` | `provider`, `enabled` kill switch, and `apiBase` for the functions |
| `contact` | Contact email and the response time quoted to users |
| `analytics` | Off by default; plausible-style event POSTing |
| `deadlines` | All the countdown windows (appeal, discount, POPLA, POFA 14 / 28 / 56 days) |
| `features` | Turn individual features off without deleting them |
| `version` | Reported with the `session_start` analytics event |

`features` is the safe way to hide something you're not ready for:

```js
features: {
  deadlineTracker: true,
  evidenceRequest: true,
  escalation: true,
  operatorIntel: true,
  sampleLetter: true,
  seoLandingPages: true
}
```

**Currency and pricing gotcha.** The price is written in three kinds of place in `index.html`, but the *displayed* amount now comes from `[data-price]` spans filled from config. If you change the price you must still update:

1. `pricing.extraLetterLabel` in `assets/config.js` — drives the visible text
2. `PRICE_PENCE` in `netlify/functions/checkout.js` — this is what Stripe actually charges
3. the literal `<p class="price"><span>£</span>4.99</p>` on the pricing card

The server value is authoritative; the config only changes what people see. Mismatched and you display one price while charging another.

---

## How the appeal letter is generated

Three layers, all in `assets/data/grounds.json` and `assets/app.js`.

**The grounds** — eight drafting templates, each with a `tag`, `title`, `body` and a `when` hint shown in the UI:

| Ground | Tag | What it argues |
| --- | --- | --- |
| `pofa-timing` | POFA 2012 Sch 4 para 9 | Notice to Keeper outside 14 days, no windscreen ticket |
| `pofa-window` | POFA 2012 Sch 4 para 8 | After a windscreen ticket, notice outside 28–56 days (too early is as defective as too late) |
| `pofa-content` | POFA 2012 Sch 4 para 9(2) | Prescribed statements missing or paraphrased |
| `signage` | BPA / IPC Code | Signs not prominent or legible, so no contract formed |
| `grace` | BPA / IPC Code | No consideration period, no 10-minute grace period |
| `anpr` | POFA 2012 "period of parking" | A camera crossing is not proof of parking |
| `authority` | Landowner authority | No evidence they may issue charges in their own name |
| `beavis` | *ParkingEye v Beavis* [2015] UKSC 67 | Not a genuine, proportionate attempt to manage the site |

Users can exclude any ground; the letter recomputes immediately. The `escalation` array provides four separate grounds for the POPLA / IAS stage — procedural, evidence, POFA, proportionality.

**The letter** — `buildLetter()` in `app.js`. It:

- appeals as the registered keeper and declines to identify the driver
- names the correct route from operator data: **POPLA** for BPA operators, **IAS** for IPC
- adds a timing paragraph only when you've supplied a Notice to Keeper date
- demands the ANPR pack, signage photographs, site plan, landowner contract and second-accurate timestamps
- asks that debt-recovery fees not be added while the appeal is live
- includes a UK GDPR data-subject hook and a non-legal-advice footer

Saved appeals store the rendered letter text, so an old letter is a snapshot — it does not change if you later edit `grounds.json`.

**PDF export** — jsPDF, A4, Times 11pt, 56pt margins, page breaks every ~48 lines. If the vendored script fails to load, it falls back to `window.print()` rather than doing nothing.

---

## Deadline tracker

All windows come from `config.deadlines` and are counted in whole days from the date on the notice:

| Window | Default | Basis |
| --- | --- | --- |
| Operator appeal | 28 days | Most operators; 14 and 21 are offered as options because the letter governs |
| Reduced payment | 14 days | The usual discount period |
| POPLA / IAS escalation | 28 days | From the operator's rejection |
| POFA Notice to Keeper (no windscreen ticket) | 14 days | Sch 4 para 9 |
| POFA Notice to Keeper (windscreen ticket) | 28–56 days | Sch 4 para 8 |

If the user supplies a Notice to Keeper date, the tracker computes the gap and states plainly whether keeper liability looks established. It also repeats the caveat that the letter always beats the tracker, because operators do quote different periods.

The tracker appears on the details page, as a pill on the results page, and as a per-appeal countdown in history. Status bands: green over 7 days, amber 4–7, red 0–3, grey once passed.

---

## Operator intelligence

`assets/data/operators.json` holds ten operators with `name`, `aliases`, `tradeBody` (BPA or IPC), `siteType` and a `themes` array describing what usually decides appeals against them. It powers three things:

1. an autocomplete `datalist` on the operator field
2. a live intel card on the details page that reacts as you type
3. the operator reference page and the per-operator guide pages

The file notes in `_note` that trade-body membership changes. The rejection letter always states the route, which is why the app never hard-codes POPLA for every operator.

---

## Payments

Stripe Checkout. Card details are typed on Stripe's page, so this codebase never
handles them and stays out of PCI scope.

### Why there is a server

The site is static, and Stripe cannot be driven from a static page. Creating a
Checkout session needs the **secret key**, which can create charges and refunds.
If that key were in `assets/config.js` it would be in every visitor's browser.

So three small serverless functions live in `netlify/functions/`, and only they
hold the key:

| Endpoint | What it does |
| --- | --- |
| `POST /api/checkout` | Creates a Checkout session and returns its URL. The price is fixed server-side, so a buyer cannot name their own amount. |
| `GET  /api/verify-session` → `POST` | The browser hands back the `session_id` from the redirect. This asks Stripe whether that session was really paid. |
| `POST /api/stripe-webhook` | Verifies Stripe's signature against the raw body and logs the purchase. This is the only place a payment is treated as real. |

GitHub Pages keeps serving the site. Netlify hosts only `/api/*`.

### The rule the code follows

**The URL is not evidence.** `?stripe=success` can be typed by hand, so nothing
unlocks until `/api/verify-session` says `paid: true`. If that call fails, times
out, or returns anything else, no letter is granted — see `catchStripeReturn()`
in `assets/app.js`.

Each session id is recorded after use, so reloading the success URL cannot mint
a second letter.

### Setting it up

**Full walkthrough: [docs/STRIPE-SETUP.md](docs/STRIPE-SETUP.md)** — includes a
troubleshooting table, the test card, and the list of ways a live deployment
goes wrong.

The short version:

1. **Stripe.** Create an account, then copy the secret key from Developers → API keys.
   Use `sk_test_…` first; live keys only once a real payment has worked end to end.
2. **Netlify.** Add the repo as a new site. `netlify.toml` points it at
   `netlify/functions`, so no build settings are needed.
3. **Environment variables** in Netlify → Site settings → Environment variables:

   | Variable | Value |
   | --- | --- |
   | `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` |
   | `SITE_URL` | `https://scottmillz91.github.io/ticketkiller` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` from step 5 |

4. **`assets/config.js`** → set `payments.apiBase` to the Netlify site URL, e.g.
   `https://ticketkiller-payments.netlify.app`. Leave it empty only if the site
   itself is served from Netlify.
5. **Stripe → Developers → Webhooks** → add
   `https://<netlify-site>/api/stripe-webhook`, subscribed to
   `checkout.session.completed`. Copy the signing secret into step 3.
6. **Fill in the seller details** at the top of `assets/config.js` — `legalName`,
   `address`, `email`. Until they are real, `canSell` stays false and every pay
   button is hidden. This is deliberate: UK consumer law requires an identifiable
   trader before money changes hands.

### Test card

`4242 4242 4242 4242`, any future expiry, any CVC.

### Checking a deployment

```bash
npm run check:stripe -- https://your-site.netlify.app
```

Checks the config, then calls all three endpoints and names what is wrong. Run it
before trying a real payment; it catches the mistakes that otherwise only appear
as a silent failure in someone's browser.

### What the tests cover

The smoke suite runs against a config with the seller details filled in, and
checks that the return handler only grants a credit inside the verified branch.
Server behaviour was exercised separately: unsigned webhooks, tampered bodies,
unpaid sessions, unreachable Stripe and malformed session ids all resolve to
"not paid" rather than erroring open.

### Known limits, stated plainly

- **Credits live in `localStorage`.** Clearing site data loses paid letters.
  Purchases are logged by the webhook so they can be honoured by hand, and the
  checkout function takes the account email as metadata — which is what makes
  that possible.
- **No refund automation.** Refunds are manual from the Stripe dashboard; the
  refunds page describes the 14-day position.
- **Rate limiting is per-instance and best-effort**, not a security boundary.

---

## Data and privacy

The site itself has no database and no analytics by default. Letters and accounts never leave the browser. Two things do leave it, both only when you choose to pay:

- the **email address** of your account, to `/api/checkout`, so a payment can be tied to it
- a redirect to **Stripe's** hosted checkout page

Nothing else is transmitted anywhere.

`localStorage` keys:

| Key | Contents |
| --- | --- |
| `tk_users_v1` | Map of email → `{ name, pass, freeUsed, credits, appeals[], address, postcode }` |
| `tk_session` | Email of the logged-in user |
| `tk_pending_pay` | `{ email, nonce, started }` for an in-flight payment |
| `tk_state_v1` | Draft ticket details, so a reload doesn't lose your typing |
| `tk_events` | Analytics event log, capped at 200 entries |

Being straight about the password hashing: SHA-256 with a fixed salt (`"tk|"`), no key stretching, stored on the user's own device. It stops someone reading a password over a shoulder. It is not meaningful security, and it is not a reason to skip a backend if accounts ever matter.

If `crypto.subtle` is unavailable (insecure context), the app falls back to a clearly-marked `plainfallback:` prefix rather than silently storing a password. In that state, tell people not to reuse a real password.

Appeal history stores full letter text, so a user's name, address, VRM and PCN sit in plain text in their browser profile until they clear site data.

---

## Editing content

**Legal grounds** → `assets/data/grounds.json`. Each ground needs `id`, `tag`, `title`, `body`, `when`. Add or remove freely; the card list, count and letter all derive from the array.

**Operators** → `assets/data/operators.json`. Add an object with a unique `id` and it appears in the autocomplete, the intel card and the operator grid.

**SEO guides** → the `GUIDES` array near the bottom of `app.js`. Each entry needs `slug`, `operator`, `place` and `basis`. Add a slug and it gets a page at `#guide/<slug>` plus an entry on the index.

**Statistics** → the `STATS` array in `app.js` and the trust row in `index.html`. Every figure must carry a source link; the data page exists specifically so unsourced numbers are conspicuous.

**Colours and type** → the `:root` block at the top of `assets/styles.css`.

**Fees, quotes, response times** → `assets/config.js`.

Note that a real font is now loaded (Figtree for body, Bricolage Grotesque for headings) from `assets/fonts/`. The old build referenced these fonts but never loaded them, so it rendered in the system font. Both are SIL Open Font Licensed, with licence files alongside.

---

## SEO and sharing

- Descriptive `<title>`, meta description, canonical link
- Open Graph and Twitter card tags with a real 1200×630 image
- `WebApplication` JSON-LD structured data
- Seven per-operator landing pages at `#guide/<slug>`
- Heading hierarchy per page, one `<h1>` each

Hash routing is fine for GitHub Pages but search engines treat `#details` as one URL. Once there's real traffic, converting to real paths (`/appeal/parkingeye/`) will do more for SEO than anything else on this list.

---

## Testing

```bash
npm install   # jsdom only
npm test      # node tools/smoke-test.js
```

38 checks run against a real DOM in jsdom: boot, content loading, deadline arithmetic including a deliberately late Notice to Keeper, registration, letter generation, ground toggling, escalation, the evidence request, the paywall, history, operator intel, guides, and every legal page. It fails the run on any uncaught error.

Two caveats: jsdom is not a browser, so this catches logic and wiring, not layout; and jsdom has no canvas, so jsPDF's font probe warns harmlessly.

---

## Deploying

Static hosting — GitHub Pages, Netlify, Cloudflare Pages or Vercel, all with no configuration.

**GitHub Pages:** Settings → Pages → Source: *Deploy from a branch* → `main`, folder `/ (root)`.

Before going live:

1. Replace the `business` placeholders in `assets/config.js`
2. Point the canonical, `og:url` and `og:image` tags at your real domain
3. Decide whether the paywall should be live at all (see [Payments](#payments))
4. Consider a `LICENSE` file — there isn't one

---

## The public sample letter

The landing page shows a **truncated preview**, not the full letter:

- `buildPreview()` in `assets/app.js` cuts the rendered letter at around
  30 lines, backing up to a paragraph boundary so it never stops mid-sentence
- what renders is the letterhead, the reference block, the keeper declaration
  and **ground 1 of 8** — roughly 1,300 of 4,700 characters
- it fades out, and a card underneath says how many lines are missing with a
  button to generate a real letter
- selection and right-click are still disabled, as a courtesy rather than a
  control

**Why truncation and not a watermark.** A watermark leaves the full letter in
the page and tries to discourage copying. Truncation means the rest is never
sent to the browser at all, so there is nothing to lift. The seven withheld
grounds — signage, grace period, ANPR, landowner authority, *Beavis* — are the
part worth paying for.

**What is still public.** The ground texts live in `assets/data/grounds.json`
because the results page needs them. A determined person can assemble the
arguments from there. That is acceptable: they would be getting public
reference material, not a ready-to-send letter. Do not put anything
genuinely proprietary in that file.

Tune the cut with `SAMPLE_PREVIEW_LINES` in `assets/app.js`.

## Known limitations

1. **No backend.** Accounts, sessions and history are per-browser. Same user on a phone and a laptop are two unrelated accounts, and clearing site data destroys everything.
2. **Paid credits live in the browser.** A payment is verified server-side, but the resulting credit is stored in `localStorage`, so clearing site data loses it. The webhook logs every purchase and the checkout call carries the account email, so a lost credit can be restored by hand.
   Related: the sample letter on the landing page is watermarked and
   non-selectable, but its text is still in the DOM, as is the letter template.
3. **Business email is in the page source** (`config.js` is public), so scrapers will find it.
4. **Hash routing** limits SEO depth.
5. **Statistics age.** The POPLA 2025 report and the RAC/DVLA 2024-25 figures will be superseded. `/stats` exists to make staleness obvious — update it when new reports land.
6. **No analytics by default**, so there's no visibility into drop-off until you enable it.
7. **Legal content is not lawyer-reviewed.** The statutory citations are accurate to published sources, but the appeal arguments are drafting aids, not advice.
8. **Fonts are latin-only** subsets; characters outside Latin-1 will fall back to system fonts.

---

## Disclaimer

The site is provided for information only and does not constitute legal advice. It does not engage in reserved legal activity, does not lodge appeals on the user's behalf, and does not impersonate a solicitor. Parking charges issued by private companies are not criminal fines. Users must check the dates, codes and instructions on their own notice.

Statutory content was checked against POPLA's 2025 annual report, the RAC Foundation's DVLA analysis, and the Private Parking Code of Practice laid before Parliament on 20 October 2026 (not then in force). Nothing here should be treated as a statement of the law on any particular date.
