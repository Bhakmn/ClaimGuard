/**
 * OAuth popup page renderer.
 *
 * Produces the minimal HTML pages the OAuth popup windows need.
 * All pages use `window.opener.postMessage` to communicate with the parent
 * and then close themselves.
 *
 * Security rules (§4.6):
 *  - Every value from a query param or upstream body is truncated to 200 chars
 *    then HTML-escaped before insertion into the page.
 *  - `</` sequences inside script text are escaped so an injected value cannot
 *    terminate the script element early.
 *  - No dynamic value is placed inside a script block; only config-sourced
 *    values (APP_BASE_URL) appear there.
 *  - postMessage target is always APP_BASE_URL, never "*".
 *  - postMessage payload is exactly { type: "tiktok-connected" }.
 */

/* ── HTML escaping ───────────────────────────────────────────────────────── */

/**
 * Escape a string for safe insertion into an HTML text node or attribute.
 * Replaces &, <, >, ", and '.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Truncate `s` to at most `max` characters then HTML-escape.
 * Use this for any value taken from a request or upstream response.
 */
export function escapeHtmlTrunc(s: string, max = 200): string {
  return escapeHtml(s.length > max ? s.slice(0, max) : s);
}

/* ── Page rendering ──────────────────────────────────────────────────────── */

/**
 * Render the success page sent to the TikTok OAuth popup after the callback
 * completes. The page posts `{ type: "tiktok-connected" }` to `window.opener`
 * and immediately closes.
 *
 * `appOrigin` must be the exact origin the frontend is served from (no trailing
 * slash), e.g. "https://app.example.com". It is serialised with JSON.stringify
 * so it is a properly quoted, escaped JavaScript string literal — never a bare
 * value, never "*".
 *
 * The success script only contains the config-sourced `appOrigin`. No value
 * from the request or from TikTok is inserted.
 */
export function renderTikTokSuccessPage(appOrigin: string): string {
  // Serialise origin as a safe JS string literal.
  const originLiteral = JSON.stringify(appOrigin);
  return `<!doctype html>
<meta charset="utf-8">
<title>ClaimGuard \xd7 TikTok</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#F4F1EA;color:#1F1F1F">
<p>TikTok connected. You can close this window.</p>
<script>if(window.opener){window.opener.postMessage({type:"tiktok-connected"},${originLiteral});}window.close();</script>
</body>`;
}

/**
 * Render the failure page for the TikTok OAuth popup.
 *
 * `message` should already be truncated to 200 chars; it is HTML-escaped here
 * before insertion.  No message is posted to the opener — the button stays on
 * "Connect TikTok" to prompt a retry.
 *
 * `status` is sent as the HTTP status by the caller (400 or 500 depending on
 * the failure type).
 */
export function renderTikTokFailurePage(message: string): string {
  const safeMsg = escapeHtml(message);
  return `<!doctype html>
<meta charset="utf-8">
<title>ClaimGuard \xd7 TikTok</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#F4F1EA;color:#1F1F1F">
<p>${safeMsg}</p>
<script>setTimeout(function(){window.close()},4000)</script>
</body>`;
}

/**
 * @deprecated Use renderTikTokFailurePage.
 * Kept for any callers that still reference the old name.
 */
export function renderOAuthErrorPage(reason: string): string {
  return renderTikTokFailurePage(reason);
}
