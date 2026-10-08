/** Shared helpers for the OwnerIQ Live Operations screens. */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { APP_LOCALE, APP_TZ } from './appTime';

/** An OwnerIQ marketing company (one per office), as the backend knows it. */
export type OwnerIqCompany = { pin: string; name: string };

/** The deployment's OwnerIQ companies — drives the office switchers and the
 *  pin → office label. Configured/discovered server-side (owneriq_config). */
export function useOwnerIqCompanies(): OwnerIqCompany[] {
  const q = useQuery({
    queryKey: ['owneriq-companies'],
    queryFn: () => api.get('/owneriq/companies').then((r) => (r.data?.companies || []) as OwnerIqCompany[]),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });
  return q.data || [];
}

/** First-knock ISO (UTC) → "2:32 pm" in app time (UK time). */
export function knockTime(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString(APP_LOCALE, {
      hour: 'numeric', minute: '2-digit', hour12: true, timeZone: APP_TZ,
    });
  } catch {
    return '—';
  }
}

/** OwnerIQ marketing-company pin → office label (null when unknown). */
export function officeFromPin(pin: string | null | undefined, companies: OwnerIqCompany[]): string | null {
  if (!pin) return null;
  return companies.find((c) => String(c.pin) === String(pin))?.name || null;
}

/** Up to two initials from a full name, for avatar fallbacks. */
export function initials(name?: string | null): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** YYYY-MM-DD for a Date. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
