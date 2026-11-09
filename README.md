# TicketKiller UK

**Got a parking ticket? Fight it in two minutes.**

A single-page web app that helps UK motorists challenge private parking charges (PCNs). You enter the details from your notice, it builds a set of legal grounds for appeal, and it writes you a formal appeal letter you can copy or download as a PDF.

The whole site is **one self-contained HTML file** — no build step, no framework, no package manager, no backend.

---

## Contents

- [What it does](#what-it-does)
- [Run it locally](#run-it-locally)
- [How the app works](#how-the-app-works)
- [Project structure](#project-structure)
- [How the appeal letter is generated](#how-the-appeal-letter-is-generated)
- [Pricing and payments](#pricing-and-payments)
- [Data and privacy](#data-and-privacy)
- [Customising the site](#customising-the-site)
- [Deploying](#deploying)
- [Known limitations](#known-limitations)
- [Disclaimer](#disclaimer)

---

## What it does

| Feature | Detail |
| --- | --- |
| Landing page | Hero, three-step explainer, trust figures, calls to action |
| Accounts | Sign up / log in, stored entirely in the browser |
| Ticket capture | A form for operator, PCN reference, date, location, contravention, amount, vehicle reg and keeper name |
| Legal grounds | Five pre-written appeal arguments tagged to UK parking law |
| Appeal letter | Auto-generated formal letter that updates live as you edit the form |
| Export | Copy to clipboard, or download as PDF (falls back to printing) |
| Appeal history | Every letter you generate, saved per account and re-openable |
| Pricing | First appeal free, £4.99 per extra appeal via PayPal |
| FAQ | Six questions covering deadlines, POPLA/IAS escalation, keeper liability and more |

Target audience: **private** parking charges from operators such as ParkingEye, UKPC, Euro Car Parks and NCP. Council PCNs follow a different statutory process and are out of scope (the FAQ says so).

---

## Run it locally

There is nothing to install. Serve the folder over HTTP:

```bash
# Python 3 (already on macOS and most Linux boxes)
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>.

Serving over `http://localhost` rather than opening the file directly matters: the login flow hashes passwords with `crypto.subtle`, which browsers only expose in secure contexts. For the same reason, any deployed copy must be served over **HTTPS**.

---

## How the app works

`index.html` contains every screen as a `<section class="page">`. The script at the bottom of the file shows one section at a time by toggling an `.active` class — there is no router and no URL per screen.

```
Home ──▶ Enter ticket details ──▶ Generate ──▶ Results (grounds + letter)
          │                                        │
          │ (not logged in)                        ├─▶ Copy letter
          ▼                                        └─▶ Download PDF
        Sign up / Log in ──▶ Details
                │
                └──▶ My appeals (reopen a saved letter)

Pricing ──▶ PayPal ──▶ back to site with ?paypal=success ──▶ credit added
```

Screens are identified by `data-page` and navigated with `data-nav` buttons:

`home` · `auth` · `history` · `details` · `results` · `pricing` · `faq`

Guard rails in the script:

- Reaching `details` or `history` while logged out bounces you to `auth`, then returns you to where you were headed (`afterLogin`).
- Generating a letter requires an account. The first letter is free per account; after that the paywall pane appears and the generate button is disabled until a credit is bought.
- Clicking the auth button while logged in logs you out rather than opening a page.

---

## Project structure

```
ticketkiller/
├── index.html   # The entire application — styles, markup and JavaScript
└── README.md    # This file
```

Inside `index.html`:

| Region | What's there |
| --- | --- |
| `<head>` → `<style>` | All CSS. Design tokens as custom properties on `:root` |
| `<body>` → `<header>` | Sticky top bar, desktop nav, mobile hamburger menu |
| `<main id="app">` | The seven page sections, in order |
| `<footer>` | Legal disclaimers |
| `<script src="…jspdf…">` | jsPDF 2.5.1 from cdnjs — the only external dependency |
| Inline `<script>` | App logic, wrapped in an IIFE |

The only external request the page makes is the jsPDF bundle from `cdnjs.cloudflare.com`. Everything else — styles, icons, the favicon (an inline SVG data URI) — is embedded.

---

## How the appeal letter is generated

Two pieces of code do the work, and both live near the top of the inline script.

**1. The grounds — the `GROUNDS` array.** Five objects, each with a `tag`, `title` and `body`:

1. **POFA 2012 Schedule 4** — keeper liability may not have been established (Notice to Keeper timing, prescribed wording)
2. **BPA / IPC Code of Practice** — signage unlikely to have formed a clear contract
3. **Grace period** — the mandatory consideration period doesn't appear to have been applied
4. **ANPR evidence** — camera timestamps show presence, not necessarily parking
5. **Landowner authority** — no proof the operator was entitled to issue charges

These render as cards under "Grounds for appeal" and are also woven into the letter body.

**2. The template — `letterFromForm()`.** A template literal that interpolates the form fields and the grounds into a letter addressed to the operator's appeals team. It:

- States the keeper is disputing in full and declining to identify the driver
- Demands a POPLA code (BPA operators) or an IAS code (IPC operators) with any rejection
- Asks for the ANPR evidence pack, signage photographs, landowner authority and timestamps to the second
- Requests no debt-recovery fees be added while the appeal is outstanding
- Ends with a non-legal-advice disclaimer

The letter re-renders on every keystroke while the results page is visible, so edits are reflected instantly. Saving copies the letter text, plus the ticket fields, into the account's history — so a saved letter is a snapshot and stays as written even if the template later changes.

**PDF export** uses jsPDF: Times 11pt, A4, 54pt margins, automatic page breaks. The filename is derived from the PCN reference. If the CDN bundle failed to load, the button falls back to `window.print()` so the user still gets something.

---

## Pricing and payments

- **First appeal:** free, tracked per account with a `freeUsed` flag.
- **Every appeal after that:** £4.99, tracked with a `credits` counter.

Payment uses a standard PayPal **`_xclick`** form, so there is no API key, SDK or server involved. The amount, currency and business email are hidden inputs in the form markup:

```html
<input type="hidden" name="amount" value="4.99" />
<input type="hidden" name="currency_code" value="GBP" />
<input type="hidden" name="business" value="…" />
```

Before submitting, the script records a pending payment in `localStorage` (email + random nonce) and sets three fields:

| Field | Value |
| --- | --- |
| `return` | current URL + `?paypal=success` |
| `cancel_return` | current URL + `?paypal=cancel` |
| `custom` | `email\|nonce` |

On return, the app reads `?paypal=success` and grants a credit to the pending email. `?paypal=cancel` just clears the pending record.

> ⚠️ **The price lives in two places** — the details page paywall form *and* the pricing page card — plus the amount is written into button text ("Pay £4.99", "Pay £4.99 to generate another"). Change all of them together.

---

## Data and privacy

There is no server, no database and no analytics. Nothing typed into the site leaves the browser except the payment redirect to PayPal.

Everything persists in `localStorage` under three keys:

| Key | Contents |
| --- | --- |
| `tk_users_v1` | Map of email → `{ name, pass, freeUsed, credits, appeals[] }` |
| `tk_session` | Email of the currently logged-in user |
| `tk_pending_pay` | `{ email, nonce }` for an in-flight PayPal payment |

Passwords are hashed with SHA-256 before storage, but note the honest caveat: the salt is a fixed string in the source (`"tk|"`), there's no key stretching, and the hash sits in `localStorage` on the user's own device. It stops a shoulder-surfer reading a password; it is not meaningful security. Any real deployment with user accounts needs a backend.

Appeal history stores the full letter text, so a user's PCN details — including their name and vehicle registration — sit in plain text in their browser profile until they clear site data.

---

## Customising the site

**Brand colours and typography.** All theming is CSS custom properties at the top of the `<style>` block:

```css
:root {
  --navy: #071018;   /* page chrome, hero background */
  --blue: #1b6bff;   /* primary action colour */
  --gold: #e8b931;   /* accent, skip link, logo stroke */
  --paper: #f3f6fb;  /* page background */
  --line: #dce5f0;   /* borders and dividers */
  --radius: 18px;    /* corner rounding, cards and buttons */
}
```

Note that a second `:root` block right before `</style>` overrides `--font` and `--display` with a system-UI stack. The design tokens reference "Figtree" and "Bricolage Grotesque", but no web font is loaded, so the site renders in the system font. Delete that override and add a font `<link>` if you want the original typefaces.

**Adding or changing legal grounds.** Edit the `GROUNDS` array. Each entry needs `tag`, `title` and `body`; the card list, the count badge and the letter body all derive from it, so nothing else needs touching.

**Operator and contravention suggestions.** The autocomplete options are plain `<datalist>` elements (`operatorList`, `contraList`) in the ticket form markup — add `<option>`s there.

**Payments.** Swap the `business` hidden input for your own PayPal email, and update the amount across both forms and their button labels.

**Copy and legal wording.** The hero, steps, FAQ and footer disclaimer are all static markup in their sections. The footer's "Not legal advice" line and the closing sentence of every generated letter are the compliance-relevant bits — keep them if you fork this.

---

## Deploying

Because it's a static file, any host works. **GitHub Pages**, in order of least effort:

1. Push the repo to GitHub.
2. Settings → Pages → Source: *Deploy from a branch*.
3. Branch `main`, folder `/ (root)` → Save.
4. It goes live at `https://<user>.github.io/<repo>/` in a minute or two.

Also fine: Netlify, Cloudflare Pages, Vercel, or dropping `index.html` on any static host — all work with zero configuration.

Two things to fix first for a real launch:

- **Delete the trailing Cloudflare challenge script** (see [Known limitations](#known-limitations)). It only adds a hidden iframe and a failed request.
- **Check the PayPal business account** will accept payments and redirects to your live domain. The `return` and `cancel_return` URLs are generated from `location.href` at runtime, so the code needs no edits when the domain changes — but PayPal's account settings may.

Since the site is a single `index.html`, GitHub Pages serves it at the repo root with no configuration. A custom domain is a `CNAME` file (or a Pages setting) and needs no code change.

---

## Known limitations

Written down plainly so nothing here is a surprise later:

1. **No backend.** Accounts, sessions and appeal history are per-browser. Clearing site data destroys the account. The same "user" on a phone and a laptop are two unrelated accounts.
2. **Payments are not verified.** The app trusts the `?paypal=success` query parameter. Anyone can type it into the address bar and receive a free credit. Proper verification needs PayPal IPN or a webhook on a server comparing the amount and custom field against the pending record — this cannot be done client-side.
3. **The business email is hard-coded in the page source.** That exposes it to scrapers, and it appears twice.
4. **"65% of appeals succeed" and "12M tickets issued yearly"** are marketing copy in the hero. They have no source attached and should be substantiated (or removed) before running paid traffic to the page.
5. **Leftover Cloudflare script.** The last line before `</body>` is a Cloudflare bot-challenge snippet (`__CF$cv$params`) captured from wherever the original export came from. It's inert off Cloudflare and safe to delete.
6. **jsPDF is a single point of failure.** If cdnjs is blocked or offline, PDF export silently degrades to a print dialog. Vendoring the file locally would remove the dependency.
7. **No analytics or error tracking**, so there's no visibility into where users drop off.
8. **`index.html` is 1,665 lines** with CSS, markup and logic interleaved. That's fine at this size; if it grows, split it into `styles.css` and `app.js`, and move the grounds into a JSON file.

---

## Disclaimer

The site is provided for information only and does not constitute legal advice. It does not engage in reserved legal activity, does not lodge appeals on the user's behalf, and does not impersonate a solicitor. Parking charges issued by private companies are not criminal fines. Users should always check the dates, codes and instructions on their own notice.

No `LICENSE` file is currently included in this repository — add one before distributing or accepting contributions.
