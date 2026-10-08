/**
 * Deliver a generated PDF to the user, cross-platform.
 *
 *   • Native (iOS/Android): the OS share sheet (save / AirDrop / Files / etc.).
 *   • Web: print the generated HTML IN PLACE — a print-only host div is
 *     injected into the current document and everything else is hidden with
 *     `@media print` CSS. This replaces the old approach of printing a popup
 *     tab: popups get blocked whenever the export isn't triggered by a tap
 *     (e.g. ?autoshare=1 flows), and expo-print's hidden-iframe fallback makes
 *     iOS Safari print the parent app page instead — with browser URL
 *     headers/footers, white margins, and the content spilling onto 2 pages.
 *
 * Single-page portrait documents (opts.width/height with height > width, e.g.
 * the 612×1008 bulletins) are additionally scaled to exactly fill ONE A4
 * page on web, mirroring the native printToFileAsync custom-page-size output —
 * Safari ignores `@page size` so tall designs would otherwise paginate.
 */
import { Platform } from 'react-native';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
// Static on purpose: a lazy chunk can 404 in a stale PWA session after a
// deploy replaces the hashed files, and a failed import here aborts the whole
// image export into the ugly window.print() fallback. Loading it with the
// bundle means the capture path can't lose its renderer mid-session.
import { toPng } from 'html-to-image';
import { APP_NAME } from '../theme/brand';

const HOST_ID = 'cg1-print-host';
// A4 page in pt / px (1pt = 4/3 px in CSS).
const PAGE_W_PT = 595;
const PAGE_H_PT = 842;
const PT_TO_PX = 4 / 3;

/**
 * Kept for call-site compatibility: printing no longer needs a popup window
 * (we print in place), so this is now a no-op. Callers that stored a window
 * from an older bundle still work — exportPdfFromHtml closes it.
 */
export function openBlankPrintWindow(): Window | null {
  return null;
}

/** Wait until every <img> inside el has settled (loaded or errored), max waitMs. */
function waitForImages(el: HTMLElement, waitMs: number): Promise<void> {
  const pending = Array.from(el.querySelectorAll('img')).filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const timer = setTimeout(() => resolve(), waitMs);
    const done = () => {
      left -= 1;
      if (left <= 0) { clearTimeout(timer); resolve(); }
    };
    pending.forEach((img) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  });
}

/** Parse the generated HTML and mount it off-screen in the live document
 *  (so fonts/images resolve and it can be measured). Returns the mounted
 *  nodes + the document's own CSS; caller adds behaviour-specific styles. */
function mountHtml(html: string, fixedWidthPt: number | null): { host: HTMLDivElement; inner: HTMLDivElement; srcCss: string; style: HTMLStyleElement } {
  // A previous export may still be tearing down — clear it.
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(`${HOST_ID}-style`)?.remove();

  const src = new DOMParser().parseFromString(html, 'text/html');
  const srcCss = Array.from(src.querySelectorAll('style')).map((s) => s.textContent || '').join('\n');
  // Body-level background (dark bulletin designs) must survive the move
  // onto a plain div.
  const bodyBg = src.body.getAttribute('style') || '';

  const host = document.createElement('div');
  host.id = HOST_ID;
  const inner = document.createElement('div');
  if (fixedWidthPt) inner.style.width = `${fixedWidthPt}pt`;
  if (bodyBg) inner.setAttribute('style', `${bodyBg};${inner.getAttribute('style') || ''}`);
  while (src.body.firstChild) inner.appendChild(document.adoptNode(src.body.firstChild));
  host.appendChild(inner);

  const style = document.createElement('style');
  style.id = `${HOST_ID}-style`;
  return { host, inner, srcCss, style };
}

