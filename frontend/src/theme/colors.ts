// Legacy static palette — kept for the few modules that import it directly
// (app/_layout.tsx fallback, app/login.tsx). Mirrors the light brand palette
// in ThemeContext (Vertex brand system).
export const colors = {
  // Primary — the brand green
  primary: '#244c3b',
  primaryLight: '#336e4d',
  primaryDark: '#102d25',
  onPrimary: '#FFFFFF',
  onAccent: '#FFFFFF',

  // Page field + card faces (mirrors lightColors in ThemeContext)
  page: '#f0f4e9',
  background: '#f9faf4',
  surface: '#F4F7EE',
  surfaceAlt: '#E4EBDB',

  // Text — forest ink
  text: '#17362b',
  textSecondary: '#2F4A3D',
  textMuted: '#50675a',
  textLight: '#FFFFFF',

  ink: '#102d25',
  inkText: '#f0f4e9',
  inkMuted: '#b5c8b2',
  glass: 'rgba(240,244,233,0.80)',
  glassBorder: 'rgba(255,255,255,0.85)',
  glow: 'rgba(140,175,56,0.45)',
  trackBg: '#DCE5D2',
  depthShadow: '0 14px 30px -10px rgba(16,45,37,0.28), 0 2px 6px rgba(16,45,37,0.10), inset 0 1px 0 rgba(255,255,255,0.7)',
  // The Vertex X / loader dots: forest on light surfaces; markOnInk on dark blocks.
  markColor: '#244c3b',
  markOnInk: '#b7df58',
  titleGradient: ['#244c3b', '#244c3b', '#244c3b'] as readonly string[],

  // Status colors
  sgreen: '#059669',
  sgreenBg: '#D1FAE5',
  green: '#10B981',
  greenBg: '#DCFCE7',
  yellow: '#D97706',
  yellowBg: '#FEF3C7',
  red: '#DC2626',
  redBg: '#FEE2E2',

  // Neutrals — sage-tinted borders
  border: '#cedbc7',
  borderDark: '#A9BE9F',
  shadow: 'rgba(16, 45, 37, 0.22)',

  // Accent
  accent: '#56731B',
  info: '#2563A8',
};

export const statusColors = {
  'S-GREEN': { bg: colors.sgreenBg, text: colors.sgreen },
  'Green': { bg: colors.greenBg, text: colors.green },
  'Yellow': { bg: colors.yellowBg, text: colors.yellow },
  'Red': { bg: colors.redBg, text: colors.red },
  'Pending': { bg: colors.surfaceAlt, text: colors.textSecondary },
  'In Progress': { bg: colors.surfaceAlt, text: colors.primary },
  'Awaiting Outcome': { bg: '#EAF2DC', text: colors.primary },
  'Completed': { bg: colors.greenBg, text: colors.green },
};

export const getStatusColor = (status: string) => {
  return statusColors[status as keyof typeof statusColors] || statusColors['Pending'];
};
