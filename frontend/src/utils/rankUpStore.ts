import { create } from 'zustand';

export type RankUpContent = {
  emoji?: string;
  title: string;
  subtitle?: string;
  /** 'levelup' = the full Sales Path takeover (aurora + confetti + 3D medal). */
  variant?: 'default' | 'levelup';
};

type RankUpState = {
  content: RankUpContent | null;
  fire: (opts: RankUpContent) => void;
  clear: () => void;
};

/**
 * Global trigger for the RankUp "big moment" overlay — mirrors alertStore.ts
 * so any screen (or a background badge-watcher) can fire a celebration
 * without needing a ref to a specific mounted component.
 */
export const useRankUpStore = create<RankUpState>((set) => ({
  content: null,
  fire: (opts) => set({ content: { emoji: opts.emoji ?? '🏆', title: opts.title, subtitle: opts.subtitle, variant: opts.variant ?? 'default' } }),
  clear: () => set({ content: null }),
}));
