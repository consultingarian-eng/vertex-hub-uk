/**
 * Fetch a remote image and return it as a base64 data URI (cached per URL).
 *
 * Why: the PDF renderer (iOS WKWebView via expo-print) doesn't reliably fetch
 * remote <img src> URLs, so remote logos print as a broken "blue square". Inline
 * them as data URIs in the print HTML instead. Falls back to the original URL on
 * failure (fine for on-screen rendering and web print). No extra deps — fetch +
 * FileReader are global in React Native.
 */
const _cache: Record<string, string> = {};

export async function remoteImageDataUri(url: string): Promise<string> {
  if (!url) return url;
  if (_cache[url]) return _cache[url];
  try {
    const resp = await fetch(url);
    const blob = await resp.blob();
    const uri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
    _cache[url] = uri;
    return uri;
  } catch {
    return url;
  }
}
