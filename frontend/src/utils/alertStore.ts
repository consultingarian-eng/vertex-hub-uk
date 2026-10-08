import { create } from 'zustand';

export type AlertButton = {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
};

type AlertState = {
  visible: boolean;
  title: string;
  message?: string;
  buttons: AlertButton[];
  show: (opts: { title: string; message?: string; buttons: AlertButton[] }) => void;
  hide: () => void;
};

export const useAlertStore = create<AlertState>((set) => ({
  visible: false,
  title: '',
  message: undefined,
  buttons: [],
  show: (opts) => set({ visible: true, ...opts }),
  hide: () => set({ visible: false, title: '', message: undefined, buttons: [] }),
}));
