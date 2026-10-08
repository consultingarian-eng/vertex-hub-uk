/**
 * Small bridge between the API layer and React auth state.
 *
 * The Axios client cannot import AuthContext without creating a dependency
 * cycle, so it publishes a session-expired event after the refresh endpoint
 * definitively rejects the refresh token. AuthProvider owns the UI cleanup.
 */
type AuthExpiredListener = () => void;

const authExpiredListeners = new Set<AuthExpiredListener>();

export function subscribeToAuthExpired(listener: AuthExpiredListener): () => void {
  authExpiredListeners.add(listener);
  return () => authExpiredListeners.delete(listener);
}

export function publishAuthExpired(): void {
  // Snapshot the set so a listener can safely unsubscribe while handling it.
  for (const listener of Array.from(authExpiredListeners)) {
    try {
      listener();
    } catch {
      // One subscriber must not prevent the remaining cleanup subscribers.
    }
  }
}
