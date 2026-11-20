// Detects bot walls in code, so a blocked carrier is closed as `blocked` without spending model turns.
// Three signals: a network error typical of anti-bot resets, a 403/429 main document, or wall text on the page.

// Network errors that anti-bot layers (Akamai etc.) produce by resetting the connection. Timeouts and DNS
// failures are NOT here: those are `failed`, not `blocked`.
const BLOCK_NET_ERRORS = /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_QUIC_PROTOCOL_ERROR/;

// The start page answered the automated browser with a file download instead of a page (UPS, 2026-11-18).
// Recorded verbatim as the close reason (status failed: a probable block, not a proven bot wall).
export const DOWNLOAD_REASON = "probable bloqueo: responde con una descarga al navegador automatizado";

export function blockFromNavError(message: string): string | null {
  const m = message.match(BLOCK_NET_ERRORS);
  return m ? `the site refused the connection (${m[0]}), typical of anti-bot protection` : null;
}

export function blockFromStatus(main: { status: number; url: string } | undefined): string | null {
  if (!main) return null;
  if (main.status === 403) return `the site answered 403 Forbidden to the page request (${main.url})`;
  if (main.status === 429) return `the site answered 429 Too Many Requests to the page request (${main.url})`;
  return null;
}

// Phrases that only appear on wall pages.
const WALL_PHRASES = [
  /access denied/i,
  /acceso denegado/i,
  /you don.t have permission to access/i,
  /verify (that )?you are (a )?human/i,
  /verifica(r)? que eres (un )?humano/i,
  /are you a robot/i,
  /no eres un robot/i,
  /unusual traffic/i,
  /tr[aá]fico inusual/i,
  /pardon our interruption/i,
  /checking (if the site connection is secure|your browser)/i,
  /attention required/i,
  /request unsuccessful\. incapsula/i,
  /press (&|and) hold/i,
  /mant[eé]n presionado/i,
  /please enable js and disable any ad blocker/i,
];
// Legal footer of sites that merely USE reCAPTCHA on a form; not a wall.
const RECAPTCHA_FOOTER = /this site is protected by recaptcha[^.]*\.?|este sitio est[aá] protegido por recaptcha[^.]*\.?/gi;
// A bare "captcha" counts only on a short page (a wall is short; a real form page with a captcha notice is long).
const SHORT_PAGE_CHARS = 800;

export function blockFromText(visibleText: string): string | null {
  const text = visibleText.replace(RECAPTCHA_FOOTER, " ");
  for (const re of WALL_PHRASES) {
    const m = text.match(re);
    if (m) return `the page shows an anti-bot wall ("${m[0]}")`;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length < SHORT_PAGE_CHARS && /captcha/i.test(compact)) return "the page shows only a captcha challenge";
  return null;
}
