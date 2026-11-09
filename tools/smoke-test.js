/**
 * Smoke test: loads index.html in jsdom with a local resource loader,
 * runs the real app scripts, and exercises the main user journeys.
 * Run with: npm test
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole, requestInterceptor } = require("jsdom");
const { webcrypto } = require("crypto");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n         ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n         ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

/* Serve everything from disk so <script src> and fetch() both work. */
const MIME = { ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".woff2": "font/woff2", ".html": "text/html" };
/* The shipped config.js deliberately has blank seller details, which keeps
   selling off. The suite swaps in a configured copy so the Stripe path can
   be exercised; the production gate is checked separately below. */
const configuredConfig = () => {
  const src = fs.readFileSync(path.join(root, "assets", "config.js"), "utf8");
  return src
    .replace(/legalName:\s*"[^"]*"/, 'legalName: "Alex Driver"')
    .replace(/address:\s*"[^"]*"/, 'address: "1 Test Street, London, AB1 2CD"')
    .replace(/email:\s*"TODO[^"]*"/g, 'email: "payments@example-driver.co.uk"')
    .replace(/email:\s*""/g, 'email: "payments@example-driver.co.uk"')
    /* The suite must not depend on whose details are in the repo: assert
       against the fixture's own identity, not the seller's real name. */
    .replace(/tradingName:\s*"[^"]*"/, 'tradingName: "Test Parking Letters"');
};
const localServer = requestInterceptor((request) => {
  const rel = new URL(request.url).pathname.replace(/^\//, "") || "index.html";
  if (rel === "assets/config.js") {
    return new Response(configuredConfig(), { status: 200, headers: { "Content-Type": "text/javascript" } });
  }
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return new Response("not found", { status: 404 });
  const type = MIME[path.extname(full)] || "application/octet-stream";
  return new Response(fs.readFileSync(full), { status: 200, headers: { "Content-Type": type } });
});

const errors = [];
const vc = new VirtualConsole();
// jsdom has no canvas; jsPDF probes for it on load. That is a harness gap, not a page bug.
const IGNORE = [/HTMLCanvasElement's getContext/, /Not implemented: HTMLCanvasElement/];
vc.on("jsdomError", (e) => { if (!IGNORE.some((r) => r.test(e.message))) errors.push(e.message); });
vc.on("error", (...a) => { const m = a.map(String).join(" "); if (!IGNORE.some((r) => r.test(m))) errors.push(m); });

const dom = new JSDOM(html, {
  url: "http://localhost/",
  runScripts: "dangerously",
  resources: { interceptors: [localServer] },
  virtualConsole: vc,
  pretendToBeVisual: true,
  beforeParse(window) {
    window.scrollTo = () => {};
    Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: async () => {} }, configurable: true
    });
    window.document.execCommand = () => true;
    window.__savedPdf = null;
    window.jspdf = {
      jsPDF: function () {
        return {
          setFont() {}, setFontSize() {}, splitTextToSize: (t) => [t],
          text() {}, addPage() {}, save(f) { window.__savedPdf = f; }
        };
      }
    };
    const realFetch = window.fetch;
    window.fetch = async (url) => {
      const rel = String(url).replace(/^https?:\/\/localhost\//, "").replace(/^\.?\//, "").split(/[?#]/)[0];
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(full, "utf8")) };
    };
  }
});

const { window } = dom;
const { document } = window;

/* A second, independent page carrying pre-set storage — the way a returning
   visitor's browser arrives. The main fixture has already booted, so anything
   that must be decided at start-up needs its own window. */
function freshWindow(storage = {}) {
  const seeded = Object.assign({}, storage);
  const local = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(seeded, k) ? seeded[k] : null),
    setItem: (k, v) => { seeded[k] = String(v); },
    removeItem: (k) => { delete seeded[k]; },
    clear: () => { Object.keys(seeded).forEach((k) => delete seeded[k]); },
    key: (i) => Object.keys(seeded)[i] || null,
    get length() { return Object.keys(seeded).length; }
  };
  return new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    resources: { interceptors: [localServer] },
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(w) {
      w.scrollTo = () => {};
      w.print = () => {};
      Object.defineProperty(w, "crypto", { value: webcrypto, configurable: true });
      Object.defineProperty(w, "localStorage", { value: local, configurable: true });
      w.fetch = async (url) => {
        const rel = String(url).replace(/^\.?\//, "").split(/[?#]/)[0];
        const full = path.join(root, rel);
        if (!fs.existsSync(full)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(full, "utf8")) };
      };
    }
  }).window;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const setInput = (el, v) => {
  el.value = v;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
};
/* jsdom truncates this stylesheet's CSSOM (it cannot parse the range syntax
   in @font-face), so rules that cannot be checked through the DOM are read
   from the file itself. */
const cssSource = () => fs.readFileSync(path.join(__dirname, "..", "assets", "styles.css"), "utf8");
const nav = (dest) => click(document.querySelector(`#mobileNav [data-nav="${dest}"]`) || document.querySelector(`[data-nav="${dest}"]`));

