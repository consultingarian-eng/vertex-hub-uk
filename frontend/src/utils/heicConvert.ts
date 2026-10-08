// Native stub — HEIC conversion is only needed on web.
// iOS/Android image pickers auto-convert HEIC to JPEG at the OS level.
export async function convertHeicIfNeeded(file: any): Promise<any> {
  return file;
}
