import React, { createContext, useContext, useMemo } from 'react';
import { useAuth } from '../../auth/AuthContext';

// ── Bells edit lock — RETIRED (kept as a no-op shim) ─────────────────────
// The passcode gate existed for one reason: stopping non-admins from
// flipping days to/from AB without the office knowing. That control now
// lives server-side — POST /bells silently reverts any AB change from a
// non-admin, and absences go through the owner-approved request flow
// (routes/absences.py) instead. With the real risk closed off, the
// passcode only added friction to people reporting their own sales, so
// editing is now always unlocked. The context shape is preserved so the
// call sites (EntryRow, QuickLogSheet, DayBreakdownModal…) didn't need
// to change.
type BellsEditLockCtx = {
  isAdmin: boolean;
  unlocked: boolean;           // always true — editing is open
  ready: boolean;
  requireEditAccess: () => Promise<boolean>; // always resolves true
  lock: () => Promise<void>;   // no-op
};

const Ctx = createContext<BellsEditLockCtx | null>(null);

export function useBellsEditLock(): BellsEditLockCtx {
  const c = useContext(Ctx);
  if (!c) {
    return {
      isAdmin: true,
      unlocked: true,
      ready: true,
      requireEditAccess: async () => true,
      lock: async () => {},
    };
  }
  return c;
}

export function BellsEditLockProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const value = useMemo<BellsEditLockCtx>(() => ({
    isAdmin,
    unlocked: true,
    ready: true,
    requireEditAccess: async () => true,
    lock: async () => {},
  }), [isAdmin]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
