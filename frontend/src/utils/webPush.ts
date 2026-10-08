/**
 * Web Push (installed PWA) — client subscription flow.
 *
 * Registers the service worker, asks permission (must be from a user tap,
 * especially on iOS), subscribes via the Push API with our VAPID key, and
 * hands the subscription to the backend. Web-only; all functions no-op on
 * native (Expo Go uses expo-notifications instead).
 *
 * iOS note: web push only works when the app is installed to the Home Screen
 * (standalone), not in a Safari tab — see canUseWebPush().
 */
import { Platform } from 'react-native';
import { api } from '../api/client';

export type WebPushStatus =
  | 'unsupported'   // browser/device can't do it (or iOS not installed to Home Screen)
  | 'default'       // supported, not yet asked
  | 'denied'        // user blocked notifications
  | 'subscribed'    // on
  | 'granted';      // permission granted but no active subscription

function isWeb(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined';
}

export function isStandalone(): boolean {
  if (!isWeb()) return false;
  // Android/desktop: display-mode standalone. iOS: navigator.standalone.
  const mm = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (window.navigator as any).standalone === true;
  return !!(mm || iosStandalone);
}

function isIOS(): boolean {
  if (!isWeb()) return false;
  return /iP(hone|ad|od)/.test(window.navigator.userAgent);
}

/** Whether this browser/device can receive web push right now. */
export function canUseWebPush(): boolean {
  if (!isWeb()) return false;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  // iOS only supports web push from an installed (standalone) PWA.
  if (isIOS() && !isStandalone()) return false;
  return true;
}

/** True on iOS Safari tab where they must "Add to Home Screen" first. */
export function needsInstallFirst(): boolean {
  return isWeb() && isIOS() && !isStandalone() &&
    'serviceWorker' in navigator && 'PushManager' in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (existing) return existing;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
  if (!canUseWebPush()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) return 'subscribed';
  } catch { /* ignore */ }
  return Notification.permission === 'granted' ? 'granted' : 'default';
}

/** Turn on web push. Call from a user tap. Returns a status + optional reason. */
export async function enableWebPush(): Promise<{ ok: boolean; reason?: string }> {
  if (!canUseWebPush()) {
    return { ok: false, reason: needsInstallFirst() ? 'install-first' : 'unsupported' };
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: 'denied' };

    const { data } = await api.get('/push/vapid-key');
    const publicKey = data?.publicKey;
    if (!publicKey) return { ok: false, reason: 'not-configured' };

    const reg = await getRegistration();
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    }

    const json: any = sub.toJSON();
    await api.post('/push/web-subscribe', {
      endpoint: json.endpoint,
      keys: json.keys,
      expirationTime: json.expirationTime ?? null,
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'error' };
  }
}

/** Turn off web push on this device. */
export async function disableWebPush(): Promise<void> {
  if (!isWeb() || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) {
      const json: any = sub.toJSON();
      try { await api.post('/push/web-unsubscribe', { endpoint: json.endpoint }); } catch { /* ignore */ }
      await sub.unsubscribe();
    }
  } catch { /* ignore */ }
}
