import React, { createContext, useContext, useState, useEffect } from 'react';
import { Platform } from 'react-native';
import { apiService } from '../api/client';
import { queryClient } from '../api/queryClient';
import { registerForPushNotificationsAsync, clearPushToken } from '../notifications/pushNotifications';
import { rescheduleMonthlyPlannerReminder, clearMonthlyPlannerReminders } from '../utils/monthlyPlannerReminders';
import { clearAllScheduledForUser } from '../utils/scheduleNotifications';
import { enableBiometric, disableBiometric, isBiometricEnabled, tryBiometricLogin, getBiometricEmail } from './biometric';
import { usePreviewStore, PreviewUser } from '../utils/previewStore';
import { subscribeToAuthExpired } from './authSessionEvents';
import {
  clearAuthTokens,
  getAccessToken,
  initializeTokenStorage,
  setAccessToken,
  setAuthTokens,
} from './tokenStorage';
import { holdStarterPassword } from './starterPassword';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  profile_image?: string;
  phone?: string;
  office_id?: string;
  is_super_admin?: boolean;
  /** A Coach the Owner has picked to see the whole office (Live Operations,
   *  Performance Hub, Field KPIs) and to make ID badges. The server enforces
   *  it; this only decides what the screens offer. See src/utils/roleTitle.ts. */
  coach_plus?: boolean;
  /** Display-only rank label (e.g. "Owner"). Overrides the role word on screen
   *  and grants nothing — see src/utils/roleTitle.ts. */
  title?: string;
  /** Leader flagged as a recruiter: sees the recruitment funnel cards on Home
   *  and skips the passcode prompt on the recruiting screens. Grants no extra
   *  server-side authority — every /recruits route already allows leaders. */
  accessible_offices?: string[];
  team_name?: string;
  /** Signed in on the shared starter password: the app shows only the
   *  "choose your own password" screen until they have. */
  must_change_password?: boolean;
}

interface AuthContextType {
  user: User | null;
  /** The real logged-in account — unaffected by "View As". Use this to gate
   * anything super-admin-only (e.g. the preview picker itself). */
  realUser: User | null;
  isPreviewing: boolean;
  startPreview: (u: PreviewUser) => void;
  exitPreview: () => void;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithBiometric: () => Promise<boolean>;
  enableBiometricForCurrentUser: () => Promise<boolean>;
  disableBiometricForCurrentUser: () => Promise<void>;
  isBiometricEnabledForUser: () => Promise<boolean>;
  register: (email: string, password: string, name: string, officeId?: string, leaderId?: string | null) => Promise<{ requires_verification: boolean; email: string }>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  resendOtp: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User | null) => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  realUser: null,
  isPreviewing: false,
  startPreview: () => {},
  exitPreview: () => {},
  loading: true,
  login: async () => {},
  loginWithBiometric: async () => false,
  enableBiometricForCurrentUser: async () => false,
  disableBiometricForCurrentUser: async () => {},
  isBiometricEnabledForUser: async () => false,
  register: async () => ({ requires_verification: false, email: '' }),
  verifyEmail: async () => {},
  resendOtp: async () => {},
  logout: async () => {},
  setUser: () => {},
});

