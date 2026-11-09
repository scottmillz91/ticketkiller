/* ============================================================
   TicketKiller UK — site configuration
   ------------------------------------------------------------
   Everything you are likely to want to change lives here.
   Edit this file, not the HTML or the app logic.
   ============================================================ */
window.TK_CONFIG = {
  /* ---------- Who you are (required by UK consumer law) ---------- */
  business: {
    tradingName: "TicketKiller UK",
    // If you are a sole trader, put your full name here.
    legalName: "[YOUR FULL LEGAL NAME]",
    // A real postal address or, for sole traders, a service address.
    address: "[YOUR POSTAL ADDRESS]",
    country: "United Kingdom",
    // This address is published on the legal pages and used by the contact form.
    email: "support@example.com",
    // Optional: company number if you register a limited company.
    companyNumber: "",
    vatNumber: ""
  },

  /* ---------- Prices ---------- */
  pricing: {
    currency: "£",
    extraLetterPence: 499,      // £4.99
    extraLetterLabel: "4.99",
    symbol: "£"
  },

  /* ---------- Payments (PayPal _xclick) ----------
     Set `enabled: false` to hide every pay button and make
     letters unlimited while you are still testing.             */
  paypal: {
    enabled: true,
    business: "mrmillz1991@gmail.com",
    itemName: "TicketKiller UK extra appeal",
    // PayPal cannot verify a return URL client-side. Leave this false
    // and read the warning in README.md before taking real money.
    verifyReturns: false
  },

  /* ---------- Contact ---------- */
  contact: {
    email: "support@example.com",
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
