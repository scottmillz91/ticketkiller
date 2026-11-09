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
  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.setAttribute("data-show", "1");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; el.removeAttribute("data-show"); }, 2800);
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

  function showPage(name, opts = {}) {
    if (!PAGES.includes(name)) name = "home";
    if ((name === "details" || name === "history" || name === "evidence") && !currentUser()) {
      state.afterLogin = name;
      name = "auth";
    }
    $$(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === name));
    const nav = $("mobileNav");
    if (nav) nav.setAttribute("hidden", "");
    const mb = $("menuBtn");
    if (mb) mb.setAttribute("aria-expanded", "false");

    if (name === "details") { syncPaywall(); renderDeadlines(); renderOperatorIntel(); }
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
    const pay = CFG.paypal || {};
    if (pay.enabled === false) return !!currentUser();
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
  function grantPaidCredit(email) {
    const map = users();
    if (!map[email]) return;
    map[email].credits = (map[email].credits || 0) + 1;
    saveUsers(map);
    store.del(PENDING_KEY);
  }
  function syncPaywall() {
    const pane = $("paywallPane");
    const btn = $("generateBtn");
    if (!pane || !btn) return;
    const pay = CFG.paypal || {};
    const locked = !!currentUser() && !canGenerate();
    pane.hidden = !locked || pay.enabled === false;
    btn.disabled = locked;
    btn.textContent = locked
      ? `Pay ${CFG.pricing ? CFG.pricing.symbol : "£"}${CFG.pricing ? CFG.pricing.extraLetterLabel : "4.99"} to generate another`
      : "Generate appeal letter";
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
        <div class="ground-actions">
          <button class="mini-btn" type="button" aria-pressed="${on}" data-toggle-ground="${esc(g.id)}">${on ? "Included" : "Excluded"}</button>
          <span class="mini-btn" style="cursor:default">Applies when: ${esc(g.when)}</span>
        </div>
      </li>`;
    }).join("");
    const n = state.selectedGrounds.size;
    if ($("weakCount")) $("weakCount").textContent = `${n} of ${state.grounds.length} grounds`;
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

  function renderHistory() {
    const u = currentUser();
    const list = $("historyList");
    if (!list) return;
    if (!u) { list.innerHTML = ""; return; }

    const subs = $("historySub");
    if (subs) {
      const open = (u.appeals || []).filter((a) => appealStatus(u, a) === "open").length;
      subs.textContent = `${u.name} · ${(u.appeals || []).length} letter(s) · ${open} still inside the appeal window · first letter ${u.freeUsed ? "used" : "still free"}`;
    }

    if (!u.appeals || !u.appeals.length) {
      list.innerHTML = `<p class="page-sub">No letters yet. Generate one from your ticket details — the first is free.</p>`;
      return;
    }

    list.innerHTML = u.appeals.map((a) => {
      const st = appealStatus(u, a);
      const dl = parseDay(a.deadline);
      const days = dl ? daysBetween(todayUTC(), dl) : null;
      const pill = st === "won" ? `<span class="cd-pill ok">Won</span>`
        : st === "lost" ? `<span class="cd-pill crit">Lost</span>`
        : st === "escalated" ? `<span class="cd-pill warn">Escalated</span>`
        : st === "expired" ? `<span class="cd-pill crit">Window closed</span>`
        : `<span class="cd-pill ${bandClass(days)}">${days} day${days === 1 ? "" : "s"} left</span>`;
      return `
      <div class="history-row">
        <button class="history-item" type="button" data-appeal="${esc(a.id)}">
          <strong>${esc(a.operator || "Appeal")} · ${esc(a.ref || "")}</strong>
          <span>${esc(a.vrm || "")} · ${esc(a.amount || "")} · ${esc(a.contra || "")} · ${a.created ? new Date(a.created).toLocaleDateString("en-GB") : ""}</span>
        </button>
        <div class="history-meta">${pill}</div>
        <div class="history-actions">
          <button class="mini-btn" data-status="${esc(a.id)}" data-to="won">Won</button>
          <button class="mini-btn" data-status="${esc(a.id)}" data-to="lost">Lost</button>
          <button class="mini-btn" data-status="${esc(a.id)}" data-to="escalated">Escalate</button>
        </div>
      </div>`;
    }).join("");

    $$("[data-appeal]", list).forEach((btn) => btn.addEventListener("click", () => openAppeal(btn.getAttribute("data-appeal"))));
    $$("[data-status]", list).forEach((btn) => btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const u2 = currentUser();
      const a = (u2.appeals || []).find((x) => x.id === btn.getAttribute("data-status"));
      if (!a) return;
      a.status = btn.getAttribute("data-to");
      saveUser(u2);
      renderHistory();
      toast(a.status === "won" ? "Marked as won — nice one." : a.status === "lost" ? "Marked as lost." : "Marked as escalated.");
      analytics.track("appeal_status", { status: a.status });
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
  const GUIDES = [
    { slug: "parkingeye", operator: "ParkingEye Ltd", place: "a retail or motorway services car park", basis: "ANPR cameras" },
    { slug: "euro-car-parks", operator: "Euro Car Parks", place: "a retail or town-centre car park", basis: "ANPR cameras or a windscreen ticket" },
    { slug: "ukpc", operator: "UK Parking Control", place: "a residential or retail estate", basis: "an attendant-issued ticket" },
    { slug: "ncp", operator: "NCP", place: "a pay-and-display or station car park", basis: "an attendant-issued ticket" },
    { slug: "smart-parking", operator: "Smart Parking", place: "a retail or leisure car park", basis: "ANPR cameras" },
    { slug: "excel", operator: "Excel Parking", place: "an urban retail car park", basis: "an attendant-issued ticket or ANPR" },
    { slug: "apcoa", operator: "APCOA Parking", place: "a railway station or airport", basis: "ANPR cameras or barrier records" }
  ];

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
  const SAMPLE_PREVIEW_LINES = 30;

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
      toast(`Welcome back, ${u.name || ""}`.trim());
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
      toast("Account created");
      analytics.track("signup");
      showPage(state.afterLogin || "details");
    });
  }

  /* ---------------------------------------------------------
     PayPal
     --------------------------------------------------------- */
  function pageUrl() { return location.href.split("#")[0].split("?")[0]; }

  function bindPaypal() {
    $$(".paypal-form").forEach((form) => {
      form.addEventListener("submit", (e) => {
        const pay = CFG.paypal || {};
        if (pay.enabled === false) { e.preventDefault(); toast("Payments are off"); return; }
        const u = currentUser();
        if (!u) {
          e.preventDefault();
          state.afterLogin = "details";
          showPage("auth");
          toast("Log in first so we can unlock this account after payment");
          return;
        }
        const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        store.set(PENDING_KEY, JSON.stringify({ nonce, email: u.email, started: Date.now() }));
        form.querySelector('[name="return"]').value = `${pageUrl()}?paypal=success`;
        form.querySelector('[name="cancel_return"]').value = `${pageUrl()}?paypal=cancel`;
        form.querySelector('[name="custom"]').value = `${u.email}|${nonce}`;
        analytics.track("pay_clicked", { amount: CFG.pricing && CFG.pricing.extraLetterLabel });
      });
    });
  }

  function catchPaypalReturn() {
    const params = new URLSearchParams(location.search);
    const status = params.get("paypal");
    if (!status) return;
    if (status === "success") {
      try {
        const pending = JSON.parse(store.get(PENDING_KEY) || "null");
        if (pending && pending.email) {
          grantPaidCredit(pending.email);
          store.set(SESSION_KEY, pending.email);
        }
      } catch { /* ignore */ }
      history.replaceState({}, "", pageUrl());
      toast("Payment confirmed. You can generate another letter.");
      syncNav();
      showPage("details");
      analytics.track("paypal_return", { status });
    } else if (status === "cancel") {
      store.del(PENDING_KEY);
      history.replaceState({}, "", pageUrl());
      toast("Payment cancelled");
      analytics.track("paypal_return", { status });
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
    if ($("menuBtn")) $("menuBtn").addEventListener("click", () => {
      const nav = $("mobileNav");
      const open = nav.hasAttribute("hidden");
      nav.toggleAttribute("hidden", !open);
      $("menuBtn").setAttribute("aria-expanded", String(open));
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

  function bindDetails() {
    const form = $("ticketForm");
    if (!form) return;

    FIELD_IDS.forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("input", () => {
        saveDraft();
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
        syncPaywall();
        if ($("paywallPane")) $("paywallPane").scrollIntoView({ behavior: "smooth", block: "center" });
        toast("Buy an extra letter to generate another one");
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
    $$("[data-biz-name]").forEach((el) => { el.textContent = (CFG.business && CFG.business.tradingName) || "TicketKiller UK"; });
    $$("[data-biz-email]").forEach((el) => { el.textContent = (CFG.business && CFG.business.email) || ""; });
    $$("[data-biz-legal]").forEach((el) => { el.textContent = (CFG.business && CFG.business.legalName) || "[YOUR FULL LEGAL NAME]"; });
    $$("[data-biz-address]").forEach((el) => { el.textContent = (CFG.business && CFG.business.address) || "[YOUR POSTAL ADDRESS]"; });
    $$("[data-contact-email]").forEach((el) => { el.textContent = (CFG.contact && CFG.contact.email) || ""; });
    if (CFG.paypal && CFG.paypal.enabled === false) {
      $$(".paypay-hidden-if-off").forEach((el) => { el.hidden = true; });
    }

    bindCopyProtection();
    bindGlobalNav();
    bindAuth();
    bindPaypal();
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

    catchPaypalReturn();
    routeFromHash(true);

    const yr = $("footerYear");
    if (yr) yr.textContent = new Date().getFullYear();

    analytics.track("session_start", { version: CFG.version });
    document.documentElement.setAttribute("data-tk-ready", "1");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
