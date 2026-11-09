/* ============================================================
   TicketKiller UK — application logic (v2)
   ------------------------------------------------------------
   No framework, no build step. Reads window.TK_CONFIG from
   assets/config.js and content from assets/data/*.json.
   ============================================================ */
(() => {
  "use strict";

  const CFG = window.TK_CONFIG || {};
  const D = CFG.deadlines || { appealDays: 28, discountDays: 14, poplaDays: 28, pofaNtkDays: 14, pofaNtdMinDays: 28, pofaNtdMaxDays: 56 };
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const USERS_KEY = "tk_users_v1";
  const SESSION_KEY = "tk_session";
  const PENDING_KEY = "tk_pending_pay";
  const HELD_KEY = "tk_held_credits";
  const STATE_KEY = "tk_state_v1";

  const state = {
    operators: [],
    grounds: [],
    escalation: [],
    selectedGrounds: new Set(),
    draft: {},
    afterLogin: "details",
    viewedAppealId: null
  };

  /* ---------------------------------------------------------
     Small helpers
     --------------------------------------------------------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const val = (id) => ($(id) ? $(id).value.trim() : "");
  const setVal = (id, v) => { if ($(id)) $(id).value = v == null ? "" : v; };

  function dayKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0, 10);
  }
  function parseDay(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  }
  function todayUTC() {
    const n = new Date();
    return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 12));
  }
  function addDays(d, n) {
    const c = new Date(d.getTime());
    c.setUTCDate(c.getUTCDate() + n);
    return c;
  }
  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }
  function longDate(d) {
    if (!d) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  }
  function niceInputDate(s) {
    const d = parseDay(s);
    return d ? longDate(d) : (s || "[date]");
  }

  /* ---------------------------------------------------------
     Readiness: what can honestly be shown or sold yet
     --------------------------------------------------------- */
  const READY = (() => {
    const b = CFG.business || {};
    /* A value only counts as real if it is present, is not a bracketed
       placeholder, and is not one of the TODO stubs shipped in config.js.
       Without the TODO check the stub strings would pass as a real identity
       and unlock selling on an unconfigured deployment. */
    const filled = (v) => {
      const t = typeof v === "string" ? v.trim() : "";
      if (!t || /^[\[<]/.test(t)) return false;
      if (/^TODO\b/i.test(t)) return false;
      if (/^your |^you@|example\.(com|org|net)$/i.test(t)) return false;
      return true;
    };
    const contactEmail = (CFG.contact && CFG.contact.email) || b.email || "";
    return {
      hasLegalName: filled(b.legalName),
      hasAddress: filled(b.address),
      hasEmail: filled(contactEmail) && !/example\.(com|org|net)$/i.test(contactEmail),
      contactEmail,
      get hasOperator() {
        return this.hasLegalName && this.hasAddress && this.hasEmail;
      },
      /* Registered-company details, kept separate from hasOperator so a
         sole trader is never prompted for a company number. */
      get hasCompany() {
        const b = CFG.business || {};
        return this.hasLegalName && filled(b.companyNumber);
      },
      // Money may only move when we can identify the seller AND the payment
      // state can be confirmed by the server. client-only payment is a bug,
      // not a shortcut: the return URL proves nothing.
      get canSell() {
        const pay = CFG.payments || {};
        return pay.provider === "stripe" && pay.enabled === true && this.hasOperator;
      },
      get payEndpoint() {
        const base = String((CFG.payments && CFG.payments.apiBase) || "").replace(/\/$/, "");
        return base ? `${base}/api` : "/api";
      }
    };
  })();

  /* ---------------------------------------------------------
     Storage — degrades to memory if localStorage is blocked
     --------------------------------------------------------- */
  const memStore = new Map();
  const store = {
    get(k) {
      try { return localStorage.getItem(k); } catch { return memStore.has(k) ? memStore.get(k) : null; }
    },
    set(k, v) {
      try { localStorage.setItem(k, v); } catch { memStore.set(k, v); }
    },
    del(k) {
      try { localStorage.removeItem(k); } catch { memStore.delete(k); }
    }
  };

  function users() {
    try { return JSON.parse(store.get(USERS_KEY) || "{}"); } catch { return {}; }
  }
  function saveUsers(map) { store.set(USERS_KEY, JSON.stringify(map)); }
  function sessionEmail() { return store.get(SESSION_KEY) || ""; }
  function currentUser() {
    const e = sessionEmail();
    return e ? users()[e] || null : null;
  }
  function saveUser(u) {
    const map = users();
    map[u.email] = u;
    saveUsers(map);
  }
  async function hashPass(pw) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tk|${pw}`));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // Non-secure context fallback: clearly marked, never presented as secure.
      return `plainfallback:${pw}`;
    }
  }

  /* ---------------------------------------------------------
     Analytics (off unless enabled in config)
     --------------------------------------------------------- */
  const analytics = {
    get on() {
      return !!(CFG.analytics && CFG.analytics.enabled);
    },
    track(event, props = {}) {
      if (!this.on) return;
      if (CFG.analytics.respectDoNotTrack && navigator.doNotTrack === "1") return;
      const payload = {
        name: event,
        domain: CFG.analytics.domain || location.hostname,
        url: location.pathname + location.hash,
        props,
        ts: new Date().toISOString()
      };
      try {
        const log = JSON.parse(store.get("tk_events") || "[]");
        log.push(payload);
        store.set("tk_events", JSON.stringify(log.slice(-200)));
      } catch { /* ignore */ }
      if (CFG.analytics.endpoint) {
        try {
          fetch(CFG.analytics.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true
          }).catch(() => {});
        } catch { /* ignore */ }
      }
    }
  };
  window.TK_EVENTS = () => JSON.parse(store.get("tk_events") || "[]");

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */
  /* An optional action renders as a button inside the toast. Used for undo,
     which is more reliable than a timed window: the user has to decide. */
  function toast(msg, action) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-action";
      btn.textContent = "Undo";
      btn.addEventListener("click", () => {
        el.hidden = true;
        el.removeAttribute("data-show");
        clearTimeout(toast._t);
        action();
      });
      el.appendChild(btn);
    }
    el.hidden = false;
    el.setAttribute("data-show", "1");
    clearTimeout(toast._t);
    /* Longer when there is something to act on. */
    toast._t = setTimeout(() => { el.hidden = true; el.removeAttribute("data-show"); }, action ? 6000 : 2800);
  }

  /* ---------------------------------------------------------
     Content loading
     --------------------------------------------------------- */
  async function loadContent() {
    const [ops, gnd] = await Promise.all([
      fetch("assets/data/operators.json").then((r) => r.json()).catch(() => ({ operators: [] })),
      fetch("assets/data/grounds.json").then((r) => r.json()).catch(() => ({ grounds: [], escalation: [] }))
    ]);
    state.operators = ops.operators || [];
    state.grounds = gnd.grounds || [];
    state.escalation = gnd.escalation || [];
    state.selectedGrounds = new Set(state.grounds.map((g) => g.id));
  }

  function findOperator(name) {
    const q = String(name || "").toLowerCase().trim();
    if (!q) return null;
    return state.operators.find((o) =>
      o.name.toLowerCase() === q ||
      q.includes(o.name.toLowerCase().split(" ltd")[0].trim()) ||
      (o.aliases || []).some((a) => q.includes(a))
    ) || null;
  }

  /* ---------------------------------------------------------
     Deadline maths
     --------------------------------------------------------- */
  function computeDeadlines() {
    const noticeDate = parseDay(val("fDate")) || todayUTC();
    const appealDays = parseInt(val("fAppealDays") || D.appealDays, 10) || D.appealDays;
    const discountDays = parseInt(val("fDiscountDays") || D.discountDays, 10) || D.discountDays;
    const ticketType = val("fTicketType") || "anpr";
    const ntkDate = parseDay(val("fNtkDate"));

    const appealBy = addDays(noticeDate, appealDays);
    const discountBy = addDays(noticeDate, discountDays);
    const today = todayUTC();

    const out = {
      noticeDate,
      appealBy,
      discountBy,
      appealLeft: daysBetween(today, appealBy),
      discountLeft: daysBetween(today, discountBy),
      totalAppealDays: appealDays,
      totalDiscountDays: discountDays,
      ticketType
    };

    if (ntkDate) {
      const ntkGap = daysBetween(noticeDate, ntkDate);
      out.ntkGap = ntkGap;
      if (ticketType === "anpr") {
        out.pofaCompliant = ntkGap <= D.pofaNtkDays;
        out.pofaNote = out.pofaCompliant
          ? `Notice to Keeper arrived ${ntkGap} day(s) after the parking date — inside the 14-day limit. That ground is weak for this case.`
          : `Notice to Keeper arrived ${ntkGap} day(s) after the parking date — outside the 14-day limit. Keeper liability is likely not established.`;
      } else {
        out.pofaCompliant = ntkGap >= D.pofaNtdMinDays && ntkGap <= D.pofaNtdMaxDays;
        out.pofaNote = out.pofaCompliant
          ? `Notice to Keeper arrived ${ntkGap} day(s) after the windscreen ticket — inside the 28-to-56-day window.`
          : `Notice to Keeper arrived ${ntkGap} day(s) after the windscreen ticket — outside the 28-to-56-day window. Keeper liability may not be established.`;
      }
    } else {
      out.pofaNote = ticketType === "anpr"
        ? "Add the date the Notice to Keeper reached you to test the 14-day POFA limit."
        : "Add the date the Notice to Keeper reached you to test the 28-to-56-day window.";
    }
    return out;
  }

  function bandClass(days) {
    if (days < 0) return "past";
    if (days <= 3) return "crit";
    if (days <= 7) return "warn";
    return "ok";
  }

  function renderDeadlines() {
    if (!CFG.features || CFG.features.deadlineTracker === false) return;
    const box = $("deadlineOut");
    if (!box) return;
    const d = computeDeadlines();

    const appealText = d.appealLeft < 0
      ? `Passed ${Math.abs(d.appealLeft)} day(s) ago`
      : `${d.appealLeft} day${d.appealLeft === 1 ? "" : "s"} left`;

    const discountText = d.discountLeft < 0
      ? "Reduced rate window closed"
      : `${d.discountLeft} day${d.discountLeft === 1 ? "" : "s"} left`;

    const pct = Math.max(0, Math.min(100, Math.round(((d.totalAppealDays - d.appealLeft) / d.totalAppealDays) * 100)));
    const barClass = d.appealLeft < 0 ? "out" : d.appealLeft <= 7 ? "low" : "";

    box.innerHTML = `
      <div class="cd-row">
        <div class="cd-box ${bandClass(d.appealLeft)}">
          <div class="cd-label">Appeal to the operator by</div>
          <div class="cd-num">${esc(appealText)}</div>
          <div class="cd-sub">${esc(longDate(d.appealBy))}</div>
        </div>
        <div class="cd-box ${bandClass(d.discountLeft)}">
          <div class="cd-label">Reduced rate ends</div>
          <div class="cd-num">${esc(discountText)}</div>
          <div class="cd-sub">${esc(longDate(d.discountBy))}</div>
        </div>
      </div>
      <div class="cd-foot">
        ${d.appealLeft >= 0
          ? `Day ${d.totalAppealDays - d.appealLeft} of ${d.totalAppealDays}. Appeal now — a late appeal is much harder to win.`
          : `The operator's appeal window appears to have closed. You may still write, but raise the delay and ask them to consider it.`}
        <div class="bar ${barClass}"><i style="width:${pct}%"></i></div>
        <p style="margin:10px 0 0">${esc(d.pofaNote)}</p>
        <p style="margin:6px 0 0"><strong>Check your own notice.</strong> Operators quote different periods (14, 21 or 28 days); the date on your letter always wins.</p>
      </div>
    `;
    $("deadlineCard").hidden = false;
  }

  /* ---------------------------------------------------------
     Navigation / routing
     --------------------------------------------------------- */
  const PAGES = ["home", "auth", "history", "details", "evidence", "results", "pricing", "faq", "operators", "guide", "privacy", "terms", "refunds", "contact", "stats"];

  const PAGE_TITLES = {
    home: ["TicketKiller UK — Appeal a Private Parking Ticket in 2 Minutes", "Legal grounds, a formal appeal letter and a deadline tracker for UK private parking charges. First appeal free."],
    auth: ["Log in or create an account — TicketKiller UK", "Log in to generate appeal letters and see your previous appeals."],
    history: ["Your appeals — TicketKiller UK", "Every letter you have generated, with its deadline still counting down."],
    details: ["Enter your ticket details — TicketKiller UK", "Copy the details off your PCN and see your appeal deadline instantly."],
    evidence: ["Request the evidence — TicketKiller UK", "Draft a UK GDPR Article 15 request for the ANPR stills, signage and landowner contract."],
    results: ["Your grounds and letter — TicketKiller UK", "The grounds that apply to your notice, plus a formal appeal letter you can copy or download."],
    pricing: ["Pricing — TicketKiller UK", "First appeal free, then £4.99 per letter. No subscription."],
    faq: ["Frequently asked questions — TicketKiller UK", "Deadlines, POPLA and IAS escalation, keeper liability and the new Code of Practice."],
    operators: ["Operator intelligence — TicketKiller UK", "What usually decides appeals against each private parking operator."],
    guide: ["Appeal guides by operator — TicketKiller UK", "How to appeal a parking charge from a specific operator, step by step."],
    stats: ["The data behind the claims — TicketKiller UK", "Every figure we quote, with its source and what it does not prove."],
    privacy: ["Privacy notice — TicketKiller UK", "What this site stores, where it is stored, and your rights."],
    terms: ["Terms of use — TicketKiller UK", "The basis on which this drafting tool is provided."],
    refunds: ["Refund policy — TicketKiller UK", "When we refund a paid letter, and your digital-content cancellation rights."],
    contact: ["Contact — TicketKiller UK", "Questions about a letter, a payment or your data."]
  };

  function setPageMeta(page, opts = {}) {
    const entry = PAGE_TITLES[page];
    if (entry) {
      document.title = entry[0];
      const md = document.querySelector('meta[name="description"]');
      if (md) md.setAttribute("content", entry[1]);
      const ogt = document.querySelector('meta[property="og:title"]');
      if (ogt) ogt.setAttribute("content", entry[0]);
    }

    /* Operator guides are the pages people arrive on from a search, so each
       gets its own preview card and a canonical that matches what is in the
       address bar. Left alone, every page shared one card and every page
       claimed to be the home page. */
    const guide = page === "guide" ? (opts.guide || opts.hash || "") : "";
    const slug = guide && GUIDE_SLUGS.includes(guide) ? guide : "";
    const base = "https://scottmillz91.github.io/ticketkiller/";

    const setMeta = (sel, attr, value) => {
      const el = document.querySelector(sel);
      if (el && value) el.setAttribute(attr, value);
    };

    if (slug) {
      const g = GUIDES.find((x) => x.slug === slug);
      const title = `How to appeal a ${g.operator} parking charge — TicketKiller UK`;
      const desc = `The appeal route, the deadline that applies to ${g.operator}, and the grounds that most often decide these cases. First appeal free.`;
      const url = `${base}#guide/${slug}`;
      if (entry) {
        document.title = title;
        setMeta('meta[name="description"]', "content", desc);
        setMeta('meta[property="og:title"]', "content", title);
        setMeta('meta[property="og:description"]', "content", desc);
        setMeta('meta[name="twitter:title"]', "content", title);
        setMeta('meta[name="twitter:description"]', "content", desc);
      }
      setMeta('link[rel="canonical"]', "href", url);
      setMeta('meta[property="og:url"]', "content", url);
      const img = `${base}assets/og/guide-${slug}.jpg`;
      setMeta('meta[property="og:image"]', "content", img);
      setMeta('meta[name="twitter:image"]', "content", img);
    } else {
      /* Back to the site default, so a guide card never leaks onto another
         page after client-side navigation. */
      setMeta('link[rel="canonical"]', "href", base);
      setMeta('meta[property="og:url"]', "content", base);
      const img = `${base}assets/og-image.jpg`;
      setMeta('meta[property="og:image"]', "content", img);
      setMeta('meta[name="twitter:image"]', "content", img);
    }
  }

  function showPage(name, opts = {}) {
    if (!PAGES.includes(name)) name = "home";
    if ((name === "details" || name === "history" || name === "evidence") && !currentUser()) {
      state.afterLogin = name;
      name = "auth";
    }
    $$(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === name));
    setPageMeta(name, opts);
    document.body.classList.remove("nav-open");
    const nav = $("mobileNav");
    if (nav) nav.setAttribute("hidden", "");
    const mb = $("menuBtn");
    if (mb) { mb.setAttribute("aria-expanded", "false"); mb.setAttribute("aria-label", "Open menu"); }

    if (name === "details") {
      syncPaywall(); renderDeadlines(); renderOperatorIntel(); updateFormProgress();
      /* The cards above the form decide where the bar rests, and they are
         filled in on this same tick. Measure once they are settled. */
      requestAnimationFrame(pinFormProgress);
    }
    else { setProgressPinned(false); }
    if (name === "evidence") renderEvidence();
    if (name === "history") renderHistory();
    if (name === "operators") renderOperatorGrid();
    if (name === "guide") renderGuide(opts.guide || opts.hash || "index");
    if (name === "stats") renderStats();

    if (opts.hash) {
      history.replaceState({}, "", `#${name}/${opts.hash}`);
    } else {
      history.replaceState({}, "", `#${name}`);
    }
    window.scrollTo({ top: 0, behavior: opts.instant ? "auto" : "smooth" });
    analytics.track("page_view", { page: name });
  }

  function syncNav() {
    const u = currentUser();
    const label = u ? "Log out" : "Log in";
    ["navAuth", "navAuthMobile"].forEach((id) => { if ($(id)) $(id).textContent = label; });
  }

  /* ---------------------------------------------------------
     Paywall / credits
     --------------------------------------------------------- */
  function usedFree(u) { return !!(u.freeUsed || (u.appeals && u.appeals.length)); }
  function canGenerate() {
    if (!READY.canSell) return !!currentUser();
    const u = currentUser();
    if (!u) return false;
    return !usedFree(u) || (u.credits || 0) > 0;
  }
  function consumeGenerate() {
    const u = currentUser();
    if (!u) return;
    if (!usedFree(u)) u.freeUsed = true;
    else u.credits = Math.max(0, (u.credits || 0) - 1);
    saveUser(u);
  }
  /* Adds one paid letter to an account. Returns true only when a credit was
     actually stored, so the caller never reports success on a no-op.

     Two cases matter. If the buyer logged out before returning from Stripe,
     the payment is held and applied the moment that email signs in, rather
     than being lost. If the email matches nothing at all, the purchase is
     still recorded so it can be honoured by hand. */
  function grantPaidCredit(email) {
    const map = users();
    if (!email) return false;
    if (!map[email]) {
      /* Hold it against the address until that account exists. */
      let held = {};
      try { held = JSON.parse(store.get(HELD_KEY) || "{}"); } catch { held = {}; }
      held[email] = (held[email] || 0) + 1;
      store.set(HELD_KEY, JSON.stringify(held));
      store.del(PENDING_KEY);
      return false;
    }
    map[email].credits = (map[email].credits || 0) + 1;
    saveUsers(map);
    store.del(PENDING_KEY);
    return true;
  }

  /* Called after a login or sign-up, so a held payment is not stranded. */
  function applyHeldCredits(email) {
    if (!email) return 0;
    let held = {};
    try { held = JSON.parse(store.get(HELD_KEY) || "{}"); } catch { return 0; }
    const n = held[email] || 0;
    if (!n) return 0;
    const map = users();
    if (!map[email]) return 0;
    map[email].credits = (map[email].credits || 0) + n;
    saveUsers(map);
    delete held[email];
    store.set(HELD_KEY, JSON.stringify(held));
    return n;
  }
  function syncPaywall() {
    const pane = $("paywallPane");
    const btn = $("generateBtn");
    if (!pane || !btn) return;
    const locked = !!currentUser() && !canGenerate();
    const price = `${CFG.pricing ? CFG.pricing.symbol : "£"}${CFG.pricing ? CFG.pricing.extraLetterLabel : "4.99"}`;
    pane.hidden = !locked || !READY.canSell;

    /* Regression: this used to relabel the button "Pay £4.99 to generate
       another" and then disable it. A disabled button fires no click at all,
       so tapping the only payment call-to-action in the flow did precisely
       nothing — no toast, no scroll, no navigation. The button is the money
       path; it must never be inert. */
    btn.disabled = false;
    btn.textContent = locked
      ? `Buy another letter for ${price}`
      : "Generate appeal letter";
    btn.dataset.intent = locked ? "pay" : "generate";
  }

  /* ---------------------------------------------------------
     Operator intel
     --------------------------------------------------------- */
  function renderOperatorIntel() {
    const host = $("intelCard");
    if (!host) return;
    if (!CFG.features || CFG.features.operatorIntel !== false) {
      const op = findOperator(val("fOperator"));
      if (!op) {
        host.innerHTML = `<h3>Operator intelligence</h3>
          <p class="intel-empty">Start typing the operator's name and we'll show what usually decides appeals against them.</p>`;
      } else {
        host.innerHTML = `
          <h3>${esc(op.name)}</h3>
          <div class="intel-meta">${esc(op.tradeBody)} operator · ${esc(op.siteType)}</div>
          <ul>${op.themes.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
          <p class="intel-empty" style="margin-top:10px">Rejected appeals against ${esc(op.tradeBody === "BPA" ? "BPA" : "IPC")} operators escalate to ${esc(op.tradeBody === "BPA" ? "POPLA" : "the IAS")}.</p>
        `;
      }
    }
  }

  function renderOperatorGrid() {
    const host = $("opGrid");
    if (!host) return;
    host.innerHTML = state.operators.map((o) => `
      <article class="op-card">
        <span class="op-badge ${o.tradeBody === "IPC" ? "ipc" : ""}">${esc(o.tradeBody)}</span>
        <h3>${esc(o.name)}</h3>
        <p style="font-size:13px;color:var(--muted);margin:0">${esc(o.siteType)}</p>
        <ul>${o.themes.slice(0, 2).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
        <button class="mini-btn" style="margin-top:10px" data-start-op="${esc(o.name)}">Use this operator</button>
      </article>
    `).join("");
    $$("[data-start-op]", host).forEach((b) => b.addEventListener("click", () => {
      setVal("fOperator", b.getAttribute("data-start-op"));
      renderOperatorIntel();
      showPage(currentUser() ? "details" : "auth");
      if (!currentUser()) state.afterLogin = "details";
      analytics.track("operator_selected", { operator: b.getAttribute("data-start-op") });
    }));
  }

  /* ---------------------------------------------------------
     Details form <-> draft persistence
     --------------------------------------------------------- */
  const FIELD_IDS = ["fOperator", "fRef", "fDate", "fLocation", "fContra", "fAmount", "fVrm", "fName", "fAddress", "fPostcode", "fAppealDays", "fDiscountDays", "fTicketType", "fNtkDate"];

  function saveDraft() {
    const d = {};
    FIELD_IDS.forEach((id) => { if ($(id)) d[id] = $(id).value; });
    state.draft = d;
    store.set(STATE_KEY, JSON.stringify(d));
  }
  function loadDraft() {
    try {
      const d = JSON.parse(store.get(STATE_KEY) || "{}");
      state.draft = d;
      FIELD_IDS.forEach((id) => { if ($(id) && d[id] != null) $(id).value = d[id]; });
    } catch { /* ignore */ }
    const u = currentUser();
    if (u && $("fName") && !$("fName").value) $("fName").value = u.name || "";
    if (u && $("fAddress") && !$("fAddress").value) $("fAddress").value = u.address || "";
    if (u && $("fPostcode") && !$("fPostcode").value) $("fPostcode").value = u.postcode || "";
  }

  /* ---------------------------------------------------------
     Ground selection
     --------------------------------------------------------- */
  function activeGrounds() {
    return state.grounds.filter((g) => state.selectedGrounds.has(g.id));
  }

  /* ---------------------------------------------------------
     Letter builders
     --------------------------------------------------------- */
  function letterContext() {
    const d = computeDeadlines();
    const opName = val("fOperator") || "[Operator]";
    return {
      name: val("fName") || (currentUser() && currentUser().name) || "[Your name]",
      address: val("fAddress") || "[Your address]",
      postcode: val("fPostcode") || "[Your postcode]",
      operator: opName,
      operatorData: findOperator(opName),
      ref: val("fRef") || "[PCN reference]",
      date: niceInputDate(val("fDate")),
      location: val("fLocation") || "[location]",
      contra: val("fContra") || "[alleged contravention]",
      amount: val("fAmount") || "[amount]",
      vrm: (val("fVrm") || "[VRM]").toUpperCase(),
      today: longDate(todayUTC()),
      deadlines: d
    };
  }

  function buildLetter() {
    const c = letterContext();
    const grounds = activeGrounds();
    const groundsText = grounds.length
      ? grounds.map((g, i) => `${i + 1}. ${g.title} (${g.tag})\n${g.body}`).join("\n\n")
      : "1. [No grounds selected — choose at least one on the results page.]";

    const route = c.operatorData
      ? (c.operatorData.tradeBody === "BPA" ? "POPLA" : "IAS")
      : "POPLA or the IAS";

    const d = c.deadlines;
    const timingLine = d.ntkGap != null
      ? `Your Notice to Keeper reached me ${d.ntkGap} day(s) after the parking date.`
      : "";

    return `${c.name}
${c.address}
${c.postcode}

${c.today}

Appeals Team
${c.operator}

Without prejudice

Dear Sir or Madam,

Re: Formal appeal — Parking Charge Notice ${c.ref}
Vehicle registration: ${c.vrm}
Location: ${c.location}
Date of alleged contravention: ${c.date}
Alleged contravention: ${c.contra}
Amount demanded: ${c.amount}

I write as the registered keeper of the vehicle above. I dispute this parking charge in full and I do not accept liability. I am not the driver your client contracted with, and I decline to identify the driver.

I require you to cancel this charge. If you refuse, please issue a valid ${route} code with your rejection, together with an explanation of the evidence you rely on.

The grounds of appeal are as follows.

${groundsText}

${timingLine ? `Timing of the notice
${timingLine} I invite you to confirm the date of posting and the date of delivery you rely on.\n\n` : ""}Further points

• I require compliance with Schedule 4 of the Protection of Freedoms Act 2012 if you intend to pursue me as keeper. If any statutory condition is unmet, keeper liability does not arise.
• Please provide: the full ANPR or officer evidence pack; contemporaneous signage photographs and the site plan; proof of landowner authority to issue charges in your own name; and the exact entry and exit timestamps to the second.
• Do not add debt-recovery fees while this appeal, or any subsequent independent appeal, remains outstanding.
• Please treat this letter as a data subject request under UK GDPR to the extent it concerns my personal data, and confirm what you hold about me.

I look forward to written confirmation of cancellation within 35 days.

Yours faithfully,

${c.name}
Registered keeper

--
Generated with TicketKiller UK on ${c.today}. This is a drafting aid, not legal advice. Always check the dates, codes and wording against your own notice.`;
  }

  function buildEscalation() {
    const c = letterContext();
    const route = c.operatorData
      ? (c.operatorData.tradeBody === "BPA" ? "POPLA" : "IAS")
      : "POPLA or the IAS";
    const code = val("fPoplaCode") || "[POPLA / IAS code from your rejection letter]";
    const grounds = state.escalation.map((g, i) => `${i + 1}. ${g.title}\n${g.body}`).join("\n\n");

    return `${c.name}
${c.address}
${c.postcode}

${c.today}

${route === "IAS" ? "The Independent Appeals Service (IAS)" : "Parking on Private Land Appeals (POPLA)"}
PO Box 1270
Warrington
WA4 9RL

Re: Independent appeal — Parking Charge Notice ${c.ref}
Verification code: ${code}
Vehicle registration: ${c.vrm}
Operator: ${c.operator}
Location: ${c.location}
Date of alleged contravention: ${c.date}
Amount demanded: ${c.amount}

Dear Assessor,

I appeal against the operator's decision to reject my representations and to refuse to cancel this parking charge.

Summary

I am the registered keeper. I disputed the charge on ${c.date} grounds set out in my appeal of the same date. The operator's rejection did not answer the substance of those points. I ask you to allow this appeal and direct that the charge be cancelled.

Grounds

${grounds}

Evidence I rely on

• My original representations to the operator, dated on or about the period stated above.
• The Notice to Keeper and any rejection letter, including the date each was received.
• The absence of the evidence the operator was asked to provide, or its late provision at this stage.

What I am asking you to decide

1. Whether the operator has established a contractual term that was brought to the driver's attention by adequate signage at the site.
2. Whether the operator has complied with Schedule 4 of the Protection of Freedoms Act 2012, as to both timing and prescribed content, if it seeks to hold me liable as keeper.
3. Whether the charge is a proportionate means of managing this site, applying ParkingEye Ltd v Beavis [2015] UKSC 67 to the facts here.

I have not named the driver and no obligation to do so arises.

Yours faithfully,

${c.name}
Registered keeper

--
Generated with TicketKiller UK on ${c.today}. This is a drafting aid, not legal advice. Check your verification code and deadlines on the rejection letter itself.`;
  }

  function buildEvidenceRequest() {
    const c = letterContext();
    const route = c.operatorData
      ? (c.operatorData.tradeBody === "BPA" ? "POPLA" : "IAS")
      : "POPLA or the IAS";
    const items = $$("#evidenceList input[type=checkbox]").filter((i) => i.checked).map((i) => i.dataset.label);

    return `${c.name}
${c.address}
${c.postcode}

${c.today}

Data Protection / Appeals Team
${c.operator}

Dear Sir or Madam,

Re: Request for evidence and personal data
Parking Charge Notice: ${c.ref}
Vehicle registration: ${c.vrm}
Date of alleged contravention: ${c.date}

I am the registered keeper and the subject of the personal data you hold in connection with this parking charge.

I request the following, both as evidence for my appeal and as a request for my personal data under Article 15 UK GDPR:

${items.map((i, n) => `${n + 1}. ${i}`).join("\n")}

Please provide these within one month, as required by UK GDPR Article 12(3). Where you withhold any document, please state the specific exemption you rely on.

I also remind you that, as a member of an accredited trade association, you are expected to provide the evidence you rely on rather than describe it. If you refuse this request, I will ask ${route} to draw an adverse inference at adjudication.

If you do not intend to pursue this charge, please confirm cancellation by return so that no further request is necessary.

Yours faithfully,

${c.name}
Registered keeper

--
Generated with TicketKiller UK on ${c.today}. This is a drafting aid, not legal advice.`;
  }

  /* ---------------------------------------------------------
     Results page
     --------------------------------------------------------- */
  function renderGrounds() {
    const host = $("weakList");
    if (!host) return;
    host.innerHTML = state.grounds.map((g) => {
      const on = state.selectedGrounds.has(g.id);
      return `
      <li class="${on ? "" : "ground-off"}" data-ground="${esc(g.id)}">
        <span class="law-tag">${esc(g.tag)}</span>
        <h3>${esc(g.title)}</h3>
        <p>${esc(g.body)}</p>
        <div class="ground-when">
          <span class="ground-when-label">Applies if</span>
          <span>${esc(g.when)}</span>
        </div>
        <div class="ground-actions">
          <button class="mini-btn ground-toggle" type="button" aria-pressed="${on}" data-toggle-ground="${esc(g.id)}">${on ? "Included in letter" : "Excluded"}</button>
        </div>
      </li>`;
    }).join("");
    const n = state.selectedGrounds.size;
    const total = state.grounds.length;
    const badge = $("weakCount");
    if (badge) {
      badge.textContent = n === total ? `All ${total} included` : `${n} of ${total} included`;
      /* Nought included is not an error, but it does mean the letter has
         nothing to argue, so it is worth flagging before a copy. */
      badge.className = n === 0 ? "badge is-none" : "badge";
    }
    $$("[data-toggle-ground]", host).forEach((b) => b.addEventListener("click", () => {
      const id = b.getAttribute("data-toggle-ground");
      if (state.selectedGrounds.has(id)) state.selectedGrounds.delete(id);
      else state.selectedGrounds.add(id);
      renderGrounds();
      refreshLetters();
    }));
  }

  function refreshLetters() {
    if ($("letterText")) $("letterText").textContent = buildLetter();
    if ($("escalationText")) $("escalationText").textContent = buildEscalation();
  }

  function renderAppeal() {
    renderGrounds();
    refreshLetters();
    renderDeadlineSummary();
  }

  function renderDeadlineSummary() {
    const host = $("resultDeadline");
    if (!host) return;
    const d = computeDeadlines();
    const cls = bandClass(d.appealLeft);
    const text = d.appealLeft < 0
      ? `Operator appeal window appears closed (${Math.abs(d.appealLeft)} days ago)`
      : `${d.appealLeft} day${d.appealLeft === 1 ? "" : "s"} left to appeal · deadline ${longDate(d.appealBy)}`;
    host.className = `cd-pill ${cls}`;
    host.textContent = text;

    /* Name the charge above the grounds, so it is obvious which appeal the
       letter being edited belongs to. */
    const forEl = $("resultFor");
    if (!forEl) return;
    const parts = [];
    const op = val("fOperator");
    const ref = val("fRef");
    const vrm = val("fVrm");
    if (op) parts.push(`<strong>${esc(op)}</strong>`);
    if (ref) parts.push(esc(ref));
    if (vrm) parts.push(`<span class="history-vrm">${esc(vrm.toUpperCase())}</span>`);
    forEl.innerHTML = parts.length
      ? `${parts.join(' <span class="dot">·</span> ')}<br><span>Turn grounds on or off and the letter updates.</span>`
      : "Turn grounds on or off and the letter updates. Then copy or download it.";
  }

  /* ---------------------------------------------------------
     Appeal history
     --------------------------------------------------------- */
  function saveCurrentAppeal() {
    const u = currentUser();
    if (!u) return null;
    const item = {
      id: Date.now().toString(36),
      created: new Date().toISOString(),
      operator: val("fOperator"),
      ref: val("fRef"),
      date: val("fDate"),
      location: val("fLocation"),
      contra: val("fContra"),
      amount: val("fAmount"),
      vrm: val("fVrm").toUpperCase(),
      letter: buildLetter(),
      deadline: dayKey(computeDeadlines().appealBy),
      status: "draft",
      grounds: [...state.selectedGrounds]
    };
    u.appeals = u.appeals || [];
    u.appeals.unshift(item);
    saveUser(u);
    return item;
  }

  function appealStatus(u, a) {
    if (a.status === "won" || a.status === "lost" || a.status === "escalated") return a.status;
    const dl = parseDay(a.deadline);
    if (dl && daysBetween(todayUTC(), dl) < 0) return "expired";
    return "open";
  }

  /* Human wording for an appeal's state. "open" is derived from the stored
     deadline rather than persisted, so a draft ages into "window closed" by
     itself instead of sitting there saying it is still live. */
  const STATUS_LABEL = {
    open: ["Open", "ok"],
    won: ["Won", "ok"],
    lost: ["Lost", "crit"],
    escalated: ["Escalated", "warn"],
    expired: ["Window closed", "crit"]
  };

  function appealPill(u, a) {
    const st = appealStatus(u, a);
    const [label] = STATUS_LABEL[st] || STATUS_LABEL.open;
    if (st !== "open") return `<span class="cd-pill ${STATUS_LABEL[st][1]}">${label}</span>`;
    const dl = parseDay(a.deadline);
    const days = dl ? daysBetween(todayUTC(), dl) : null;
    if (days === null) return `<span class="cd-pill ok">Open</span>`;
    /* Inside a week is the point where saying something is useful. */
    const cls = days <= 3 ? "crit" : days <= 7 ? "warn" : "ok";
    return `<span class="cd-pill ${cls}">${days} day${days === 1 ? "" : "s"} left</span>`;
  }

  /* "£100" or "100" both display as £100. Anything unparseable is passed
     through untouched rather than invented. */
  function money(v) {
    if (!v) return "";
    const t = String(v).trim();
    const m = t.match(/^£?\s*([\d,]+(?:\.\d{1,2})?)$/);
    if (!m) return t;
    const n = Number(m[1].replace(/,/g, ""));
    if (!isFinite(n)) return t;
    return "£" + n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
  }

  function niceDate(iso) {
    const d = parseDay(iso);
    if (!d) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function renderHistory() {
    const u = currentUser();
    const list = $("historyList");
    const empty = $("historyEmpty");
    const summary = $("appealSummary");
    const newBtn = $("newAppealBtn");
    if (!list) return;

    if (!u) {
      list.innerHTML = "";
      if (summary) summary.hidden = true;
      if (empty) empty.hidden = true;
      if (newBtn) newBtn.hidden = true;
      return;
    }

    const appeals = u.appeals || [];
    const has = appeals.length > 0;

    /* With nothing saved, the empty state carries the only call to action. */
    if (empty) empty.hidden = has;
    if (newBtn) newBtn.hidden = !has;

    const counts = { open: 0, won: 0, lost: 0, escalated: 0, expired: 0 };
    appeals.forEach((a) => { counts[appealStatus(u, a)] += 1; });

    if (summary) summary.hidden = !has;
    if (has) {
      const stats = [];
      /* Lead with whatever is most useful: work still live, else the result. */
      if (counts.open) stats.push(`<span class="is-warn"><b>${counts.open}</b>still to send</span>`);
      if (counts.won) stats.push(`<span class="is-ok"><b>${counts.won}</b>won</span>`);
      if (counts.escalated) stats.push(`<span><b>${counts.escalated}</b>escalated</span>`);
      if (counts.lost) stats.push(`<span><b>${counts.lost}</b>lost</span>`);
      if (counts.expired) stats.push(`<span><b>${counts.expired}</b>window closed</span>`);
      const statsEl = $("appealStats");
      if (statsEl) statsEl.innerHTML = stats.join("");
      const pct = Math.round((counts.open / appeals.length) * 100);
      if ($("appealBarFill")) $("appealBarFill").style.width = pct + "%";
      if ($("appealBarNote")) {
        $("appealBarNote").textContent = counts.open
          ? `${counts.open} of ${appeals.length} still inside the appeal window.`
          : "No appeals are still open — every deadline has passed or a result is recorded.";
      }
    }

    if (!has) { list.innerHTML = ""; return; }

    list.innerHTML = appeals.map((a) => {
      const st = appealStatus(u, a);
      const dl = parseDay(a.deadline);
      const days = dl ? daysBetween(todayUTC(), dl) : null;
      const current = state.viewedAppealId === a.id;

      const meta = [];
      if (a.vrm) meta.push(`<span class="history-vrm">${esc(a.vrm)}</span>`);
      if (a.amount) meta.push(`<strong>${esc(money(a.amount))}</strong>`);
      if (a.contra) meta.push(esc(a.contra));
      /* created is a full ISO timestamp, which parseDay rejects; it is
         formatted separately rather than pushed into the day helper. */
      if (a.created) {
        const made = new Date(a.created);
        if (!isNaN(made)) meta.push(made.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }));
      }

      /* Deadline is the thing people come here to check, so it is stated in
         words as well as by the pill. */
      let dlLine = "";
      if (st === "open" && dl && days !== null) {
        dlLine = `Reply by <strong>${niceDate(a.deadline)}</strong>`;
      } else if (st === "expired" && dl) {
        dlLine = `Deadline was <strong>${niceDate(a.deadline)}</strong>`;
      }

      /* Only offer the outcomes that are not already recorded. */
      const opts = [["won", "Won"], ["lost", "Lost"], ["escalated", "Escalate"]];
      const actions = opts.map(([to, label]) =>
        `<button class="mini-btn ${st === to ? "is-current" : ""}" type="button"
           data-status="${esc(a.id)}" data-to="${to}"
           aria-pressed="${st === to}">${label}</button>`).join("");

      return `
      <div class="history-row" data-row="${esc(a.id)}">
        <button class="history-item" type="button" data-appeal="${esc(a.id)}" aria-label="Open ${esc(a.operator || "appeal")} ${esc(a.ref || "")}">
          <span class="history-title">${esc(a.operator || "Appeal")}${a.ref ? ` <span class="dot">·</span> ${esc(a.ref)}` : ""}</span>
          <span class="history-meta">${meta.join('<span class="dot">·</span>')}</span>
          ${dlLine ? `<span class="history-meta">${dlLine}</span>` : ""}
        </button>
        <div class="history-foot">
          ${appealPill(u, a)}
          <div class="history-actions">${actions}</div>
        </div>
      </div>`;
    }).join("");

    $$("[data-appeal]", list).forEach((btn) => btn.addEventListener("click", () => openAppeal(btn.getAttribute("data-appeal"))));
    $$("[data-status]", list).forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const u2 = currentUser();
      const a = (u2.appeals || []).find((x) => x.id === btn.getAttribute("data-status"));
      if (!a) return;
      const to = btn.getAttribute("data-to");
      /* Clicking the outcome that is already recorded clears it. Without this
         a mis-tap was permanent, and a won appeal could not be reopened. */
      const next = a.status === to ? "draft" : to;
      const prev = a.status;
      a.status = next;
      saveUser(u2);
      renderHistory();
      const msg = next === "draft"
        ? "Status cleared — the appeal is open again."
        : next === "won" ? "Marked as won."
        : next === "lost" ? "Marked as lost."
        : "Marked as escalated to POPLA or the IAS.";
      toast(msg, () => {
        const u3 = currentUser();
        const a3 = (u3.appeals || []).find((x) => x.id === a.id);
        if (!a3) return;
        a3.status = prev;
        saveUser(u3);
        renderHistory();
        toast(prev === "draft" ? "Status cleared." : "Status restored.");
      });
      analytics.track("appeal_status", { status: next });
    }));
  }

  function openAppeal(id) {
    const u = currentUser();
    if (!u) return;
    const a = (u.appeals || []).find((x) => x.id === id);
    if (!a) return;
    setVal("fOperator", a.operator);
    setVal("fRef", a.ref);
    setVal("fDate", a.date);
    setVal("fLocation", a.location);
    setVal("fContra", a.contra);
    setVal("fAmount", a.amount);
    setVal("fVrm", a.vrm);
    setVal("fName", u.name || "");
    setVal("fAddress", u.address || "");
    setVal("fPostcode", u.postcode || "");
    state.viewedAppealId = a.id;
    renderAppeal();
    if (a.letter && $("letterText")) $("letterText").textContent = a.letter;
    showPage("results");
  }

  /* ---------------------------------------------------------
     Evidence page
     --------------------------------------------------------- */
  const EVIDENCE_ITEMS = [
    ["anpr", "Full-colour ANPR entry and exit stills", "Both images, uncropped, with the camera identifier visible."],
    ["timestamps", "Entry and exit timestamps to the second", "Ask them to confirm both cameras share a synchronised clock."],
    ["signage", "Photographs of every sign relied upon", "Dated, and showing the sign where a driver would actually see it on entry."],
    ["plan", "The signage plan for the site", "Shows which signs were where, and when they were installed."],
    ["contract", "Landowner contract (redacted)", "Proof they may issue charges in their own name at this site."],
    ["ntk", "The Notice to Keeper as posted, with the envelope", "The postmark and the date received are what matter under POFA."],
    ["machine", "Payment machine or app records", "Relevant if you paid but the charge says you did not."],
    ["photos", "Your own photographs and receipts", "Any evidence you already hold: pay-and-display ticket, app receipt, dashcam."]
  ];

  function renderEvidence() {
    const host = $("evidenceList");
    if (!host) return;
    host.innerHTML = EVIDENCE_ITEMS.map(([id, label, note]) => `
      <label class="ev-item" data-ev="${id}">
        <input type="checkbox" data-label="${esc(label)}" ${["anpr", "timestamps", "signage", "plan", "contract"].includes(id) ? "checked" : ""} />
        <span class="ev-body"><strong>${esc(label)}</strong><span>${esc(note)}</span></span>
      </label>`).join("");
    $$("#evidenceList input[type=checkbox]").forEach((cb) => {
      const sync = () => cb.closest(".ev-item").classList.toggle("checked", cb.checked);
      cb.addEventListener("change", () => { sync(); if ($("evText")) $("evText").textContent = buildEvidenceRequest(); });
      sync();
    });
    if ($("evText")) $("evText").textContent = buildEvidenceRequest();
  }

  /* ---------------------------------------------------------
     SEO landing pages
     --------------------------------------------------------- */
  /* Guide slugs, derived once from GUIDES below. Declared with the data so
     it cannot fall out of step with it. */
  const GUIDES = [
    { slug: "parkingeye", operator: "ParkingEye Ltd", place: "a retail or motorway services car park", basis: "ANPR cameras" },
    { slug: "euro-car-parks", operator: "Euro Car Parks", place: "a retail or town-centre car park", basis: "ANPR cameras or a windscreen ticket" },
    { slug: "ukpc", operator: "UK Parking Control", place: "a residential or retail estate", basis: "an attendant-issued ticket" },
    { slug: "ncp", operator: "NCP", place: "a pay-and-display or station car park", basis: "an attendant-issued ticket" },
    { slug: "smart-parking", operator: "Smart Parking", place: "a retail or leisure car park", basis: "ANPR cameras" },
    { slug: "excel", operator: "Excel Parking", place: "an urban retail car park", basis: "an attendant-issued ticket or ANPR" },
    { slug: "apcoa", operator: "APCOA Parking", place: "a railway station or airport", basis: "ANPR cameras or barrier records" }
  ];
  const GUIDE_SLUGS = GUIDES.map((g) => g.slug);

  function renderGuide(slug) {
    const g = GUIDES.find((x) => x.slug === slug);
    const titleEl = $("seoTitle");
    const bodyEl = $("seoBody");
    if (!titleEl || !bodyEl) return;

    if (!g) {
      titleEl.textContent = "Appeal guides by operator";
      bodyEl.innerHTML = `
        <p class="page-sub">Pick the company that sent your notice. Each guide covers the appeal route, the deadline that applies, and the grounds that usually decide cases against them.</p>
        <div class="seo-list">
          ${GUIDES.map((x) => `
            <button type="button" data-guide="${x.slug}">
              ${esc(x.operator)}
              <span>Appeals at ${esc(x.place)}</span>
            </button>`).join("")}
        </div>
        <p style="margin-top:22px"><button class="btn btn-primary" data-nav="details">Enter your ticket details</button></p>`;
      bindGuideLinks(bodyEl);
      return;
    }

    const op = state.operators.find((o) => o.name.toLowerCase().includes(g.operator.toLowerCase().split(" ")[0])) || findOperator(g.operator);
    const route = op && op.tradeBody === "IPC" ? "the Independent Appeals Service (IAS)" : "POPLA";
    titleEl.textContent = `How to appeal a ${g.operator} parking charge`;
    bodyEl.innerHTML = `
      <p class="page-sub">If ${esc(g.operator)} issued you a parking charge notice at ${esc(g.place)}, here is the route your appeal takes, the deadline that applies, and the points that most often decide the outcome.</p>

      <div class="step-hint"><strong>Route:</strong> appeal to ${esc(g.operator)} first, then escalate to ${esc(route)} if they reject you. Both steps are free.</div>

      <h2>Your two deadlines</h2>
      <ul>
        <li><strong>Appeal to ${esc(g.operator)}:</strong> normally ${D.appealDays} days from the date on the notice, though the letter itself governs — some quote 14 or 21 days.</li>
        <li><strong>Reduced rate:</strong> usually ${D.discountDays} days. Appealing inside that window normally preserves the discount if you later lose.</li>
      </ul>

      <h2>What usually decides these cases</h2>
      <ul>
        ${(op ? op.themes : [
          "Whether the signage at the entrance actually brought the terms to the driver's attention.",
          "Whether the Notice to Keeper met the POFA 2012 timing and content requirements.",
          "Whether the operator can prove it was authorised by the landowner to issue the charge."
        ]).map((t) => `<li>${esc(t)}</li>`).join("")}
      </ul>

      <h2>What to do now</h2>
      <p>Enter the details from your notice and TicketKiller UK will draft the appeal letter, cite the right statutory provisions, and track the deadline. Your first letter is free.</p>
      <p><button class="btn btn-primary btn-xl" data-nav="details">Start my ${esc(g.operator)} appeal</button></p>

      <p class="legal-meta" style="margin-top:22px">This guide is general information, not legal advice. Check the dates and codes on your own notice.</p>`;
    bindGuideLinks(bodyEl);
    analytics.track("guide_view", { guide: slug });
  }

  function bindGuideLinks(root) {
    $$("[data-guide]", root).forEach((b) => b.addEventListener("click", () => showPage("guide", { guide: b.getAttribute("data-guide") })));
    $$("[data-nav]", root).forEach((b) => b.addEventListener("click", () => showPage(b.getAttribute("data-nav"))));
  }

  /* ---------------------------------------------------------
     Statistics with real sources
     --------------------------------------------------------- */
  const STATS = [
    { num: "14.4m", label: "keeper-data requests from private parking firms, 2024-25", src: "RAC Foundation / DVLA", href: "https://www.racfoundation.org/media-centre/private-parking-firms-issue-record-number-of-charges" },
    { num: "107,202", label: "POPLA appeals concluded in the year to September 2025", src: "POPLA Annual Report 2025", href: "https://www.popla.co.uk/" },
    { num: "49,080", label: "charges cancelled at POPLA in that year (45.8%)", src: "POPLA Annual Report 2025", href: "https://www.popla.co.uk/" },
    { num: "34,502", label: "of those were dropped by the operator before a ruling", src: "POPLA Annual Report 2025", href: "https://www.popla.co.uk/" },
    { num: "21.5%", label: "of appeals that reached a decision were allowed", src: "POPLA Annual Report 2025", href: "https://www.popla.co.uk/" },
    { num: "£100", label: "statutory cap once the new Code of Practice is in force", src: "MHCLG, laid 20 Oct 2026", href: "https://www.gov.uk/government/publications/private-parking-code-of-practice-2026-explanatory-memorandum" }
  ];

  function renderStats() {
    const host = $("statGrid");
    if (!host) return;
    host.innerHTML = STATS.map((s) => `
      <article class="stat-card">
        <div class="stat-num">${esc(s.num)}</div>
        <div class="stat-label">${esc(s.label)}</div>
        <a class="stat-src" href="${esc(s.href)}" target="_blank" rel="noopener">${esc(s.src)}</a>
      </article>`).join("");
  }

  /* ---------------------------------------------------------
     Sample letter on the landing page
     --------------------------------------------------------- */
  /* ---------------------------------------------------------
     Public sample: a truncated preview, not the full letter.
     ---------------------------------------------------------
     The landing page shows only the opening section, so the page
     never receives a complete, ready-to-send appeal. This is real
     truncation — the missing grounds are never sent to the browser.
     The remaining ground text lives in assets/data/grounds.json and
     is public reference material, which is fine.
     --------------------------------------------------------- */
  const SAMPLE_PREVIEW_LINES = 20;

  function buildPreview(fullText) {
    const lines = String(fullText).split("\n");
    // Keep the whole document if it is already short.
    if (lines.length <= SAMPLE_PREVIEW_LINES) {
      return { head: fullText, restCount: 0 };
    }
    let cut = SAMPLE_PREVIEW_LINES;
    // Never stop in the middle of a word: back up to the last blank line
    // so the preview ends on a clean paragraph boundary.
    for (let i = cut; i > Math.max(6, cut - 10); i--) {
      if (lines[i - 1].trim() === "" || lines[i - 1].trim().length < 60) { cut = i; break; }
    }
    return {
      head: lines.slice(0, cut).join("\n"),
      restCount: lines.length - cut
    };
  }

  function renderSample() {
    const host = $("sampleLetter");
    if (!host) return;
    const saved = {
      op: val("fOperator"), ref: val("fRef"), date: val("fDate"), loc: val("fLocation"),
      contra: val("fContra"), amount: val("fAmount"), vrm: val("fVrm"), name: val("fName"),
      addr: val("fAddress"), pc: val("fPostcode")
    };
    setVal("fOperator", "ParkingEye Ltd");
    setVal("fRef", "T128719");
    setVal("fDate", dayKey(addDays(todayUTC(), -6)));
    setVal("fLocation", "Riverside Retail Park");
    setVal("fContra", "Parked for longer than the maximum stay permitted");
    setVal("fAmount", "£100");
    setVal("fVrm", "AB12 CDE");
    setVal("fName", "A. Driver");
    setVal("fAddress", "1 Example Street");
    setVal("fPostcode", "AB1 2CD");

    const text = buildLetter();
    const { head, restCount } = buildPreview(text);
    host.innerHTML =
      `<div class="sample-body">${esc(head)}</div>` +
      `<div class="sample-fade" aria-hidden="true"></div>` +
      `<div class="sample-cta">` +
      `<p class="sample-cta-line">${restCount ? `The remaining ${restCount} lines — including the grounds that apply to your notice — are generated with your own details.` : "Generate the full letter with your own details."}</p>` +
      `<button class="btn btn-primary" type="button" data-nav="details">Generate my letter</button>` +
      `</div>`;
    const cta = host.querySelector("[data-nav]");
    if (cta) cta.addEventListener("click", () => showPage(currentUser() ? "details" : "auth"));

    Object.entries(saved).forEach(([k, v]) => {
      const map = { op: "fOperator", ref: "fRef", date: "fDate", loc: "fLocation", contra: "fContra", amount: "fAmount", vrm: "fVrm", name: "fName", addr: "fAddress", pc: "fPostcode" };
      setVal(map[k], v);
    });
  }

  /* ---------------------------------------------------------
     PDF export (jsPDF vendored locally)
     --------------------------------------------------------- */
  function downloadPdf(text, filenameBase) {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) {
      window.print();
      return false;
    }
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const marginX = 56;
    const top = 64;
    const bottom = 780;
    const width = 595 - marginX * 2;
    doc.setFont("times", "normal");
    doc.setFontSize(11);

    const blocks = String(text).split("\n");
    let y = top;
    blocks.forEach((line) => {
      const wrapped = doc.splitTextToSize(line || " ", width);
      wrapped.forEach((w) => {
        if (y > bottom) { doc.addPage(); y = top; }
        doc.text(w, marginX, y);
        y += 15;
      });
    });

    const safe = String(filenameBase || "letter").replace(/[^a-z0-9-]+/gi, "") || "letter";
    doc.save(`TicketKiller-UK-${safe}.pdf`);
    return true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }

  /* ---------------------------------------------------------
     Auth
     --------------------------------------------------------- */
  function bindAuth() {
    if ($("tabLogin")) $("tabLogin").addEventListener("click", () => {
      $("tabLogin").classList.add("active");
      $("tabRegister").classList.remove("active");
      $("loginForm").hidden = false;
      $("registerForm").hidden = true;
      $("authTitle").textContent = "Log in";
    });
    if ($("tabRegister")) $("tabRegister").addEventListener("click", () => {
      $("tabRegister").classList.add("active");
      $("tabLogin").classList.remove("active");
      $("registerForm").hidden = false;
      $("loginForm").hidden = true;
      $("authTitle").textContent = "Create account";
    });

    if ($("loginForm")) $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = val("loginEmail").toLowerCase();
      const u = users()[email];
      if (!u || u.pass !== await hashPass(val("loginPass"))) {
        toast("Email or password is wrong");
        return;
      }
      store.set(SESSION_KEY, email);
      syncNav();
      loadDraft();
      /* A payment made while logged out is held against the email and
         released here, so it is not lost by logging out mid-checkout. */
      const released = applyHeldCredits(email);
      syncPaywall();
      toast(released
        ? `Welcome back, ${u.name || ""}`.trim() + ` — ${released} paid letter${released === 1 ? "" : "s"} unlocked.`
        : `Welcome back, ${u.name || ""}`.trim());
      analytics.track("login");
      showPage(state.afterLogin || "details");
    });

    if ($("registerForm")) $("registerForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = val("regEmail").toLowerCase();
      const name = val("regName");
      const pass = val("regPass");
      if (pass.length < 6) { toast("Password must be at least 6 characters"); return; }
      const map = users();
      if (map[email]) { toast("That email already has an account. Log in."); return; }
      map[email] = { email, name, pass: await hashPass(pass), freeUsed: false, credits: 0, appeals: [], created: new Date().toISOString() };
      saveUsers(map);
      store.set(SESSION_KEY, email);
      if ($("fName") && !$("fName").value) $("fName").value = name;
      syncNav();
      const released = applyHeldCredits(email);
      syncPaywall();
      toast(released
        ? `Account created — ${released} paid letter${released === 1 ? "" : "s"} unlocked.`
        : "Account created");
      analytics.track("signup");
      showPage(state.afterLogin || "details");
    });
  }

  /* ---------------------------------------------------------
     Payments — Stripe Checkout
     ---------------------------------------------------------
     The browser never sees a secret key and never decides that a payment
     happened. It asks the server for a Checkout URL, and asks the server
     again whether the session it returned with was actually paid.
     --------------------------------------------------------- */
  /* The current page without its query or hash, used to strip the return
     parameters after a checkout redirect. */
  function pageUrl() { return location.href.split("#")[0].split("?")[0]; }

  function payUrl(path) { return `${READY.payEndpoint}/${path}`; }

  /* A purchase gets one local credit. The Stripe session id is remembered
     so replaying the same success URL cannot mint a second letter. */
  const SPENT_KEY = "tk_spent_sessions";

  function spentSessions() {
    try { return JSON.parse(store.get(SPENT_KEY) || "[]"); } catch { return []; }
  }
  function markSessionSpent(id) {
    const list = spentSessions();
    if (!list.includes(id)) {
      list.push(id);
      /* Only the recent ones matter; keep the list from growing forever. */
      store.set(SPENT_KEY, JSON.stringify(list.slice(-100)));
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON means something upstream broke */ }
    return { ok: res.ok, status: res.status, data };
  }

  async function startCheckout() {
    const u = currentUser();
    if (!u) {
      state.afterLogin = "details";
      showPage("auth");
      toast("Log in first so we can unlock this account after payment");
      return;
    }
    const buttons = $$("[data-stripe-pay]");
    /* The label carries the progress, not a toast: a toast sat over the
       button and told the visitor checkout was opening when nothing was. */
    const labels = buttons.map((b) => b.textContent);
    buttons.forEach((b, i) => { b.disabled = true; b.textContent = i === 0 ? "Opening Stripe…" : b.textContent; });
    const restore = () => buttons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });

    try {
      const { ok, data } = await postJson(payUrl("checkout"), { email: u.email });
      if (ok && data.url) {
        analytics.track("pay_clicked", { amount: (CFG.payments && CFG.payments.pricePence) || 499 });
        location.href = data.url;
        return;
      }
      toast(data.error || "Could not start checkout. Please try again.");
    } catch (err) {
      /* Distinguish "the request never left" from "the server said no": the
         first is almost always a blocked cross-origin call or a dead host,
         and telling them apart is the difference between a 30-second fix and
         an afternoon. */
      toast("Could not reach the payment server. Check your connection and try again.");
      console.error("checkout request failed:", err && err.message);
    }
    restore();
  }

  function bindStripe() {
    $$("[data-stripe-pay]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!READY.canSell) { toast("Payments are switched off"); return; }
        startCheckout();
      });
    });

    /* The generate button doubles as the call to action when the account is
       locked. It is type=submit inside the ticket form, so a click would
       otherwise both start checkout and submit the form. One gesture must
       do one thing. */
    const gen = $("generateBtn");
    if (gen) {
      gen.addEventListener("click", (e) => {
        if (gen.dataset.intent !== "pay") return;
        e.preventDefault();
        e.stopPropagation();
        if (!READY.canSell) { toast("Payments are switched off"); return; }
        startCheckout();
      });
    }
  }

  /* Returning from Stripe. `?stripe=success&session_id=cs_…` — but nothing
     in that URL is trusted. The id is handed to the server, which asks
     Stripe directly. */
  async function catchStripeReturn() {
    const params = new URLSearchParams(location.search);
    const status = params.get("stripe");
    if (!status) return;

    const clean = () => history.replaceState({}, "", pageUrl());

    if (status === "cancel") {
      clean();
      toast("Payment cancelled — nothing was charged.");
      analytics.track("stripe_return", { status: "cancel" });
      return;
    }
    if (status !== "success") return;

    const id = params.get("session_id") || "";
    clean();

    if (!id) { toast("No payment reference came back. Nothing was unlocked."); return; }
    if (spentSessions().includes(id)) {
      toast("That payment has already been applied to this browser.");
      return;
    }

    toast("Confirming your payment…");
    let result;
    try {
      result = await postJson(payUrl("verify-session"), { session_id: id });
    } catch {
      /* Never unlock on a failed check. The alternative is a free letter
         for anyone who can edit a URL. */
      toast("Could not reach the payment server. Your payment is safe — try again later.");
      analytics.track("stripe_return", { status: "unreachable" });
      return;
    }

    const data = result.data || {};
    if (data.paid) {
      markSessionSpent(id);
      const credited = grantPaidCredit(data.email || (currentUser() && currentUser().email));
      syncNav();
      syncPaywall();
      if (credited) {
        toast(`Payment confirmed${data.amount ? ` — £${(data.amount / 100).toFixed(2)}` : ""}. You can generate another letter.`);
        showPage("details");
      } else {
        /* Paid, but this browser has no matching account — most likely they
           paid then logged out, or paid with a different address. Say so
           instead of pretending a letter was unlocked. */
        toast("Payment received. Log in with the email you paid with to use it.");
        showPage("auth");
      }
      analytics.track("stripe_return", { status: "paid", credited });
    } else {
      toast("Stripe has no record of that payment. Nothing was unlocked.");
      analytics.track("stripe_return", { status: "unverified" });
    }
  }

  /* ---------------------------------------------------------
     Contact form (mailto — no backend)
     --------------------------------------------------------- */
  function bindContact() {
    const form = $("contactForm");
    if (!form) return;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const to = (CFG.contact && CFG.contact.email) || (CFG.business && CFG.business.email) || "";
      const name = val("cName");
      const email = val("cEmail");
      const ref = val("cRef");
      const msg = val("cMessage");
      if (!name || !email || !msg) { toast("Please fill in your name, email and message"); return; }
      const subject = `TicketKiller UK enquiry${ref ? ` — ${ref}` : ""}`;
      const body = `Name: ${name}\nEmail: ${email}\nPCN reference: ${ref || "(none)"}\n\n${msg}`;
      const href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      const box = $("contactResult");
      if (box) {
        box.hidden = false;
        box.innerHTML = `Your email app should open with the message filled in. If it doesn't, copy the address below.
          <div class="mailto-box"><strong>${esc(to)}</strong><br>Subject: ${esc(subject)}</div>`;
      }
      window.location.href = href;
      analytics.track("contact_submit", { hasRef: !!ref });
    });
  }

  /* ---------------------------------------------------------
     Page wiring
     --------------------------------------------------------- */
  function bindGlobalNav() {
    const navEl = $("mobileNav");
    const btnEl = $("menuBtn");
    const setMenu = (open) => {
      if (!navEl || !btnEl) return;
      navEl.toggleAttribute("hidden", !open);
      btnEl.setAttribute("aria-expanded", String(open));
      btnEl.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      document.body.classList.toggle("nav-open", open);
    };
    if (btnEl) btnEl.addEventListener("click", () => setMenu(navEl.hasAttribute("hidden")));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && navEl && !navEl.hasAttribute("hidden")) {
        setMenu(false);
        if (btnEl) btnEl.focus();
      }
    });
    document.addEventListener("click", (e) => {
      if (!navEl || navEl.hasAttribute("hidden")) return;
      if (navEl.contains(e.target) || (btnEl && btnEl.contains(e.target))) return;
      setMenu(false);
    });

    $$("[data-nav]").forEach((btn) => {
      if (btn.closest("[data-bind-skip]")) return;
      btn.addEventListener("click", () => {
        const dest = btn.getAttribute("data-nav");
        if (dest === "auth" && currentUser()) {
          store.del(SESSION_KEY);
          syncNav();
          toast("Logged out");
          showPage("home");
          return;
        }
        showPage(dest);
      });
    });

    $$("[data-guide]").forEach((btn) => {
      if (btn.closest("[data-bind-skip]")) return;
      btn.addEventListener("click", () => showPage("guide", { guide: btn.getAttribute("data-guide") }));
    });

    window.addEventListener("hashchange", () => routeFromHash(true));
  }

  function routeFromHash(instant) {
    const raw = location.hash.replace(/^#/, "");
    const [page, sub] = raw.split("/");
    if (page) showPage(page, { hash: sub, instant });
    else showPage("home", { instant });
  }

  /* ---------------------------------------------------------
     Form progress
     ---------------------------------------------------------
     The details form is a dozen fields copied off a paper ticket, and the
     commonest way to lose someone is that they cannot tell how close they
     are to finishing. This counts the *required* fields, so the number can
     never drift from what the submit handler validates.
     --------------------------------------------------------- */
  const REQUIRED_FIELDS = ["fOperator", "fRef", "fDate", "fAmount", "fVrm", "fName"];

  function updateFormProgress() {
    const label = $("formProgressLabel");
    const pctEl = $("formProgressPct");
    const bar = $("formProgressBar");
    const hint = $("formProgressHint");
    if (!label || !bar) return;

    /* On first paint the required count is stated before anything is filled,
       so read it from the same list rather than from a hard-coded string. */
    if (!updateFormProgress.initialised) {
      updateFormProgress.initialised = true;
      label.textContent = `${REQUIRED_FIELDS.length} required fields — 0 done`;
    }

    const done = REQUIRED_FIELDS.filter((id) => val(id)).length;
    const total = REQUIRED_FIELDS.length;
    const pct = Math.round((done / total) * 100);

    label.textContent = done === total
      ? "All required fields done"
      : `${total - done} required field${total - done === 1 ? "" : "s"} left`;
    if (pctEl) pctEl.textContent = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
    const fill = bar.querySelector("i");
    if (fill) fill.style.width = `${pct}%`;
    bar.classList.toggle("is-complete", done === total);
    /* The label can wrap to a second line, which changes the bar's height and
       so the spacer that holds its place. Re-measure rather than assume. */
    if (progressPinned) {
      const spacer = $("formProgressSpacer");
      if (spacer) spacer.style.height = `${$("formProgress").offsetHeight}px`;
    }

    if (hint) {
      if (done === total) {
        hint.textContent = "Ready — generate the letter and check the deadline it shows.";
      } else if (!val("fOperator")) {
        hint.textContent = "Start with the operator and the notice number — both are on the front of the PCN.";
      } else if (!val("fRef")) {
        hint.textContent = "The PCN reference is usually at the top right of the notice.";
      } else if (!val("fDate")) {
        hint.textContent = "Use the date printed on the notice, not the date you received it.";
      } else if (!val("fAmount")) {
        hint.textContent = "The amount demanded is on the notice. Use the full charge, not the reduced rate.";
      } else if (!val("fVrm")) {
        hint.textContent = "The registration on the notice, as printed.";
      } else {
        hint.textContent = "Your name goes on the letter as the registered keeper.";
      }
    }
  }

  /* ---------------------------------------------------------
     Pinning the progress line
     ---------------------------------------------------------
     Explicit, not `position: sticky`. Sticky is decided by the browser with
     several silent failure modes, and it failed on a real phone after every
     one of those had been ruled out in source. This measures instead: when
     the natural position would scroll above the topbar, the element is
     taken out of flow and placed under the topbar; a spacer holds its place
     so the page does not jump.
     --------------------------------------------------------- */
  let progressPinned = false;

  function topbarHeight() {
    const bar = document.querySelector(".topbar");
    const h = bar ? bar.getBoundingClientRect().height : 0;
    return h || 64;
  }

  /* Where the bar would sit if it were not floating. The spacer holds that
     position while the bar is out of flow, so this stays measurable. */
  function naturalProgressTop(el) {
    const spacer = $("formProgressSpacer");
    /* Inline: the bar itself is where it belongs. Floating: it has been taken
       out of flow, so the spacer is the only witness to that position. */
    if (progressPinned && spacer) return spacer.getBoundingClientRect().top;
    return el.getBoundingClientRect().top;
  }

  function setProgressPinned(on) {
    const el = $("formProgress");
    if (!el || on === progressPinned) return;
    progressPinned = on;
    const spacer = $("formProgressSpacer");
    if (spacer) spacer.style.height = on ? `${el.offsetHeight}px` : "0px";
    /* Park it just under the real topbar rather than trusting a hard-coded
       64px, which is wrong on any device with a notch inset. */
    if (on) el.style.top = `${topbarHeight() + 6}px`;
    el.classList.toggle("is-floating", on);
  }

  function pinFormProgress() {
    const el = $("formProgress");
    if (!el) return;
    const page = el.closest(".page");
    if (!page || !page.classList.contains("active") || el.hidden) {
      setProgressPinned(false);
      return;
    }
    /* One rule both ways: pin when the resting place is above the topbar,
       release when it is below again. No separate hysteresis to get wrong. */
    setProgressPinned(naturalProgressTop(el) <= topbarHeight() + 6);
  }

  function bindDetails() {
    const form = $("ticketForm");
    if (!form) return;
    /* Capture phase, deliberately: scroll events do not bubble, so a listener
       on window alone hears only the document scrolling. If anything between
       the bar and the root becomes a scroll container — which is one of the
       reasons sticky failed here — the window listener goes deaf and the bar
       silently stays put. Capturing catches every scroller in the page. */
    window.addEventListener("scroll", pinFormProgress, { passive: true, capture: true });
    window.addEventListener("resize", () => { setProgressPinned(false); pinFormProgress(); }, { passive: true });


    FIELD_IDS.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => {
        saveDraft();
        updateFormProgress();
        if (id === "fOperator") renderOperatorIntel();
        if (["fDate", "fAppealDays", "fDiscountDays", "fTicketType", "fNtkDate"].includes(id)) renderDeadlines();
        if ($("page-results").classList.contains("active")) {
          renderDeadlineSummary();
          refreshLetters();
        }
      });
      el.addEventListener("change", () => {
        saveDraft();
        if (["fDate", "fAppealDays", "fDiscountDays", "fTicketType", "fNtkDate"].includes(id)) renderDeadlines();
        if (id === "fOperator") renderOperatorIntel();
      });
    });

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!currentUser()) {
        state.afterLogin = "details";
        showPage("auth");
        toast("Create an account or log in first");
        return;
      }
      if (!canGenerate()) {
        /* Locked. The pane is already open at this point, so scrolling to it
           does nothing on a phone and the toast fades before it is read.
           Scroll to the actual pay button and say the price. */
        syncPaywall();
        const payBtn = document.querySelector("#paywallPane [data-stripe-pay]");
        if (payBtn) {
          try { payBtn.scrollIntoView({ behavior: "smooth", block: "center" }); } catch { /* jsdom */ }
          payBtn.setAttribute("data-nudge", "1");
          setTimeout(() => payBtn.removeAttribute("data-nudge"), 1600);
          payBtn.focus({ preventScroll: true });
        }
        toast("Buy another letter below to generate this one");
        return;
      }
      const required = ["fOperator", "fRef", "fVrm", "fName", "fDate"];
      const missing = required.filter((id) => !val(id));
      if (missing.length) {
        toast("Please fill operator, notice number, date, registration and your name");
        const first = $(missing[0]);
        if (first) first.focus();
        return;
      }
      const u = currentUser();
      u.address = val("fAddress");
      u.postcode = val("fPostcode");
      saveUser(u);

      consumeGenerate();
      renderAppeal();
      const item = saveCurrentAppeal();
      state.viewedAppealId = item ? item.id : null;
      showPage("results");
      syncPaywall();
      analytics.track("letter_generated", { operator: val("fOperator"), grounds: state.selectedGrounds.size });
    });
  }

  function bindResults() {
    if ($("copyBtn")) $("copyBtn").addEventListener("click", async () => {
      const ok = await copyText($("letterText").textContent);
      toast(ok ? "Appeal letter copied" : "Copy failed — select the text and copy manually");
      analytics.track("copy_letter", { ok });
    });
    if ($("pdfBtn")) $("pdfBtn").addEventListener("click", () => {
      const ref = (val("fRef") || "appeal").replace(/[^\w-]+/g, "");
      const ok = downloadPdf($("letterText").textContent, `appeal-${ref}`);
      toast(ok ? "PDF downloaded" : "Opened print dialog");
      analytics.track("pdf_download", { ok, doc: "appeal" });
    });
    if ($("escCopyBtn")) $("escCopyBtn").addEventListener("click", async () => {
      const ok = await copyText($("escalationText").textContent);
      toast(ok ? "Escalation text copied" : "Copy failed");
      analytics.track("copy_letter", { ok, doc: "escalation" });
    });
    if ($("escPdfBtn")) $("escPdfBtn").addEventListener("click", () => {
      const ref = (val("fRef") || "appeal").replace(/[^\w-]+/g, "");
      const ok = downloadPdf($("escalationText").textContent, `popla-${ref}`);
      toast(ok ? "PDF downloaded" : "Opened print dialog");
      analytics.track("pdf_download", { ok, doc: "escalation" });
    });
    if ($("evidenceBtn")) $("evidenceBtn").addEventListener("click", () => showPage("evidence"));

    const tabs = { primary: [$("tabPrimary"), $("panelPrimary")], escalation: [$("tabEscalation"), $("panelEscalation")] };
    Object.entries(tabs).forEach(([key, [tab, panel]]) => {
      if (!tab || !panel) return;
      tab.addEventListener("click", () => {
        Object.entries(tabs).forEach(([k, [t, p]]) => {
          if (!t || !p) return;
          t.setAttribute("aria-selected", String(k === key));
          p.hidden = k !== key;
        });
        analytics.track("results_tab", { tab: key });
      });
    });
  }

  function bindEvidencePage() {
    if ($("evCopy")) $("evCopy").addEventListener("click", async () => {
      const ok = await copyText($("evText").textContent);
      toast(ok ? "Request copied" : "Copy failed");
      analytics.track("copy_letter", { ok, doc: "evidence" });
    });
    if ($("evPdf")) $("evPdf").addEventListener("click", () => {
      const ref = (val("fRef") || "appeal").replace(/[^\w-]+/g, "");
      const ok = downloadPdf($("evText").textContent, `evidence-request-${ref}`);
      toast(ok ? "PDF downloaded" : "Opened print dialog");
      analytics.track("pdf_download", { ok, doc: "evidence" });
    });
  }

  /* ---------------------------------------------------------
     Business identity and readiness
     --------------------------------------------------------- */
  function renderBusiness() {
    const b = CFG.business || {};
    const name = b.tradingName || "TicketKiller UK";

    $$("[data-biz-name]").forEach((el) => { el.textContent = name; });

    /* Full sentences, composed so nothing renders as "address is .".
       The controller is the legal person, which is not the brand: for a sole
       trader it is the individual, and naming only the brand would not
       satisfy the transparency obligation. */
    const controller = $("controllerLine");
    if (controller) {
      const who = READY.hasLegalName ? b.legalName : name;
      const tradeName_ = (b.businessName || "").trim() || b.tradingName || "";
      const alsoTrades = READY.hasLegalName && tradeName_ && tradeName_ !== b.legalName
        ? ` (trading as ${tradeName_})` : "";
      const addr = READY.hasAddress ? `, of ${b.address}` : "";
      const mail = READY.hasEmail ? ` Contact: ${READY.contactEmail}.` : "";
      controller.textContent = `The data controller is ${who}${alsoTrades}${addr}.${mail}`;
    }
    const termsContact = $("termsContactLine");
    if (termsContact) {
      const btn = termsContact.querySelector("button");
      termsContact.textContent = READY.hasEmail ? `Email ${READY.contactEmail}, or use the ` : "Use the ";
      if (btn) { termsContact.appendChild(btn); termsContact.append(" to reach us."); }
    }
    /* A limited company must state its registered name, jurisdiction and
       number wherever it identifies itself. Composed once and reused. */
    const companyNo = (b.companyNumber || "").trim();
    const jurisdiction = (b.jurisdiction || "").trim();
    const companyLine = READY.hasCompany
      ? `${b.legalName}, registered in ${jurisdiction || "England and Wales"}${companyNo ? `, company number ${companyNo}` : ""}`
      : "";

    const footerLegal = $("footerLegal");
    if (footerLegal) {
      footerLegal.textContent = companyLine
        ? ` · ${companyLine}`
        : (READY.hasLegalName && b.legalName !== name ? ` · ${b.legalName}` : "");
    }

    /* Terms page. Built from what is actually known and hidden entirely
       rather than rendered half-written. */
    const termsCompany = $("termsCompanyLine");
    if (termsCompany) {
      /* Built from what is actually known, and hidden entirely rather than
         rendered half-written. No pronouns: the operator may be a person or
         a company, and "it"/"they" is wrong for one of them. */
      const parts = [];
      if (READY.hasLegalName) {
        let s1 = `${b.legalName} is the operator of this service`;
        if (READY.hasCompany) {
          const bits = [`registered in ${jurisdiction || "England and Wales"}`];
          if (companyNo) bits.push(`company number ${companyNo}`);
          s1 += `, ${bits.join(", ")}`;
        } else {
          /* A sole trader is a person. Without this the page would imply the
             product brand is the legal entity. */
          const tradeName = (b.businessName || "").trim() || name;
          if (tradeName && tradeName !== b.legalName) s1 += `, trading as ${tradeName}`;
        }
        parts.push(s1);
      }
      if (READY.hasAddress) {
        parts.push(`${READY.hasCompany ? "Registered address" : "Postal address"}: ${b.address}`);
      }
      if (READY.hasEmail) parts.push(`Contact: ${READY.contactEmail}`);
      termsCompany.textContent = parts.length ? `${parts.join(". ")}.` : "";
      termsCompany.hidden = !parts.length;
    }

    $$("[data-biz-company]").forEach((el) => { el.textContent = companyLine; });

    // Only fill spans that have a real value, and drop rows left empty.
    $$("[data-biz-legal]").forEach((el) => { el.textContent = READY.hasLegalName ? b.legalName : name; });
    $$("[data-biz-address]").forEach((el) => { el.textContent = READY.hasAddress ? b.address : ""; });
    $$("[data-biz-email], [data-contact-email]").forEach((el) => { el.textContent = READY.hasEmail ? READY.contactEmail : ""; });
    $$("[data-contact-time]").forEach((el) => { el.textContent = (CFG.contact && CFG.contact.responseTime) || "within 2 working days"; });

    $$("[data-row]").forEach((row) => {
      const span = row.querySelector("span");
      const empty = !span || !span.textContent.trim();
      row.hidden = empty;
    });

    // Setup guidance for the operator only. Injected locally so the text
    // never ships in the deployed HTML.
    const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname) || location.protocol === "file:";
    if (isLocal && !READY.hasOperator) {
      const msg = document.createElement("div");
      msg.className = "legal-warning";
      msg.innerHTML = "<strong>Setup needed.</strong> Fill in <code>business.legalName</code>, " +
        "<code>address</code> and <code>email</code> in <code>assets/config.js</code>. " +
        "Until then payments stay switched off. This notice only appears locally.";
      ["page-privacy", "page-terms"].forEach((id) => {
        const page = $(id);
        if (!page) return;
        const title = page.querySelector("h1");
        if (title && title.parentNode) title.parentNode.insertBefore(msg.cloneNode(true), title.nextSibling);
      });
    }
  }

  function applyReadiness() {
    // Payments: hide every pay control unless we can honestly sell. The
    // button itself is the reliable hook — wrapping cards vary by page,
    // and the pricing card must stay visible because the free tier is real.
    const payControls = $$("[data-stripe-pay], .paywall-card, [data-pay-surface]");
    payControls.forEach((el) => { el.hidden = !READY.canSell; });

    // Swap the pricing card copy when selling is off.
    $$("[data-pricing-note]").forEach((el) => {
      el.textContent = READY.canSell
        ? ""
        : "Payments are switched off on this deployment. Every letter is currently free.";
      el.hidden = READY.canSell;
    });

    // The contact page needs a real address to be useful.
    $$("[data-contact-fallback]").forEach((el) => { el.hidden = READY.hasEmail; });

    document.documentElement.setAttribute("data-tk-selling", READY.canSell ? "1" : "0");
  }

  /* ---------------------------------------------------------
     Sample copy protection (courtesy only)
     ---------------------------------------------------------
     The sample is truncated, so there is little worth taking. These
     handlers just stop someone selecting the faded preview and
     quoting it as if it were a complete letter.
     --------------------------------------------------------- */
  function bindCopyProtection() {
    const sample = $("sampleLetter");
    if (!sample) return;
    const card = sample.closest(".sample-outer") || sample;

    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      toast("This is a preview. The first letter is free — generate your own.");
    });
    card.addEventListener("copy", (e) => { e.preventDefault(); });
    card.addEventListener("cut", (e) => { e.preventDefault(); });
    card.addEventListener("dragstart", (e) => { e.preventDefault(); });
    card.addEventListener("selectstart", (e) => {
      const sel = window.getSelection && window.getSelection();
      if (sel) sel.removeAllRanges();
    });
    card.addEventListener("mousedown", (e) => {
      // kill selection on the sample itself; the note below it stays selectable
      if (sample.contains(e.target)) window.setTimeout(() => {
        const sel = window.getSelection && window.getSelection();
        if (sel && String(sel).length) sel.removeAllRanges();
      }, 0);
    });
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  async function boot() {
    await loadContent();

    // operator + contravention datalists
    if ($("operatorList")) {
      $("operatorList").innerHTML = state.operators.map((o) => `<option value="${esc(o.name)}"></option>`).join("");
    }

    // prices from config
    $$("[data-price]").forEach((el) => {
      el.textContent = `${(CFG.pricing && CFG.pricing.symbol) || "£"}${(CFG.pricing && CFG.pricing.extraLetterLabel) || "4.99"}`;
    });
    renderBusiness();
    applyReadiness();

    bindCopyProtection();
    bindGlobalNav();
    bindAuth();
    bindStripe();
    bindDetails();
    bindResults();
    bindEvidencePage();
    bindContact();

    loadDraft();
    syncNav();
    syncPaywall();
    renderOperatorIntel();
    renderDeadlines();
    renderEvidence();
    renderGrounds();
    refreshLetters();
    renderSample();
    renderStats();

    catchStripeReturn();
    routeFromHash(true);

    const yr = $("footerYear");
    if (yr) yr.textContent = new Date().getFullYear();

    analytics.track("session_start", { version: CFG.version });
    document.documentElement.setAttribute("data-tk-ready", "1");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
