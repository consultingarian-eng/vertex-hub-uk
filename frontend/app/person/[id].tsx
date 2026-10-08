/** One person's breakdown: performance, law of averages, COD and their badge. */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { PersonBreakdown } from '../../src/components/person/PersonBreakdown';

export default function PersonScreen() {
  const p = useLocalSearchParams<{ id: string }>();
  return <PersonBreakdown key={String(p.id)} id={String(p.id || '')} />;
}
