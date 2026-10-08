/**
 * Live Operations — every sector out in the field for a day, as OwnerIQ shows
 * it. Tap a sector for its BAs (/live-sector), then a BA for their doors
 * (/live-ba). The screens live in src/components/live/LiveOps.tsx.
 */
import React from 'react';
import { LiveOverview } from '../src/components/live/LiveOps';

export default function LiveOpsScreen() {
  return <LiveOverview />;
}
