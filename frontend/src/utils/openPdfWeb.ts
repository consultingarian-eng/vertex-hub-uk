/**
 * Open a PDF we already hold as base64, in the browser / installed PWA.
 *
 * Why this isn't a one-liner — the obvious version fails on phones:
 *
 *   • `window.open()` after an `await` is a POPUP. The tap that started
 *     things has long since expired, so mobile browsers return null and the
 *     PDF silently never appears. The window has to be opened synchronously,
 *     while the tap is still "warm", and pointed at the file afterwards.
 *   • A `data:` URL can't be navigated to at the top level in Safari (blocked
 *     since iOS 12), and iOS won't render a PDF inside an <iframe> either, so
 *     the data-URL-in-an-iframe trick shows a blank page. A `blob:` URL is
 *     same-origin and renders natively.
 *   • In a standalone PWA there may be no tab to open at all, so we fall back
 *     to a download link, which hands off to the iOS share/preview sheet.
 *
 * Returns a short reason string when nothing could be shown, so the caller can
 * surface it instead of failing silently.
 */

/** Decode base64 into a Blob. Byte-at-a-time on purpose: the usual
 *  `String.fromCharCode.apply(null, bytes)` shortcut overflows the stack on
 *  multi-MB files, which is exactly the size these documents run to. */
function base64ToBlob(b64: string): Blob {
  const clean = b64.includes(',') ? b64.split(',')[1] : b64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Always application/pdf, whatever the server or file says: the blob opens
  // on the app's own origin, so an HTML or SVG type here could run script.
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}

/**
 * Reserve a tab BEFORE any awaiting, so the browser still counts it as
 * user-initiated. Call this first thing in the tap handler; pass the result to
 * `openPdfWeb`. Null is fine — there's a download fallback.
 */
export function reservePdfTab(): Window | null {
  try {
    const w = window.open('', '_blank');
    if (w) {
      // Something to look at while the file downloads.
      w.document.write(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Opening…</title><body style="margin:0;display:flex;align-items:center;' +
        'justify-content:center;height:100vh;font:15px -apple-system,system-ui,sans-serif;' +
        'color:#6b6478;background:#f4f7ec">Opening…</body>'
      );
    }
    return w;
  } catch {
    return null;
  }
}

export function openPdfWeb(
  b64: string,
  _mime: string,   // ignored: always opened as application/pdf
  fileName: string,
  reserved: Window | null,
): string | null {
  let url: string;
  try {
    url = URL.createObjectURL(base64ToBlob(b64));
  } catch {
    return 'Could not read that file.';
  }

  // Give the browser time to hand the blob off before we revoke it. Revoking
  // too early leaves a blank tab.
  const revokeLater = () => setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60_000);

  if (reserved && !reserved.closed) {
    try {
      reserved.location.href = url;
      revokeLater();
      return null;
    } catch {
      try { reserved.close(); } catch {}
    }
  }

  // No tab (popup blocked, or a standalone PWA with nowhere to open): fall
  // back to a download, which iOS turns into its preview / share sheet.
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'document.pdf';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    revokeLater();
    return null;
  } catch {
    revokeLater();
    return 'Your browser blocked the file from opening. Allow pop-ups for this site and try again.';
  }
}
