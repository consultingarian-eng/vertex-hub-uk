/** Live Operations — one BA: their figures and their laps, door by door. */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { LiveBa } from '../src/components/live/LiveOps';

export default function LiveBaScreen() {
  const p = useLocalSearchParams<{ id: string; date?: string; sector?: string }>();
  return <LiveBa key={String(p.id)} id={String(p.id || '')} initialDate={p.date ? String(p.date) : undefined} sectorId={p.sector ? String(p.sector) : undefined} />;
}
