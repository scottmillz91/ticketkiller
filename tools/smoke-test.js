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
const localServer = requestInterceptor((request) => {
  const rel = new URL(request.url).pathname.replace(/^\//, "") || "index.html";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const setInput = (el, v) => {
  el.value = v;
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
  el.dispatchEvent(new window.Event("change", { bubbles: true }));
};
const nav = (dest) => click(document.querySelector(`#mobileNav [data-nav="${dest}"]`) || document.querySelector(`[data-nav="${dest}"]`));

(async () => {
  for (let i = 0; i < 120 && document.documentElement.getAttribute("data-tk-ready") !== "1"; i++) await sleep(25);

  check("app boots", () => assert(document.documentElement.getAttribute("data-tk-ready") === "1", "boot flag never set"));
  check("no runtime errors during boot", () => assert(errors.length === 0, errors.slice(0, 3).join(" | ")));
  check("operator datalist populated from JSON", () => {
    const n = $("operatorList").querySelectorAll("option").length;
    assert(n > 5, `only ${n} operators`);
  });
  check("sample preview renders with real content", () => {
    const t = $("sampleLetter").textContent;
    assert(t.includes("ParkingEye"), "no operator in sample");
    assert(t.includes("T128719"), "no PCN reference");
    assert(t.includes("registered keeper"), "no keeper declaration");
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
  check("ground count reflects selection", () => assert(/of 8 grounds/.test($("weakCount").textContent), $("weakCount").textContent));
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
  check("paywall appears after the free letter is used", () => {
    assert($("paywallPane").hidden === false, "paywall hidden");
    assert($("generateBtn").disabled === true, "generate still enabled");
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
  check("legal pages flag operator placeholders", () => assert($("page-privacy").textContent.includes("YOUR FULL LEGAL NAME"), "placeholder warning missing"));
  check("refunds page covers digital cancellation", () => assert(/digital content/i.test($("page-refunds").textContent), "no digital content section"));

  // ---------- misc ----------
  check("no uncaught errors across the whole run", () => assert(errors.length === 0, errors.slice(0, 3).join(" | ")));

  console.log("\nTicketKiller smoke test\n" + results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} passed, ${failures} failed`);
  if (errors.length) console.log("\nConsole errors:\n" + errors.slice(0, 8).join("\n"));
  process.exit(failures ? 1 : 0);
})();