function userWithoutCredentials(data: any): User {
  const safeUser = { ...(data || {}) };
  // Login responses necessarily contain credentials, but React state should
  // never retain the refresh token (and does not need the access token).
  delete safeUser.token;
  delete safeUser.refresh_token;
  return safeUser as User;
}

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [realUser, setRealUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // "View As" — a super admin previewing as a specific trainee/leader.
  // `user` (exposed below) becomes THEIR identity for every existing screen's
  // role logic; `realUser` always stays the actual logged-in account.
  const previewUser = usePreviewStore((s) => s.user);
  const setPreview = usePreviewStore((s) => s.setPreview);
  const clearPreview = usePreviewStore((s) => s.clear);
  const isPreviewing = !!previewUser;
  const user: User | null = previewUser
    ? { id: previewUser.id, email: previewUser.email || '', name: previewUser.name, role: previewUser.role }
    : realUser;

  const startPreview = (u: PreviewUser) => {
    setPreview(u);
    queryClient.clear();
  };
  const exitPreview = () => {
    clearPreview();
    queryClient.clear();
  };

  // Refresh-token rejection happens below React in the Axios interceptor.
  // Mirror that durable-token cleanup into UI state immediately so the root
  // navigator returns to Login instead of leaving a "zombie" signed-in UI.
  useEffect(() => subscribeToAuthExpired(() => {
    clearPreview();
    queryClient.clear();
    disableBiometric().catch(() => {});
    clearMonthlyPlannerReminders().catch(() => {});
    clearAllScheduledForUser().catch(() => {});
    setRealUser(null);
    setLoading(false);
  }), [clearPreview]);

  useEffect(() => {
    checkAuth();
  }, []);

  // Register for push notifications whenever we have an authenticated
  // account. Keyed on the REAL user — device push registration and the
  // monthly-planner reminder are account-level device concerns, not part of
  // the previewed identity (and both would be blocked as writes in preview
  // mode anyway).
  useEffect(() => {
    if (realUser?.id) {
      registerForPushNotificationsAsync().catch(() => {});
      // Re-evaluate the local "fill out next month's planner" reminder
      // (last 3 days of month). The util is no-op on web / when permission
      // is denied / when next-month exists.
      (async () => {
        try {
          const r = await apiService.listMonthlyPlanners();
          const months = (r.data?.items || []).map((it: any) => it.month).filter(Boolean) as string[];
          await rescheduleMonthlyPlannerReminder(months);
        } catch {}
      })();
    }
  }, [realUser?.id]);

  const checkAuth = async () => {
    try {
      await initializeTokenStorage();
      const token = await getAccessToken();
      const biometricGate = Platform.OS !== 'web' && await isBiometricEnabled();
      // Browser sessions are restored from HttpOnly cookies, which JavaScript
      // intentionally cannot inspect. On native, an enabled Face ID/Touch ID
      // setting is an actual cold-start gate: leave identity unset so Login
      // can prompt before revealing the signed-in account's app data.
      if (token && biometricGate) return;
      if (Platform.OS === 'web' || token) {
        const res = await apiService.getMe();
        setRealUser(userWithoutCredentials(res.data));
      }
    } catch (error: any) {
      const status = error?.response?.status;
      if ((status === 401 || status === 403) && !error?.cg1RefreshRecoverable) {
        await clearAuthTokens();
      }
    } finally {
      setLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    const res = await apiService.login(email, password);
    const userData = res.data;
    if (!userData?.token) throw new Error('Login response did not include a session token.');
    await setAuthTokens(userData.token, userData.refresh_token);
    // Fetch full user data from /auth/me to get all fields like is_super_admin.
    //
    // On web this doubles as the only proof the session actually took: the
    // browser session lives solely in the HttpOnly cookies the login response
    // set, and JavaScript cannot read them back. A browser that refused those
    // cookies (private-mode restrictions, blocked site data, an extension)
    // still returns a perfectly good login response, so swallowing a 401 here
    // left the app "signed in" with no credential — every later query 401'd and
    // bounced the user back to Login with no explanation. Fail loudly instead.
    try {
      const meRes = await apiService.getMe();
      Object.assign(userData, meRes.data);
    } catch (e: any) {
      const status = e?.response?.status;
      if (Platform.OS === 'web' && (status === 401 || status === 403)) {
        await clearAuthTokens().catch(() => {});
        throw new Error(
          "Signed in, but this browser didn't keep the session cookie. Allow cookies for this site (or try a different browser) and sign in again.",
        );
      }
      // Anything else (offline, 5xx) is recoverable — keep the login response's
      // fields and let the app refetch the richer profile later.
    }
    if (Platform.OS !== 'web' && await isBiometricEnabled()) {
      // Heal/update the separately gated copy after a password fallback.
      await enableBiometric(userData.token, userData.email || email).catch(() => {});
    }
    // Starter password: keep what they just typed (in memory only) so the
    // "choose your own password" screen doesn't ask for it again.
    if (userData.must_change_password) holdStarterPassword(password);
    queryClient.clear();
    setRealUser(userWithoutCredentials(userData));
  };

  const register = async (email: string, password: string, name: string, officeId?: string, leaderId?: string | null) => {
    const res = await apiService.register(email, password, name, officeId, leaderId);
    const data = res.data;
    // New OTP flow: do NOT auto-login — caller routes to verify-email screen
    return { requires_verification: Boolean(data?.requires_verification), email: data?.email || email };
  };

  const verifyEmail = async (email: string, code: string) => {
    const res = await apiService.verifyEmail(email, code);
    const userData = res.data;
    if (!userData?.token) throw new Error('Verification response did not include a session token.');
    await setAuthTokens(userData.token, userData.refresh_token);
    queryClient.clear();
    setRealUser(userWithoutCredentials(userData));
  };

  const resendOtp = async (email: string) => {
    await apiService.resendOtp(email);
  };

  const logout = async () => {
    clearPreview();
    try {
      await clearPushToken();
    } catch {}
    try {
      const token = await getAccessToken();
      if (token) await apiService.logout(token);
      else if (Platform.OS === 'web') await apiService.logout();
    } catch {}
    await clearAuthTokens();
    // Logout revokes the server-side session version, so any biometric copy
    // of that JWT is revoked too. Clear it now instead of advertising a Face
    // ID sign-in that can only fail on the next login screen.
    await disableBiometric();
    await Promise.allSettled([
      clearMonthlyPlannerReminders(),
      clearAllScheduledForUser(),
    ]);
    // Clear all cached queries so next user gets fresh data
    queryClient.clear();
    setRealUser(null);
  };

  // ── Biometric helpers ──────────────────────────────────────────────────
  const loginWithBiometric = async (): Promise<boolean> => {
    const token = await tryBiometricLogin();
    if (!token) return false;
    // Do not call setAuthTokens(token, null): that intentionally deletes the
    // refresh credential and would turn a healthy session into a 24-hour-only
    // one. Biometric sign-in is restoring this access credential only.
    await setAccessToken(token);
    try {
      const meRes = await apiService.getMe();
      const userData = userWithoutCredentials(meRes.data);
      const currentToken = await getAccessToken();
      if (currentToken && userData.email) {
        // getMe may have transparently refreshed an expired access JWT; keep
        // the biometric-gated copy in sync for the next cold start.
        await enableBiometric(currentToken, userData.email).catch(() => {});
      }
      queryClient.clear();
      setRealUser(userData);
      return true;
    } catch (error: any) {
      const status = error?.response?.status;
      if ((status === 401 || status === 403) && !error?.cg1RefreshRecoverable) {
        // Definitively invalid/revoked — wipe the copy so we don't loop.
        await disableBiometric();
        await clearAuthTokens();
      }
      // Network and server outages are recoverable. Keep biometric enrollment
      // and the credential so the user can retry when connectivity returns.
      return false;
    }
  };

  const enableBiometricForCurrentUser = async (): Promise<boolean> => {
    const token = await getAccessToken();
    if (!token || !realUser?.email) return false;
    try {
      await enableBiometric(token, realUser.email);
      return true;
    } catch {
      return false;
    }
  };

  const disableBiometricForCurrentUser = async () => {
    await disableBiometric();
  };

  const isBiometricEnabledForUser = async () => {
    const enabled = await isBiometricEnabled();
    if (!enabled) return false;
    const storedEmail = await getBiometricEmail();
    return !realUser?.email || storedEmail === realUser.email;
  };

  return (
    <AuthContext.Provider value={{ user, realUser, isPreviewing, startPreview, exitPreview, loading, login, loginWithBiometric, enableBiometricForCurrentUser, disableBiometricForCurrentUser, isBiometricEnabledForUser, register, verifyEmail, resendOtp, logout, setUser: setRealUser }}>
      {children}
    </AuthContext.Provider>
  );
}
