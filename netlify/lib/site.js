/* Which origins may call these functions, and where to send the visitor back.
 *
 * SITE_URL is a comma-separated list of full site URLs. A single value still
 * works, so existing deployments need no change.
 *
 * The old behaviour used SITE_URL for both CORS and the post-payment return,
 * which broke as soon as the site was served from more than one host (GitHub
 * Pages and a Netlify deploy both serve it). The request's Origin now picks
 * the matching entry, so the visitor returns to the host they started on.
 */

const parse = (raw) =>
  String(raw || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const originOf = (url) => {
  try { return new URL(url).origin; } catch { return ""; }
};

/* Returns { allow, base } where:
 *   allow — the value for Access-Control-Allow-Origin ("" when unconfigured)
 *   base  — the site root to send the visitor back to ("" when unconfigured)
 */
function resolve(requestOrigin, siteUrl = process.env.SITE_URL) {
  const list = parse(siteUrl);
  if (!list.length) return { allow: "", base: "" };

  /* Exact origin match, so a lookalike host cannot borrow the allowlist. */
  const hit = list.find((u) => originOf(u) === requestOrigin);
  if (hit) return { allow: requestOrigin, base: hit };

  /* An unknown or absent Origin (curl, webhook) falls back to the first
     entry. That is correct for the return URL and harmless for CORS, since
     a browser will still only expose the response to an allowed origin. */
  return { allow: originOf(list[0]), base: list[0] };
}

module.exports = { resolve, parse, originOf };