// ── Web image export ──────────────────────────────────────────────────────
// Installed PWAs (and mobile browsers generally) can't be trusted with
// window.print(): iOS standalone mode prints the app shell — the "browser
// state" — instead of the injected document. So on those devices we render
// the SAME generated HTML to a high-res PNG (html-to-image) and hand it to
// the share sheet: from there it AirPrints on exactly one page, saves to
// Photos, or sends to WhatsApp. Desktop browsers keep the print dialog,
// which works properly there.
function isStandalonePwa(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)')?.matches || (navigator as any).standalone === true;
  } catch { return false; }
}
function isMobileLike(): boolean {
  try {
    return /iphone|ipad|ipod|android/i.test(navigator.userAgent) || window.matchMedia?.('(pointer: coarse)')?.matches;
  } catch { return false; }
}
function shouldExportImage(): boolean {
  return isStandalonePwa() || isMobileLike();
}

async function shareHtmlAsImage(html: string, opts: { filename: string; dialogTitle: string; width?: number; height?: number; sizeToContent?: boolean; imageAsPdf?: boolean }): Promise<void> {
  // The PNG is normally a full PAGE, not a content-sized strip: callers with
  // a custom page (612×1008 bulletins) get exactly that; letters get A4
  // portrait. Printing the image full-bleed then reproduces the intended
  // physical size. `sizeToContent` opts OUT of the page for content-shaped
  // exports (the badges): the file is the design itself, not a mostly-white
  // page with the design in one corner.
  const widthPt = opts.width || PAGE_W_PT;
  const pageHPt = opts.height || PAGE_H_PT;
  const { host, inner, srcCss, style } = mountHtml(html, widthPt);
  inner.classList.add('cg1-print-body');
  // The templates style `body` (bulletin backgrounds, badge page margins…)
  // — that body is now our capture div, so retarget those selectors.
  const scopedCss = srcCss.replace(/(^|[}\s,])body(?=[\s,{.:#[])/g, `$1#${HOST_ID} .cg1-print-body`);
  // Page frame: exact page size (or the content's own height), clips
  // overflow, white paper behind anything the design doesn't cover.
  const frame = document.createElement('div');
  frame.style.cssText = `width:${widthPt}pt;${opts.sizeToContent ? '' : `height:${pageHPt}pt;`}overflow:hidden;background:#ffffff;`;
  host.appendChild(frame);
  frame.appendChild(inner); // moves inner inside the frame
  style.textContent = `
${scopedCss}
#${HOST_ID} { position: fixed; left: -10000px; top: 0; width: ${widthPt}pt; }
`;
  document.head.appendChild(style);
  document.body.appendChild(host);

  try {
    // Custom fonts must be ready BEFORE the snapshot, or WebKit falls back
    // to system fonts and the layout drifts.
    try { await (document as any).fonts?.ready; } catch { /* ignore */ }
    // Inline remote avatars/logos as data URIs — html-to-image drops any
    // <img> it can't re-fetch (CORS), which loses profile pictures.
    // Best-effort: a stale PWA session can hold a page whose lazy-chunk URLs
    // died with the last deploy, so the import itself can reject — that must
    // not abort the export (worst case the capture misses a remote image;
    // aborting would dump the user into the window.print() fallback, which
    // iOS renders with URL headers and a stray second page).
    try {
      const { remoteImageDataUri } = await import('./remoteImageDataUri');
      await Promise.all(
        Array.from(inner.querySelectorAll('img'))
          .filter((img) => /^https?:/i.test(img.getAttribute('src') || ''))
          .map(async (img) => {
            const inlined = await remoteImageDataUri(img.getAttribute('src') || '');
            if (inlined.startsWith('data:')) img.setAttribute('src', inlined);
          }),
      );
    } catch { /* ignore — capture proceeds with whatever loads */ }
    await waitForImages(inner, 1500);

    const wPx = Math.round(widthPt * PT_TO_PX);
    let hPx = Math.round(pageHPt * PT_TO_PX);
    const contentH = Math.max(1, inner.scrollHeight);
    if (opts.sizeToContent) {
      // The capture is exactly as tall as the rendered content — no page,
      // no fit-scaling.
      hPx = contentH;
      frame.style.height = `${contentH}px`;
    } else if (contentH > hPx) {
      // Content taller than the page scales down to fit — the ask is one
      // printable page, mirroring the bulletin fit rule.
      inner.style.transform = `scale(${hPx / contentH})`;
      inner.style.transformOrigin = 'top center';
    }
    const opts_ = { width: wPx, height: hPx, pixelRatio: 2, backgroundColor: '#ffffff' };
    // WebKit (all iOS browsers + macOS Safari) renders the intermediate SVG
    // foreignObject lazily: the FIRST pass regularly comes back with images
    // and fonts missing. The standard workaround is to render repeatedly
    // and keep the last pass.
    const isWebKit = /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//i.test(navigator.userAgent);
    let dataUrl = '';
    const passes = isWebKit ? 3 : 1;
    for (let p = 0; p < passes; p++) {
      dataUrl = await toPng(frame, opts_);
    }

    let file: File;
    let downloadUrl = dataUrl;
    let downloadName = opts.filename.replace(/\.pdf$/i, '') + '.png';
    if (opts.imageAsPdf) {
      // Callers whose deliverable must be an actual .pdf (the Letter Maker)
      // get the same capture wrapped into a one-page PDF: the page keeps its
      // physical size in points, so it prints at exactly the intended scale.
      try {
        const { PDFDocument } = await import('pdf-lib');
        const pdf = await PDFDocument.create();
        const png = await pdf.embedPng(dataUrl);
        const pageWPt = widthPt;
        const pageHPtReal = opts.sizeToContent ? hPx / PT_TO_PX : pageHPt;
        const page = pdf.addPage([pageWPt, pageHPtReal]);
        page.drawImage(png, { x: 0, y: 0, width: pageWPt, height: pageHPtReal });
        const bytes = new Uint8Array(await pdf.save()) as Uint8Array<ArrayBuffer>;
        downloadName = opts.filename.replace(/\.pdf$/i, '') + '.pdf';
        file = new File([bytes], downloadName, { type: 'application/pdf' });
        downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      } catch (e) {
        // pdf-lib unavailable (stale-session chunk 404) — deliver the PNG
        // capture rather than aborting into the print fallback.
        console.warn('[deliverPdf] PDF wrap failed, delivering PNG:', e);
        const blob = await (await fetch(dataUrl)).blob();
        file = new File([blob], downloadName, { type: 'image/png' });
      }
    } else {
      const blob = await (await fetch(dataUrl)).blob();
      file = new File([blob], downloadName, { type: 'image/png' });
    }

    // Share sheet when the browser supports sharing files (iOS/Android);
    // plain download otherwise. iOS standalone PWAs can leave nav.share()
    // pending FOREVER when the user cancels the sheet — never block the
    // caller on it (a stranded await keeps busy flags stuck and traps
    // full-screen modals). Wait only long enough to catch quick rejections
    // (NotAllowed → download fallback); once the sheet is up, hand off.
    const nav: any = navigator;
    if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
      // The whole block is guarded: iOS can THROW from share() synchronously
      // (not just reject) — that must fall through to the download below, not
      // escape shareHtmlAsImage and land the user in the print fallback.
      try {
        const outcome = await Promise.race<string>([
          nav.share({ files: [file], title: opts.dialogTitle }).then(
            () => 'shared',
            (e: any) => (e?.name === 'AbortError' ? 'shared' : 'failed'),
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('handed-off'), 1500)),
        ]);
        if (outcome !== 'failed') return;
      } catch { /* sync throw → download fallback */ }
      // NotAllowed/other quick failure → fall through to download
    }
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = downloadName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    host.remove();
    style.remove();
  }
}

async function printHtmlInPlace(html: string, fitOnePage: boolean): Promise<void> {
  const { host, inner, srcCss, style } = mountHtml(html, fitOnePage ? PAGE_W_PT : null);
  style.textContent = `
${srcCss}
/* Off-screen (but laid out, so we can measure + images load) on screen. */
@media screen {
  #${HOST_ID} { position: fixed; left: -10000px; top: 0; ${fitOnePage ? `width: ${PAGE_W_PT}pt;` : ''} }
}
/* When printing: show ONLY the generated document. */
@media print {
  body > *:not(#${HOST_ID}) { display: none !important; }
  #${HOST_ID} { position: static !important; }
}
${fitOnePage ? `@page { size: ${PAGE_W_PT}pt ${PAGE_H_PT}pt; margin: 0 !important; }` : ''}
`;

  document.head.appendChild(style);
  document.body.appendChild(host);

  try {
    await waitForImages(inner, 900);

    if (fitOnePage) {
      // Scale the design down so it fills exactly one A4 page (like the
      // native custom-page-size PDF), then hard-clip so nothing can spill
      // onto a second page. Height fractionally under the page to dodge
      // pagination rounding; the document's own dark body bg hides the seam.
      const contentH = inner.scrollHeight; // px
      const scale = Math.min(1, (PAGE_H_PT * PT_TO_PX) / Math.max(1, contentH));
      inner.style.transform = `scale(${scale})`;
      inner.style.transformOrigin = 'top center';
      host.style.height = `${PAGE_H_PT - 1}pt`;
      host.style.overflow = 'hidden';
    }

    const cleanup = () => {
      host.remove();
      style.remove();
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // Safety net if afterprint never fires (some in-app browsers).
    setTimeout(cleanup, 90_000);

    window.focus();
    window.print();
  } catch (e) {
    host.remove();
    style.remove();
    throw e;
  }
}

/**
 * Export a PDF from HTML, cross-platform — the safe way.
 *
 *   • Native: Print.printToFileAsync() → a real PDF file → share sheet.
 *   • Web: in-place print of the generated HTML (see file header). Works with
 *     or without a user gesture — no popups involved. `printWin` is legacy;
 *     if a window is passed it is closed.
 */
export async function exportPdfFromHtml(
  html: string,
  opts: { filename?: string; dialogTitle?: string; width?: number; height?: number; sizeToContent?: boolean; imageAsPdf?: boolean } = {},
  printWin?: Window | null,
): Promise<void> {
  const { filename = 'vertex-document.pdf', dialogTitle = APP_NAME, width, height, sizeToContent, imageAsPdf } = opts;
  if (Platform.OS === 'web') {
    if (printWin && !printWin.closed) { try { printWin.close(); } catch { /* ignore */ } }
    // Installed PWA / mobile: window.print() prints the app shell there, so
    // render the document to a PNG and hand it to the share sheet
    // (AirPrint / save / send). Desktop keeps the real print dialog.
    if (shouldExportImage()) {
      try {
        await shareHtmlAsImage(html, { filename, dialogTitle, width, height, sizeToContent, imageAsPdf });
        return;
      } catch (e) {
        console.warn('[deliverPdf] image export failed, falling back to print:', e);
      }
    }
    // Portrait fixed-size docs (the bulletins) are one-page designs → fit
    // them to a single A4 page. Landscape/free-height docs keep their
    // own @page rules and paginate naturally.
    const fitOnePage = !!(width && height && height > width);
    await printHtmlInPlace(html, fitOnePage);
    return;
  }
  const { uri } = await Print.printToFileAsync({ html, ...(width ? { width } : {}), ...(height ? { height } : {}) });
  await deliverPdf(uri, dialogTitle, filename);
}

export async function deliverPdf(uri: string, dialogTitle: string, filename = 'vertex-document.pdf'): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      const a = document.createElement('a');
      a.href = uri;
      a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      try { (window as any).open(uri, '_blank'); } catch { /* ignore */ }
    }
    return;
  }
  if (await Sharing.isAvailableAsync()) {
    // iOS quirk: shareAsync's Promise can stay pending forever when the user
    // cancels the share sheet (see printPlanner.ts) — awaiting it strands the
    // caller's busy state behind a promise that never settles. Hand off and
    // return; cancelling the sheet is not a failure.
    Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle }).catch(() => {});
  }
}
