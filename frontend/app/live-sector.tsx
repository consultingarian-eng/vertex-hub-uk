/** Live Operations — one sector: door activity and a row per BA. */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { LiveSector } from '../src/components/live/LiveOps';

export default function LiveSectorScreen() {
  const p = useLocalSearchParams<{ id: string; date?: string }>();
  return <LiveSector key={String(p.id)} id={String(p.id || '')} initialDate={p.date ? String(p.date) : undefined} />;
}
