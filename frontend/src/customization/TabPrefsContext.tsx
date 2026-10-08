/**
 * React context that loads + caches the user's tab preferences from
 * /api/me/tab-prefs and exposes a save() helper that writes them back.
 *
 * Components that re-render on prefs change should consume `useTabPrefs()`.
 * The hook returns the resolved list (against the registry + role) so the
 * caller doesn't have to do that work.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiService } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { resolveTabPrefs, defaultPrefsForRole, Role, TabItem } from './tabRegistry';

type ResolvedItem = { item: TabItem; visible: boolean };

type Ctx = {
  loaded: boolean;
  resolved: ResolvedItem[];
  save: (items: { id: string; visible: boolean }[]) => Promise<void>;
  reset: () => Promise<void>;
};

const TabPrefsContext = createContext<Ctx | null>(null);

export function TabPrefsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const role = (user?.role as Role | undefined) || undefined;
  const [loaded, setLoaded] = useState(false);
  const [raw, setRaw] = useState<{ id: string; visible: boolean }[] | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) { setLoaded(true); return; }
    try {
      const { data } = await apiService.getTabPrefs();
      setRaw(data?.items || []);
    } catch {
      setRaw([]);
    } finally {
      setLoaded(true);
    }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const resolved = useMemo(() => resolveTabPrefs(raw, role), [raw, role]);

  const save = useCallback(async (items: { id: string; visible: boolean }[]) => {
    setRaw(items);
    try {
      await apiService.saveTabPrefs(items);
    } catch (e) {
      // Reload on failure
      load();
      throw e;
    }
  }, [load]);

  const reset = useCallback(async () => {
    const def = defaultPrefsForRole(role);
    await save(def);
  }, [role, save]);

  const value = useMemo(() => ({ loaded, resolved, save, reset }), [loaded, resolved, save, reset]);
  return <TabPrefsContext.Provider value={value}>{children}</TabPrefsContext.Provider>;
}

export function useTabPrefs() {
  const ctx = useContext(TabPrefsContext);
  if (!ctx) throw new Error('useTabPrefs must be used inside <TabPrefsProvider>');
  return ctx;
}
