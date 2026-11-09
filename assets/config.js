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
    tradingName: "TicketKiller UK",
    // Sole trader: your full name. Limited company: the company name.
    legalName: "",
    // A real postal address, or a service address if you are a sole trader.
    address: "",
    country: "United Kingdom",
    // Published on the legal pages and used by the contact form.
    email: "",
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
     Paying is enabled only when ALL of these are true:
       · paypal.enabled is true
       · business.legalName and business.email are filled in
       · paypal.verifyReturns is true (i.e. payments are verified)
     Otherwise every pay button is hidden and letters are unlimited.
     See "Payments" in README.md for why verifyReturns matters.     */
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
    email: "",
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
