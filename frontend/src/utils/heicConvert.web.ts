// Web-only HEIC → JPEG converter.
// IMPORTANT: `heic2any` touches `window` at import time, which breaks Expo
// web's server-side prerender ("window is not defined"). To avoid this we
// dynamically import the module *inside* the function, so it only runs in
// the browser at call time — never during SSR.

export async function convertHeicIfNeeded(file: File | Blob): Promise<Blob> {
  const anyFile = file as any;
  const name: string = anyFile?.name || '';
  const mime: string = anyFile?.type || '';
  const isHeic =
    /\.(heic|heif)$/i.test(name) || mime === 'image/heic' || mime === 'image/heif';
  if (!isHeic) return file;

  // Guard: only available in the browser
  if (typeof window === 'undefined') return file;

  // Lazy-load so Metro/webpack don't evaluate it during SSR prerender
  // @ts-ignore — no types
  const mod = await import('heic2any');
  const heic2any = (mod as any).default || mod;

  const converted = await heic2any({
    blob: file,
    toType: 'image/jpeg',
    quality: 0.85,
  });
  return (Array.isArray(converted) ? converted[0] : converted) as Blob;
}
