/**
 * ActiveOfficeContext — the office a super admin is currently viewing.
 *
 * Super admins oversee multiple offices (their `accessible_offices`). This
 * context holds which one the Bells / Team / Spider screens are scoped to,
 * defaulting to their HOME office (`user.office_id`, e.g. office A) and
 * persisted across launches. Regular admins/leaders have exactly one office
 * and cannot switch.
 *
 * Usage:
 *   const { officeId, setOfficeId, offices, canSwitch, homeOfficeId } = useActiveOffice();
 *   apiService.listBells(week, officeId);   // scope a query
 *   {canSwitch && <OfficeToggle />}         // show the switcher
 *
 * `officeId` can be undefined only briefly before the user/offices load; pass
 * it straight to the API (undefined → backend applies its own default).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { apiService } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export type OfficeLite = { id: string; name: string };

type Ctx = {
  officeId: string | undefined;
  setOfficeId: (id: string) => void;
  offices: OfficeLite[];
  canSwitch: boolean;
  homeOfficeId: string | undefined;
};

const ActiveOfficeContext = createContext<Ctx>({
  officeId: undefined,
  setOfficeId: () => {},
  offices: [],
  canSwitch: false,
  homeOfficeId: undefined,
});

const STORAGE_KEY = 'cg1.activeOffice';

export function ActiveOfficeProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isSuper = !!user?.is_super_admin;
  const homeOfficeId = user?.office_id || undefined;
  const accessible = user?.accessible_offices || [];

  const [selected, setSelected] = useState<string | undefined>(undefined);

  // Resolve accessible office ids → {id, name}. Only super admins need the
  // list (for the toggle); everyone else scopes to their single office.
  const officesQ = useQuery({
    queryKey: ['offices'],
    queryFn: () => apiService.getOffices().then((r) => r.data as any[]),
    enabled: isSuper && accessible.length > 1,
    staleTime: 60 * 60 * 1000,
  });

  const offices: OfficeLite[] = useMemo(() => {
    if (!isSuper) return [];
    const all = (officesQ.data || []) as any[];
    const byId: Record<string, string> = {};
    all.forEach((o) => { byId[o.id] = o.name || o.id; });
    // Preserve accessible_offices order; fall back to the id if name unknown.
    return accessible.map((id) => ({ id, name: byId[id] || 'Office' }));
  }, [isSuper, officesQ.data, accessible]);

  // Load persisted selection once the user is known.
  useEffect(() => {
    let alive = true;
    if (!isSuper) { setSelected(homeOfficeId); return; }
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (!alive) return;
      // Only honour a persisted office the super admin can still access.
      if (v && accessible.includes(v)) setSelected(v);
      else setSelected(homeOfficeId);
    }).catch(() => setSelected(homeOfficeId));
    return () => { alive = false; };
  }, [isSuper, homeOfficeId, accessible.join(',')]);

  const setOfficeId = useCallback((id: string) => {
    setSelected(id);
    AsyncStorage.setItem(STORAGE_KEY, id).catch(() => {});
  }, []);

  const value = useMemo<Ctx>(() => ({
    // Non-super users are always pinned to their home office.
    officeId: isSuper ? selected : homeOfficeId,
    setOfficeId,
    offices,
    canSwitch: isSuper && offices.length > 1,
    homeOfficeId,
  }), [isSuper, selected, homeOfficeId, offices, setOfficeId]);

  return <ActiveOfficeContext.Provider value={value}>{children}</ActiveOfficeContext.Provider>;
}

export const useActiveOffice = () => useContext(ActiveOfficeContext);
