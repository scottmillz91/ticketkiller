/* ============================================================
   TicketKiller UK — site configuration
   ------------------------------------------------------------
   Everything you are likely to want to change lives here.
   Edit this file, not the HTML or the app logic.
   ============================================================ */
window.TK_CONFIG = {
  /* ---------- Who you are (required by UK consumer law) ----------
     These four fields must be completed before you take any payment.
     Leave them blank and the site stays usable, but:
       · paying is switched off automatically
       · the privacy and terms pages stop claiming an unverified identity
     See "Before you take real money" in README.md.
     --------------------------------------------------------------- */
  business: {
    /* The product brand shown across the site. "SMAI" is the business you
       trade under; see businessName below. */
    tradingName: "TicketKiller UK",
    // Optional: the business name you trade under, if it differs from the
    // product brand. Shown alongside your legal name on the terms page.
    businessName: "SMAI",
    // Sole trader: your full name. Limited company: the company name.
    // REQUIRED before any money can be taken. Leaving this blank keeps
    // selling switched off, whatever the payments block below says.
    legalName: "Scott Mills",
    // Sole trader: a postal address where you can be reached. This is
    // published on the terms, privacy and contact pages, so it is public.
    address: "20 Heol Cledwyn, Birchgrove, Swansea, SA7 9LE",
    country: "United Kingdom",
    // Published on the legal pages and used by the contact form.
    email: "scottmills1791@gmail.com",
    // Optional: company number if you register a limited company.
    // Limited company only. Both are published on the terms and contact
    // pages, which the law requires — a company must state where it is
    // registered and its number.
    companyNumber: "",                   // e.g. "12345678"
    jurisdiction: "England and Wales",   // or "Scotland" / "Northern Ireland"

    // Only fill this in if you are genuinely VAT-registered.
    vatNumber: ""
  },

  /* ---------- Prices ---------- */
  pricing: {
    currency: "£",
    extraLetterPence: 499,      // £4.99
    extraLetterLabel: "4.99",
    symbol: "£"
  },

  /* ---------- Payments (Stripe Checkout) ----------
     Payments are handled by three Netlify functions under /api/.
     Stripe's secret key lives in Netlify's environment variables, never
     in this file — anything here is downloaded by every visitor.

     Paying is enabled only when ALL of these are true:
       · payments.provider is "stripe"
       · payments.enabled is true
       · payments.apiBase points at the deployed functions
       · business.legalName, address and email are filled in
     Otherwise every pay button is hidden and letters stay unlimited.

     Card details are entered on Stripe's own page. This site never sees
     them, which is why it stays out of PCI scope.                    */
  payments: {
    provider: "stripe",
    enabled: true,
    // Where the Netlify functions live. Set this after the first deploy,
    // e.g. "https://ticketkiller-payments.netlify.app". Empty means
    // "same origin", which is only correct when the site itself is on
    // Netlify rather than GitHub Pages.
    apiBase: "https://rococo-malasada-aa1a7f.netlify.app",
    // Kept in sync with PRICE_PENCE in netlify/functions/checkout.js.
    // The server is authoritative; this is only for display.
    pricePence: 499
  },

  /* ---------- Contact ---------- */
  contact: {
    /* Read in preference to business.email, and this is the address the
       public sees. Must be filled, or the site keeps selling switched off. */
    email: "scottmills1791@gmail.com",
    responseTime: "within 2 working days"
  },

  /* ---------- Analytics ----------
     Off by default. When enabled, page views and key events are
     POSTed to `endpoint` (any plausible-style collector) and are
     also kept in localStorage for debugging.                     */
  analytics: {
    enabled: false,
    endpoint: "",             // e.g. "https://plausible.io/api/event"
    domain: "",               // e.g. "ticketkiller.uk"
    respectDoNotTrack: true
  },

  /* ---------- Appeal timing defaults ----------
     These are the windows the deadline tracker counts down.
     `appealDays` is the fallback when the operator's own letter
     does not state a period. Users can override it per case.     */
  deadlines: {
    appealDays: 28,           // operator appeal window
    discountDays: 14,         // reduced-payment window
    poplaDays: 28,            // escalation window after rejection
    pofaNtkDays: 14,          // POFA Sch 4 para 9 (no windscreen ticket)
    pofaNtdMinDays: 28,       // POFA Sch 4 para 8 lower bound
    pofaNtdMaxDays: 56        // POFA Sch 4 para 8 upper bound
  },

  /* ---------- Feature switches ---------- */
  features: {
    deadlineTracker: true,
    evidenceRequest: true,
    escalation: true,
    operatorIntel: true,
    sampleLetter: true,
    seoLandingPages: true
  },

  version: "2.0.0"
};
