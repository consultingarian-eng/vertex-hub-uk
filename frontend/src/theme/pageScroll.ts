/**
 * App-wide scroll + tab phase, shared on the UI thread.
 *
 * The focused screen's OUTER ScrollView feeds `pageScrollY` (via
 * useParallaxScroll or the Screen shell); the tab bar writes `pageTab` and
 * bumps `pageMarkKick` on every tab change. Mount-once chrome (PageField,
 * Masthead, the brand cube) reads these so the whole app reacts to scrolling
 * without any screen knowing about it. Only the outer ScrollView of a screen
 * may feed it — inner pickers/grids must not.
 */
import { makeMutable } from 'react-native-reanimated';

export const pageScrollY = makeMutable(0);   // focused screen's scroll offset (px)
export const pageTab = makeMutable(0);       // active bottom-tab index (0..7)
export const pageMarkKick = makeMutable(0);  // +1 per tab change → Vertex mark pop