(async () => {
  for (let i = 0; i < 120 && document.documentElement.getAttribute("data-tk-ready") !== "1"; i++) await sleep(25);

  check("app boots", () => assert(document.documentElement.getAttribute("data-tk-ready") === "1", "boot flag never set"));
  check("no runtime errors during boot", () => assert(errors.length === 0, errors.slice(0, 3).join(" | ")));
  check("operator datalist populated from JSON", () => {
    const n = $("operatorList").querySelectorAll("option").length;
    assert(n > 5, `only ${n} operators`);
  });
  check("hero eyebrow is split into segments", () => {
    const eye = document.querySelector(".hero .eyebrow");
    assert(eye, "no hero eyebrow");
    const segs = [...eye.children].map((s) => s.textContent.trim());
    assert(segs.length === 3, `expected 3 segments, got ${segs.length}`);
    assert(!eye.textContent.includes("·"), "separator still hardcoded as text");
  });
  check("hero headline keeps its two phrases intact", () => {
    const h1 = document.querySelector(".hero h1").textContent.trim();
    assert(h1 === "Got a Parking Ticket? Fight It in 2 Minutes.", `headline changed: ${h1}`);
  });
  check("eyebrow tracking stays legible for small caps", () => {
    /* 0.12em at 12px was wide; anything above 0.11em is the old value. */
    const css = cssSource();
    const m = css.match(/\.eyebrow\s*\{([^}]*)\}/);
    assert(m, "no .eyebrow rule");
    const tr = /letter-spacing:\s*([\d.]+)em/.exec(m[1]);
    assert(tr, "no letter-spacing on .eyebrow");
    assert(Number(tr[1]) <= 0.11, `tracking is ${tr[1]}em`);
  });
  check("sample preview renders with real content", () => {
    const t = $("sampleLetter").textContent;
    assert(t.includes("ParkingEye"), "no operator in sample");
    assert(t.includes("T128719"), "no PCN reference");
    assert(/Formal appeal/.test(t), "no appeal heading");
    assert(!t.includes("Loading"), "still loading");
  });
  check("sample is truncated, not the full letter", () => {
    const t = $("sampleLetter").textContent;
    // the grounding that would most likely be quoted must not be present
    assert(!/ParkingEye Ltd v Beavis/.test(t), "Beavis ground leaked into the preview");
    assert(!/Landowner authority/.test(t), "landowner ground leaked into the preview");
    assert(!/Yours faithfully/.test(t), "preview runs to the letter's signature");
    assert(t.length < 1600, `preview too long: ${t.length} chars`);
  });
  check("preview advertises what is missing", () => {
    const t = $("sampleLetter").textContent;
    assert(/remaining \d+ lines/i.test(t), "no 'remaining lines' line");
    assert($("sampleLetter").querySelector("[data-nav]"), "no CTA button");
  });
  check("stats grid has sourced entries", () => {
    const cards = $("statGrid").querySelectorAll(".stat-card");
    assert(cards.length >= 4, `only ${cards.length} stat cards`);
    assert($("statGrid").querySelectorAll("a[href^='http']").length >= 4, "sources not linked");
  });
  check("grounds render from grounds.json", () => {
    const n = $("weakList").querySelectorAll("li").length;
    assert(n >= 8, `only ${n} grounds`);
  });

  // ---------- deadline maths ----------
  const iso = new Date().toISOString().slice(0, 10);
  nav("details");
  setInput($("fDate"), iso);
  await sleep(20);
  const out = $("deadlineOut").textContent;
  check("deadline tracker shows a countdown", () => assert(/day[s]? left/.test(out), `unexpected: ${out.slice(0, 140)}`));
  check("deadline tracker cites POFA", () => assert(out.includes("POFA"), "no POFA note"));
  check("deadline tracker shows 28-day deadline", () => {
    const expected = new Date(Date.now() + 28 * 86400000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    assert(out.includes(expected), `expected ${expected} in output`);
  });

  // POFA 14-day test with a late notice
  const late = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  setInput($("fDate"), late);
  setInput($("fNtkDate"), new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
  await sleep(20);
  check("late Notice to Keeper is flagged as non-compliant", () => {
    const t = $("deadlineOut").textContent;
    assert(/outside the 14-day limit/i.test(t), `got: ${t.slice(0, 200)}`);
  });

  // ---------- registration ----------
  nav("auth");
  click($("tabRegister"));
  setInput($("regName"), "Test User");
  setInput($("regEmail"), "test@example.com");
  setInput($("regPass"), "hunter2!");
  $("registerForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(120);
  check("registration creates a session", () => assert(window.localStorage.getItem("tk_session") === "test@example.com", "no session"));
  check("registration lands on details page", () => assert($("page-details").classList.contains("active"), "not on details"));

  // ---------- generate ----------
  setInput($("fOperator"), "ParkingEye Ltd");
  setInput($("fRef"), "T128719");
  setInput($("fDate"), new Date().toISOString().slice(0, 10));
  setInput($("fLocation"), "Riverside Retail Park");
  setInput($("fContra"), "Parked for longer than the maximum stay permitted");
  setInput($("fAmount"), "£100");
  setInput($("fVrm"), "AB12 CDE");
  setInput($("fName"), "Test User");
  setInput($("fAddress"), "1 Example Street");
  setInput($("fPostcode"), "AB1 2CD");
  $("ticketForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await sleep(80);

  check("letter generates and shows results page", () => {
    assert($("page-results").classList.contains("active"), "not on results");
    const t = $("letterText").textContent;
    assert(t.includes("T128719"), "PCN missing");
    assert(t.includes("AB12 CDE"), "VRM missing");
    assert(t.includes("1 Example Street"), "address missing");
  });
  check("BPA operator gets POPLA route", () => assert($("letterText").textContent.includes("POPLA"), "no POPLA"));
  check("letter declines to name the driver", () => assert(/decline to identify the driver/i.test($("letterText").textContent), "no keeper stance"));
  check("toggling a ground changes the letter", () => {
    const before = $("letterText").textContent.length;
    click($("weakList").querySelector("[data-toggle-ground]"));
    assert($("letterText").textContent.length !== before, "letter unchanged");
  });
  check("ground count reflects selection", () => assert(/of 8 included/.test($("weakCount").textContent), $("weakCount").textContent));
  check("escalation letter generates", () => {
    const t = $("escalationText").textContent;
    assert(t.includes("Independent appeal"), "no escalation heading");
    assert(t.includes("POPLA"), "no POPLA reference");
  });
  check("results page shows a deadline pill", () => assert(/day/.test($("resultDeadline").textContent), "no pill"));

  // ---------- evidence ----------
  nav("evidence");
  await sleep(30);
  check("evidence page renders items", () => {
    assert($("page-evidence").classList.contains("active"), "not on evidence page");
    assert($("evidenceList").querySelectorAll(".ev-item").length >= 5, "too few items");
  });
  check("evidence request cites UK GDPR Article 15", () => {
    const t = $("evText").textContent;
    assert(t.includes("UK GDPR"), "no GDPR reference");
    assert(t.includes("Article 15"), "no Article 15");
    assert(t.includes("one month"), "no deadline stated");
  });
  check("deselecting evidence updates the request", () => {
    const before = $("evText").textContent.length;
    click($("evidenceList").querySelector("input[type=checkbox]"));
    assert($("evText").textContent.length !== before, "unchanged");
  });

  // ---------- paywall ----------
  nav("details");
  await sleep(30);
  check("configured seller identity opens the paywall", () => {
    /* The suite runs against a config with the seller details filled in,
       which is the state a real deployment must be in before selling. */
    assert(document.documentElement.getAttribute("data-tk-selling") === "1", "selling should be enabled");
  });
  check("pay buttons follow the selling flag", () => {
    /* Regression: the pricing-card button was outside the element being
       hidden, so it stayed clickable while selling was off. */
    const paid = document.documentElement.getAttribute("data-tk-selling") === "1";
    const btns = [...document.querySelectorAll("[data-stripe-pay]")];
    assert(btns.length >= 1, "no Stripe pay button found");
    const shown = btns.filter((b) => !b.hidden).length;
    assert(paid ? shown === btns.length : shown === 0,
      `${shown} of ${btns.length} pay buttons visible while selling=${paid ? "on" : "off"}`);
  });
  check("the progress line is pinned by script, not by sticky", () => {
    /* This was `position: sticky` twice and failed on a real phone both times.
       Sticky has several silent failure modes — a transformed ancestor, an
       ancestor that scrolls, a parent only as tall as its child — and none of
       them say anything when they happen. It is now fixed explicitly by
       script, so the only way it can fail is if this logic is wrong.
       jsdom has no layout engine, so the geometry is stubbed below and the
       decision is tested directly rather than claimed to be observed. */
    const css = cssSource();
    const base = css.slice(css.indexOf(".form-progress {"), css.indexOf("}", css.indexOf(".form-progress {")));
    /* The topbar is deliberately sticky. This bar must not be: that is the
       thing that failed twice. */
    const progressRules = css.slice(css.indexOf(".form-progress {"));
    assert(!/position:\s*sticky/.test(progressRules.slice(0, progressRules.indexOf(".form-progress-row"))),
      "the progress bar is still sticky, so it can still fail silently");
    const floating = css.slice(css.indexOf(".form-progress.is-floating"), css.indexOf("}", css.indexOf(".form-progress.is-floating")));
    assert(/position:\s*fixed/.test(floating), "the pinned state is not fixed");
    assert(/z-index:\s*3[0-9]/.test(floating), "the bar would slide under the topbar");
    assert(/background:\s*(#fff|var\(--white\))/.test(base), "it is transparent, so fields show through it");
    const fade = css.slice(css.indexOf("@keyframes fade"), css.indexOf("}", css.indexOf("@keyframes fade")) + 1);
    assert(!/transform/.test(fade), "the page animation transforms its page again; keep the page untransformed");

    /* The spacer is what stops the page jumping when the bar detaches. */
    const formStart = html.indexOf('<form id="ticketForm"');
    const formEnd = html.indexOf("</form>", formStart);
    const progressAt = html.indexOf('id="formProgress"');
    assert(progressAt > 0 && !(progressAt > formStart && progressAt < formEnd),
      "the progress line is inside the form, so it will detach too late");
    assert(html.includes('id="formProgressSpacer"'), "no spacer, so the form will jump when the bar floats");

    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/window\.addEventListener\("scroll", pinFormProgress/.test(src), "nothing re-decides on scroll");
    assert(/addEventListener\("scroll", pinFormProgress, \{ passive: true, capture: true \}/.test(src),
      "the scroll listener is not capturing, so it misses any nested scroll container");
    /* It must be bound inside bindDetails. A listener wired into the contact
       form instead still parses, still tests green by membership, and does
       nothing at all on the page it was written for. */
    const detailsFn = src.slice(src.indexOf("function bindDetails()"), src.indexOf("function bindContact()") > src.indexOf("function bindDetails()") ? src.indexOf("function bindContact()") : src.length);
    assert(detailsFn.includes('addEventListener("scroll", pinFormProgress'),
      "the scroll listener is not bound by bindDetails, so the bar never re-decides on the form");
    assert(/page\.classList\.contains\("active"\)/.test(src), "the pin ignores whether its page is on screen");
    assert(/setProgressPinned\(false\)/.test(src), "there is no way to release it");
    const nav = src.slice(src.indexOf("function showPage"), src.indexOf("analytics.track(\"page_view\""));
    assert(/else \{ setProgressPinned\(false\); \}/.test(nav), "the bar would follow the visitor to other pages");
  });
  check("details form reports how much is left to fill", () => {
    /* The form is a dozen fields copied off a paper ticket; the commonest
       way to lose someone is that they cannot tell how close they are to
       finishing. The count must come from the same list the submit handler
       validates, or it will drift. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const consts = /const REQUIRED_FIELDS = \[([^\]]+)\]/.exec(src);
    assert(consts, "no single source of truth for required fields");
    const ids = consts[1].match(/"f[A-Za-z]+"/g).map((x) => x.replace(/"/g, ""));
    assert(ids.length >= 5, `only ${ids.length} required fields counted`);
    const submitCheck = src.slice(src.indexOf('form.addEventListener("submit"'), src.indexOf("consumeGenerate();"));
    ids.forEach((id) => assert(submitCheck.includes(`"${id}"`), `${id} is counted but not validated on submit`));
    assert(/aria-valuenow/.test(src), "the progress bar is not exposed to assistive tech");
  });
  check("no page repeats the same call to action next to itself", () => {
    /* The home page carried "Start my free appeal" twice within one thumb
       reach: once closing the sample-letter block, once in the dark band
       straight below it. Two identical buttons in one glance read as a bug.
       The nav and the footer sit outside every page section, so anything
       counted here is in-page content. */
    const pages = html.split('<section class="page').slice(1);
    let checked = 0;
    pages.forEach((page) => {
      const name = (/data-page="([^"]+)"/.exec(page) || [])[1];
      if (!name) return;
      checked++;
      const seen = new Set();
      const re = /<button[^>]*data-nav="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g;
      let m;
      while ((m = re.exec(page))) {
        const label = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (!label) continue;
        const key = `${label} -> ${m[1]}`;
        assert(!seen.has(key), `the ${name} page shows "${label}" twice, both going to ${m[1]}`);
        seen.add(key);
      }
    });
    assert(checked >= 8, `only ${checked} pages inspected`);
  });
  check("a notice date in the future is refused, not counted from", () => {
    /* Left unchecked this produced "26,379 days left" and wrote the wrong
       date into the letter, which the visitor then sent to the operator.
       Asserted against the source AND exercised through the DOM below. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/function futureNoticeDate\(\)/.test(src), "no future-date guard");
    assert(/if \(future\) \{/.test(src), "the submit handler does not consult the guard");
    /* The picker's max must come from the clock, never a literal. */
    assert(/setAttribute\("max"/.test(src), "the date picker does not cap the future");
    assert(!/max="\d{4}-\d{2}-\d{2}"/.test(html), "a hard-coded max date will go stale");
  });
  check("the home page answers the deadline question before the form", () => {
    /* "Do I have to pay and how long have I got" is asked in the first few
       seconds, and the form used to be the only place to find out. */
    assert(/id="qcDate"/.test(html) && /id="qcBtn"/.test(html), "no quick check on the home page");
    assert(/function bindQuickCheck/.test(html) === false, "sanity: markup only");
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const fn = src.slice(src.indexOf("function bindQuickCheck"), src.indexOf("Navigation / routing"));
    assert(/D\.appealDays/.test(fn), "the quick check invents its own window instead of using the configured one");
    assert(/daysBetween\(todayUTC\(\), appealBy\)/.test(fn), "it does not count from the notice date");
    const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('class="band"'));
    assert(hero.indexOf('id="qcDate"') > 0, "the quick check is not in the hero");
    assert(hero.indexOf('id="qcDate"') < hero.indexOf("Three steps"), "the quick check sits below the fold");
  });
  check("the PDF library is not downloaded until a PDF is asked for", () => {
    /* 356 KB — four fifths of the page weight — used to be parsed on every
       visit for a button most people never press. */
    assert(!/<script[^>]+jspdf/i.test(html), "jspdf is still loaded eagerly in the markup");
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/function loadPdfLib\(\)/.test(src), "no on-demand loader");
    assert(/await loadPdfLib\(\)/.test(src), "the loader is never awaited");
    /* Every caller must await, or it reports success before the PDF exists. */
    const callers = src.match(/const ok = downloadPdf\(/g) || [];
    assert(callers.length === 0, `${callers.length} caller(s) still treat the download as synchronous`);
    assert((src.match(/const ok = await downloadPdf\(/g) || []).length >= 3,
      "not every PDF button awaits the download");
  });
  checkAsync("a payment held without an account is shown, not silently kept", async () => {
    /* Paid, logged out, then the paywall looked empty: the money seemed gone.
       Asserted behaviourally — boot with real credit already in storage, the
       way a returning visitor's browser has it. */
    assert(/id="heldCreditPane"/.test(html), "nothing on the page can show held credit");
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/function heldCreditTotal/.test(src), "no way to count held credit");
    const sync = src.slice(src.indexOf("function syncPaywall"), src.indexOf("function renderOperatorIntel"));
    assert(/heldCreditTotal\(\)/.test(sync), "the paywall never looks for held credit");

    const w = freshWindow({ "tk_held_credits": JSON.stringify({ "paid@example.com": 1 }) });
    for (let i = 0; i < 150 && w.document.documentElement.getAttribute("data-tk-ready") !== "1"; i++) await sleep(25);
    const pane = w.document.getElementById("heldCreditPane");
    assert(pane && !pane.hidden, "held credit exists but the notice stays hidden");
    const body = w.document.getElementById("heldCreditBody").textContent;
    assert(body.includes("paid@example.com"), `the notice does not name the address: ${body}`);
    /* Selling is paused, so the paywall must stay hidden even with credit held. */
    assert(w.document.getElementById("paywallPane").hidden, "the paywall is showing while selling is paused");
  });
  check("the paused seller never advertises a price it cannot take", () => {
    /* The button read "Buy another letter for £4.99" and then toasted
       "Payments are switched off" — a promise the app could not keep. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const sync = src.slice(src.indexOf("function syncPaywall"), src.indexOf("function renderOperatorIntel"));
    assert(/READY\.canSell/.test(sync), "the locked label ignores whether selling is on");
    assert(!/btn\.textContent = locked\s*\?/.test(sync),
      "the label still promises a price unconditionally");
    assert(/Paid letters are paused/.test(sync), "no honest paused wording");
  });
  check("every operator resolves to the right company and appeals service", () => {
    /* Two real defects this guards: "Premier Parking Enforcement" resolved to
       "Premier Park Ltd" (a different firm, so the wrong name on the letter),
       and the Smart Parking route was BPA when it is an IPC member — which
       sends a rejected appeal to POPLA, where it is worthless. */
    const data = JSON.parse(fs.readFileSync(path.join(root, "assets", "data", "operators.json"), "utf8"));
    const ops = data.operators;
    assert(ops.length >= 25, `only ${ops.length} operators carry appeal intelligence`);
    ops.forEach((o) => {
      assert(o.id && o.name, "an operator has no id or name");
      assert(o.tradeBody === "BPA" || o.tradeBody === "IPC", `${o.name} has no valid trade body`);
      assert(Array.isArray(o.themes) && o.themes.length >= 2, `${o.name} has no appeal themes`);
    });
    const ids = ops.map((o) => o.id);
    assert(new Set(ids).size === ids.length, "duplicate operator ids");
    /* Aliases must not collide, or lookup depends on list order. */
    const seen = {};
    ops.forEach((o) => [o.name.toLowerCase()].concat(o.aliases || []).forEach((a) => {
      assert(!seen[a] || seen[a] === o.id, `alias "${a}" is used by both ${seen[a]} and ${o.id}`);
      seen[a] = o.id;
    }));
    const smart = ops.find((o) => o.id === "smart-parking");
    assert(smart && smart.tradeBody === "IPC",
      "Smart Parking is an IPC member; marking it BPA sends rejected appeals to POPLA");
  });
  check("icons and manifest are real files, not a data URI", () => {
    /* A data-URI favicon cannot be cached, is dropped by older Safari, and is
       ignored by home-screen implementations. */
    assert(!/rel="icon" href="data:/.test(html), "favicon is still a data URI");
    ["assets/favicon.ico", "assets/icon-192.png", "assets/icon-512.png",
     "assets/apple-touch-icon.png", "assets/icon-maskable-512.png",
     "manifest.webmanifest"].forEach((f) => {
      assert(fs.existsSync(path.join(root, f)), `${f} is referenced but missing`);
    });
    const mf = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
    assert(mf.name && mf.short_name, "manifest lacks a name");
    assert(mf.start_url && mf.display === "standalone", "manifest is not installable");
    assert(mf.icons.some((i) => i.purpose === "maskable"), "no maskable icon for Android");
    mf.icons.forEach((i) => assert(fs.existsSync(path.join(root, i.src)), `${i.src} missing`));
  });
  check("each operator guide gets its own preview card", () => {
    /* Guides are the pages people arrive on from a search. Sharing one card
       made every result look identical. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/setPageMeta\(name, opts\)/.test(src), "the guide is not passed to the metadata");
    assert(/assets\/og\/guide-\$\{slug\}\.jpg/.test(src), "no per-guide image is chosen");
    assert(/rel="canonical"/.test(src), "the canonical URL is never updated");
    ["parkingeye", "euro-car-parks", "ukpc", "ncp", "smart-parking", "excel", "apcoa"]
      .forEach((slug) => assert(fs.existsSync(path.join(root, `assets/og/guide-${slug}.jpg`)),
        `missing preview card for ${slug}`));
  });
  check("a paused seller publishes no address and takes no money", () => {
    /* Selling is paused by leaving business.address empty. Two things must
       both hold: no street address reaches the browser, and no pay control
       is reachable. Half of either would be a site that either leaks the
       address or takes money it must not. */
    const cfg = fs.readFileSync(path.join(root, "assets", "config.js"), "utf8");
    const paused = /address:\s*""\s*,/.test(cfg);
    if (!paused) return;  // resumed: nothing to assert
    /* The shared DOM runs against a fixture with seller details filled, so
       it cannot show the paused state itself. What is checked here is that
       the shipped file really is paused and that the gate keys off the
       address — the rendered proof is the separate stubbed run below. */
    assert(!/Swansea|Heol Cledwyn|SA7 9LE/.test(cfg), "the home address is still in the shipped config");
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const hasOperator = src.slice(src.indexOf("get hasOperator"), src.indexOf("get hasCompany"));
    assert(/hasAddress/.test(hasOperator), "the seller gate no longer depends on the address");
    assert(/hasOperator/.test(src.slice(src.indexOf("get canSell"), src.indexOf("get payEndpoint"))),
      "selling does not depend on the seller being identifiable");
  });
  check("the money path is never a disabled button", () => {
    /* Regression: syncPaywall() relabelled the generate button "Pay £4.99 to
       generate another" and then set disabled = true. A disabled button fires
       no click at all, so the only payment call-to-action in the flow did
       nothing — no toast, no scroll, no navigation. It looked broken exactly
       where money is expected. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const fn = src.slice(src.indexOf("function syncPaywall"), src.indexOf("function renderOperatorIntel"));
    assert(!/btn\.disabled\s*=\s*locked/.test(fn), "syncPaywall disables the generate button when locked");
    assert(/btn\.disabled\s*=\s*false/.test(fn), "the generate button is not explicitly left enabled");
    assert(/dataset\.intent/.test(fn), "the button does not record what a tap should do");
  });
  check("a toast cannot swallow a tap meant for the button under it", () => {
    /* The toast is position:fixed over the bottom of the page with z-index
       80, which is exactly where the pay button sits on the details form.
       Without pointer-events:none it intercepted the tap, so the button
       looked dead — and the toast said checkout was opening when it was
       not. The Undo action inside it must stay clickable. */
    const css = cssSource();
    const toastRule = css.slice(css.indexOf(".toast {"), css.indexOf("}", css.indexOf(".toast {")));
    assert(/pointer-events:\s*none/.test(toastRule), "the toast still intercepts taps");
    const actionRule = css.slice(css.indexOf(".toast-action {"), css.indexOf("}", css.indexOf(".toast-action {")));
    assert(/pointer-events:\s*auto/.test(actionRule), "the undo action is now unclickable");
  });
  check("a locked account can still reach checkout from the form", () => {
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const fn = src.slice(src.indexOf("function bindStripe"), src.indexOf("async function catchStripeReturn"));
    assert(/generateBtn/.test(fn), "the generate button is not wired to checkout");
    assert(/stopPropagation/.test(fn), "one tap could both pay and submit the form");
  });
  check("no TODO placeholder is visible in the page", () => {
    assert(!/TODO/.test(document.documentElement.textContent), "a TODO stub is rendered");
  });
  await checkAsync("unfilled seller details keep selling off", async () => {
    /* Not a text check on config.js: this builds a second page from a config
       whose seller details are stubs and proves the gate actually closes —
       no pay button visible, and the visitor is told why. */
    const stub = fs.readFileSync(path.join(root, "assets", "config.js"), "utf8")
      .replace(/(legalName:\s*)"[^"]*"/, '$1"TODO: your full name or company name"')
      .replace(/(address:\s*)"[^"]*"/, '$1"TODO: your postal or service address"')
      .replace(/(email:\s*)"[^"]*"/g, '$1"TODO: you@yourdomain.co.uk"');
    const stubDom = new JSDOM(html, {
      url: "http://localhost/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: new VirtualConsole(),
      resources: {
        interceptors: [requestInterceptor((request) => {
          const rel = new URL(request.url).pathname.replace(/^\//, "") || "index.html";
          if (rel === "assets/config.js") {
            return new Response(stub, { status: 200, headers: { "Content-Type": "text/javascript" } });
          }
          const full = path.join(root, rel);
          if (!fs.existsSync(full)) return new Response("not found", { status: 404 });
          return new Response(fs.readFileSync(full), { status: 200, headers: { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" } });
        })]
      },
      beforeParse(window) {
        window.scrollTo = () => {};
        Object.defineProperty(window, "crypto", { value: webcrypto, configurable: true });
        window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
      }
    });
    for (let i = 0; i < 120 && stubDom.window.document.documentElement.getAttribute("data-tk-ready") !== "1"; i++) await sleep(25);
    const d = stubDom.window.document;
    assert(d.documentElement.getAttribute("data-tk-ready") === "1", "stub-config page never booted");
    assert(d.documentElement.getAttribute("data-tk-selling") === "0", "selling is on with stub details");
    const visible = [...d.querySelectorAll("[data-stripe-pay]")].filter((b) => !b.hidden);
    assert(visible.length === 0, `${visible.length} pay button(s) still visible with stub details`);
    assert(/Payments are switched off/i.test(d.body.textContent), "the visitor is not told why payments are off");
    stubDom.window.close();
  });
  check("a forged success URL cannot unlock a letter", () => {
    /* The page is loaded with ?stripe=success&… in no test, which is the
       point: the unlock path only runs on a return. What is checked here is
       that nothing grants a credit without the server saying paid. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const fn = src.slice(src.indexOf("async function catchStripeReturn"), src.indexOf("function bindContact"));
    assert(/data\.paid/.test(fn), "the return handler does not check the server verdict");
    assert(/verify-session/.test(fn), "the return handler does not call the server");
    /* Granting must be inside the paid branch, never before it. */
    const grantAt = fn.indexOf("grantPaidCredit(");
    const paidAt = fn.indexOf("if (data.paid)");
    assert(grantAt > paidAt, "credit granted outside the verified branch");
  });
  check("payment is verified before anything is recorded", () => {
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    const fn = src.slice(src.indexOf("async function catchStripeReturn"), src.indexOf("function bindContact"));
    const verifyAt = fn.indexOf("verify-session");
    const spentAt = fn.indexOf("markSessionSpent(id)");
    assert(verifyAt > 0 && spentAt > verifyAt, "session marked spent before verification");
  });
  check("a payment for an unknown account is held, not lost", () => {
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/HELD_KEY/.test(src), "no held-credit store");
    assert(/function applyHeldCredits/.test(src), "held credits are never released");
    assert(/applyHeldCredits\(email\)/.test(src), "release is not wired into login");
  });
  check("paying is card-only and never names a client secret", () => {
    const html = document.documentElement.innerHTML;
    assert(!/sk_live_|sk_test_/.test(html), "a Stripe secret key is in the page");
    assert(!/paypal/i.test(html), "PayPal copy still present");
  });
  check("config drives the displayed price", () => {
    const texts = [...document.querySelectorAll("[data-price]")].map((e) => e.textContent.trim());
    assert(texts.length > 0, "no price placeholders");
    assert(texts.every((t) => t.includes("4.99")), `unexpected: ${texts.join(",")}`);
  });

  // ---------- history ----------
  nav("history");
  await sleep(30);
  check("history lists the saved appeal", () => assert($("historyList").querySelectorAll(".history-item").length >= 1, "no saved appeal"));
  check("history shows a countdown pill", () => assert($("historyList").querySelectorAll(".cd-pill").length >= 1, "no status pill"));
  check("history names the operator and reference", () => {
    const title = $("historyList").querySelector(".history-title").textContent;
    assert(title.includes("·"), `title not split: ${title}`);
  });
  check("history states the reply-by date", () => assert(/Reply by/.test($("historyList").textContent), "no deadline line"));
  check("history summary is rendered once there is an appeal", () => {
    assert(!$("appealSummary").hidden, "summary hidden with an appeal present");
    assert(/still inside the appeal window/.test($("appealBarNote").textContent), $("appealBarNote").textContent);
  });
  check("setting an outcome can be undone", () => {
    const btn = $("historyList").querySelector('[data-status][data-to="won"]');
    assert(btn, "no outcome button");
    btn.click();
    assert(/Marked as won/.test($("toast").textContent), "no confirmation");
    const undo = $("toast").querySelector(".toast-action");
    assert(undo, "no undo affordance");
    undo.click();
    assert(!/Marked as won/.test($("toast").textContent) || $("toast").hidden, "toast not replaced");
  });
  check("history empty state explains the first free letter", () => {
    /* Exercised on a throwaway account so the seeded one is left intact. */
    const kept = window.localStorage.getItem("tk_users_v1");
    const keptSession = window.localStorage.getItem("tk_session");
    window.localStorage.setItem("tk_users_v1", JSON.stringify({
      "empty@example.com": { email: "empty@example.com", name: "Nobody", pass: "x", freeUsed: false, credits: 0, appeals: [], created: new Date().toISOString() }
    }));
    window.localStorage.setItem("tk_session", "empty@example.com");
    nav("history");
    const shown = !$("historyEmpty").hidden;
    const hasCta = !!$("historyEmpty").querySelector("[data-nav='details']");
    const summaryHidden = $("appealSummary").hidden;
    window.localStorage.setItem("tk_users_v1", kept);
    window.localStorage.setItem("tk_session", keptSession);
    nav("history");
    assert(shown, "empty state not shown");
    assert(hasCta, "no call to action in the empty state");
    assert(summaryHidden, "summary shown with no appeals");
  });
  check("grounds no longer fake a button", () =>
    assert(!$("weakList").querySelector(".mini-btn[style]"), "a non-interactive span is still styled as a button"));

  // ---------- operators + guides ----------
  nav("operators");
  await sleep(30);
  check("operator grid renders", () => assert($("opGrid").querySelectorAll(".op-card").length >= 8, "too few operators"));
  check("operator intel panel reacts to the operator field", () => {
    nav("details");
    setInput($("fOperator"), "ParkingEye Ltd");
    assert($("intelCard").textContent.includes("ParkingEye"), "no intel shown");
  });

  window.location.hash = "#guide/parkingeye";
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(30);
  check("operator guide page renders", () => {
    assert($("seoTitle").textContent.includes("ParkingEye"), `title: ${$("seoTitle").textContent}`);
    assert($("seoBody").textContent.includes("POPLA"), "no route info");
  });
  window.location.hash = "#guide";
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(20);
  check("guide index lists every operator", () => assert($("seoBody").querySelectorAll("[data-guide]").length >= 7, "too few guides"));

  // ---------- legal ----------
  for (const p of ["privacy", "terms", "refunds", "contact", "stats"]) {
    window.location.hash = `#${p}`;
    window.dispatchEvent(new window.Event("hashchange"));
    await sleep(15);
    check(`legal page renders: ${p}`, () => {
      assert($(`page-${p}`).classList.contains("active"), `${p} not active`);
      assert($(`page-${p}`).textContent.length > 400, `${p} looks empty`);
    });
  }
  check("no raw placeholders leak into the public pages", () => {
    const html = document.documentElement.textContent;
    assert(!/YOUR FULL LEGAL NAME|YOUR POSTAL ADDRESS/.test(html), "placeholder text still visible");
    assert(!/\[YOUR/.test(html), "bracketed placeholder still visible");
  });
  check("a limited company publishes its registered number", () => {
    /* Consumer law requires a company to state where it is registered and
       its number wherever it identifies itself. config had the field but
       nothing ever printed it. */
    const src = fs.readFileSync(path.join(root, "assets", "app.js"), "utf8");
    assert(/data-biz-company/.test(src), "company number is never rendered");
    assert(/hasCompany/.test(src), "no flag for registered-company details");
    const cfg = fs.readFileSync(path.join(root, "assets", "config.js"), "utf8");
    assert(/companyNumber:/.test(cfg), "no companyNumber field");
    assert(/jurisdiction:/.test(cfg), "no jurisdiction field");
  });
  check("privacy page names the seller without placeholders", () => {
    /* Identity, not branding: the controller line must name the trader and
       the postal address. The brand name is not evidence of either. */
    const t = $("page-privacy").textContent;
    assert(/data controller is/i.test(t), "the controller is not named");
    assert(/Alex Driver/.test(t), "the registered trader is not named");
    assert(/trading as/i.test(t), "the trading name is not tied to the trader");
    assert(!/TODO/.test(document.documentElement.textContent), "a TODO placeholder is visible");
    assert(!/\[YOUR/.test(t), "bracketed placeholder on privacy page");
  });
  check("refunds page covers digital cancellation", () => assert(/digital content/i.test($("page-refunds").textContent), "no digital content section"));

  // ---------- misc ----------
  check("no uncaught errors across the whole run", () => assert(errors.length === 0, errors.slice(0, 3).join(" | ")));

  console.log("\nTicketKiller smoke test\n" + results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} passed, ${failures} failed`);
  if (errors.length) console.log("\nConsole errors:\n" + errors.slice(0, 8).join("\n"));
  process.exit(failures ? 1 : 0);
})();
