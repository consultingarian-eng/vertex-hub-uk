import { create } from 'zustand';

export type PreviewUser = { id: string; name: string; role: string; email?: string };

type PreviewState = {
  user: PreviewUser | null;
  setPreview: (u: PreviewUser) => void;
  clear: () => void;
};

/**
 * "View As" — a super admin previewing the app as a specific trainee or
 * leader. Mirrors alertStore.ts/rankUpStore.ts: React components use the
 * hook, and the axios request interceptor (outside the React tree) reads
 * usePreviewStore.getState().user to attach the X-View-As-User-Id header.
 */
export const usePreviewStore = create<PreviewState>((set) => ({
  user: null,
  setPreview: (u) => set({ user: u }),
  clear: () => set({ user: null }),
}));
