/**
 * Share Bulletins — the Monday-morning two-tap flow.
 *
 * Opened from the "📣 Bulletins are ready" push (or any deep link to
 * /share-bulletins). On mount it:
 *   1. Computes the completed week — the previous week-ending Sunday,
 *      anchored to app time (UK; the push fires Monday morning) so every
 *      admin lands on the same week regardless of device timezone.
 *   2. Pulls both countrywide bulletins (Sign-ups and Team).
 *   3. Renders each poster with the SAME pipeline its own screen uses:
 *        • web/PWA → html-to-image PNG (one 612×1008pt page, 2x pixel ratio)
 *        • native  → expo-print PDF (612×1008 custom page size)
 *   4. Shares:
 *        • web/PWA → ONE share sheet with both PNGs attached
 *          (navigator.share with files — iOS/Android PWAs take multi-file);
 *          per-poster share/save buttons when multi-file share isn't there.
 *        • native  → expo-sharing, one file after another — each sheet's
 *          dismissal hands over the next, with a "Sharing 1 of 2" hint.
 *
 * Poster HTML comes from the bulletin screens' own exported builders —
 * zero forked layouts, so the posters here always match the screens.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Platform, Share } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '../src/theme/ThemeContext';
import { fonts } from '../src/theme/brand';
import { apiService } from '../src/api/client';
import { remoteImageDataUri } from '../src/utils/remoteImageDataUri';
import { BrandLoader } from '../src/components/ui/BrandLoader';
import PressableScale from '../src/components/ui/PressableScale';
import { Reveal } from '../src/components/ui/Reveal';
import { EmptyState } from '../src/components/ui/EmptyState';
import { useTabBarClearance } from '../src/customization/CustomTabBar';
import { lastWeekEndingISO, prettyWeekRange, prettyDate, POSTER } from '../src/utils/bulletinWeek';

import { getSalesBulletinPosterHtml, type Bulletin } from './bulletin';
import { getTeamBulletinPosterHtml, type TeamBulletin } from './team-bulletin';

// ── Poster page geometry — identical to the bulletins' own exports ─────────
const PAGE_W_PT = 612;
const PAGE_H_PT = 1008;
const PT_TO_PX = 4 / 3;

// ── Date helpers ───────────────────────────────────────────────────────────
/** The completed week's Sunday (previous week-ending), in app time (UK). */
const lastCompletedWeekEndingISO = lastWeekEndingISO;

// ── Poster model ───────────────────────────────────────────────────────────
type PosterStatus = 'pending' | 'rendering' | 'ready' | 'failed';
type Poster = {
  key: 'sales' | 'team';
  title: string;
  icon: any;
  accent: string;
  status: PosterStatus;
  note?: string;
  file?: File;      // web: PNG for the share sheet
  dataUrl?: string; // web: thumbnail preview
  uri?: string;     // native: PDF file
  filename: string;
  dialogTitle: string;
};

// Accents echo the Countrywide Bulletins hub cards.
function initialPosters(weekEnding: string): Poster[] {
  return [
    { key: 'sales', title: 'Sign-ups Bulletin', icon: 'trophy', accent: POSTER.limeDark, status: 'pending', filename: `signups-bulletin-${weekEnding}.png`, dialogTitle: 'Share Weekly Bulletin' },
    { key: 'team', title: 'Team Bulletin', icon: 'people', accent: POSTER.lime, status: 'pending', filename: `team-bulletin-${weekEnding}.png`, dialogTitle: 'Share Team Bulletin' },
  ];
}

// ── Web capture engine ─────────────────────────────────────────────────────
// Mirrors shareHtmlAsImage() in src/utils/deliverPdf.ts — the pipeline the
// bulletin screens' own share buttons already use on the PWA. Reproduced
// here because that util captures-and-shares in one step, and this screen
// needs the finished FILES first so one sheet can carry them all.
const HOST_ID = 'cg1-share-bulletins-host';

function waitForImages(el: HTMLElement, waitMs: number): Promise<void> {
  const pending = Array.from(el.querySelectorAll('img')).filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let left = pending.length;
    const timer = setTimeout(() => resolve(), waitMs);
    const done = () => {
      left -= 1;
      if (left <= 0) { clearTimeout(timer); resolve(); }
    };
    pending.forEach((img) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  });
}

async function renderPosterPngWeb(html: string, filename: string): Promise<{ file: File; dataUrl: string }> {
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(`${HOST_ID}-style`)?.remove();

  const src = new DOMParser().parseFromString(html, 'text/html');
  const srcCss = Array.from(src.querySelectorAll('style')).map((s) => s.textContent || '').join('\n');
  const bodyBg = src.body.getAttribute('style') || '';

  const host = document.createElement('div');
  host.id = HOST_ID;
  const inner = document.createElement('div');
  inner.classList.add('cg1-print-body');
  inner.style.width = `${PAGE_W_PT}pt`;
  if (bodyBg) inner.setAttribute('style', `${bodyBg};${inner.getAttribute('style') || ''}`);
  while (src.body.firstChild) inner.appendChild(document.adoptNode(src.body.firstChild));
  // The templates style `body` (dark bulletin backgrounds) — that body is now
  // our capture div, so retarget those selectors.
  const scopedCss = srcCss.replace(/(^|[}\s,])body(?=[\s,{.:#[])/g, `$1#${HOST_ID} .cg1-print-body`);
  // Exact page frame: clips overflow, white paper behind anything uncovered.
  const frame = document.createElement('div');
  frame.style.cssText = `width:${PAGE_W_PT}pt;height:${PAGE_H_PT}pt;overflow:hidden;background:#ffffff;`;
  frame.appendChild(inner);
  host.appendChild(frame);

  const style = document.createElement('style');
  style.id = `${HOST_ID}-style`;
  style.textContent = `
${scopedCss}
#${HOST_ID} { position: fixed; left: -10000px; top: 0; width: ${PAGE_W_PT}pt; }
`;
  document.head.appendChild(style);
  document.body.appendChild(host);

  try {
    // Custom fonts must be ready BEFORE the snapshot or the layout drifts.
    try { await (document as any).fonts?.ready; } catch { /* ignore */ }
    // Inline any remote imgs as data URIs — html-to-image drops <img>s it
    // can't re-fetch (CORS), which would lose profile pictures.
    await Promise.all(
      Array.from(inner.querySelectorAll('img'))
        .filter((img) => /^https?:/i.test(img.getAttribute('src') || ''))
        .map(async (img) => {
          const inlined = await remoteImageDataUri(img.getAttribute('src') || '');
          if (inlined.startsWith('data:')) img.setAttribute('src', inlined);
        }),
    );
    await waitForImages(inner, 1500);

    const { toPng } = await import('html-to-image');
    const wPx = Math.round(PAGE_W_PT * PT_TO_PX);
    const hPx = Math.round(PAGE_H_PT * PT_TO_PX);
    // Content taller than the page scales down to fit the one-page rule.
    const contentH = Math.max(1, inner.scrollHeight);
    if (contentH > hPx) {
      inner.style.transform = `scale(${hPx / contentH})`;
      inner.style.transformOrigin = 'top center';
    }
    // WebKit renders the intermediate SVG foreignObject lazily — the first
    // pass regularly misses images/fonts. Render repeatedly, keep the last.
    const isWebKit = /AppleWebKit/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//i.test(navigator.userAgent);
    let dataUrl = '';
    const passes = isWebKit ? 3 : 1;
    for (let p = 0; p < passes; p++) {
      dataUrl = await toPng(frame, { width: wPx, height: hPx, pixelRatio: 2, backgroundColor: '#ffffff' });
    }

    const blob = await (await fetch(dataUrl)).blob();
    return { file: new File([blob], filename, { type: 'image/png' }), dataUrl };
  } finally {
    host.remove();
    style.remove();
  }
}

// ── Native capture — the exact call the bulletin screens make ──────────────
async function renderPosterPdfNative(html: string): Promise<string> {
  const { uri } = await Print.printToFileAsync({ html, width: PAGE_W_PT, height: PAGE_H_PT });
  return uri;
}

function errDetail(e: any): string {
  return e?.response?.data?.detail || e?.message || 'Not available right now.';
}

// ── Screen ─────────────────────────────────────────────────────────────────
export default function ShareBulletinsScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const tabBarClearance = useTabBarClearance();
  const params = useLocalSearchParams<{ week_ending?: string }>();
  const weekEnding = useMemo(() => params.week_ending || lastCompletedWeekEndingISO(), [params.week_ending]);

  const [posters, setPosters] = useState<Poster[]>(() => initialPosters(weekEnding));
  const jobsTotal = posters.length;
  const [phase, setPhase] = useState<'generating' | 'ready' | 'error'>('generating');
  const [doneCount, setDoneCount] = useState(0);
  const [errorNote, setErrorNote] = useState<string>('');
  // Native sequential share progress ("Sharing 2 of 3").
  const [sharingIdx, setSharingIdx] = useState<number | null>(null);
  const [sharingTotal, setSharingTotal] = useState(0);
  // Web: can ONE sheet carry all files? null = not decided yet.
  const [multiShareOk, setMultiShareOk] = useState<boolean | null>(null);
  // Flips after the first share sheet actually opened, so the big button
  // reads "Share again" only once there was a first time.
  const [hasShared, setHasShared] = useState(false);
  const startedRef = useRef(false);
  const busyRef = useRef(false);

  const readyPosters = posters.filter((p) => p.status === 'ready');

  // ── Share: web — one sheet, all files ────────────────────────────────────
  const shareAllWeb = async (list?: Poster[]) => {
    const files = (list || posters).filter((p) => p.file).map((p) => p.file!);
    if (!files.length) return;
    const nav: any = navigator;
    try {
      if (nav.canShare?.({ files }) && nav.share) {
        await nav.share({ files, title: 'Vertex Hub · Weekly Bulletins' });
        setHasShared(true);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') setHasShared(true); // the sheet DID open
      // AbortError = the user closed the sheet; NotAllowedError = no user
      // gesture (the auto-attempt on mount). Either way the "Share all"
      // button and per-poster buttons stay on screen.
    }
  };

  // ── Share: web — single poster, with save fallback ───────────────────────
  const shareOneWeb = async (p: Poster) => {
    if (!p.file || !p.dataUrl) return;
    const nav: any = navigator;
    if (nav.canShare?.({ files: [p.file] }) && nav.share) {
      try {
        await nav.share({ files: [p.file], title: p.dialogTitle });
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        // fall through to download
      }
    }
    const a = document.createElement('a');
    a.href = p.dataUrl;
    a.download = p.filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ── Share: native — one sheet after another ──────────────────────────────
  const shareAllNative = async (list?: Poster[]) => {
    const ps = (list || posters).filter((p) => p.status === 'ready' && p.uri);
    setSharingTotal(ps.length);
    for (let i = 0; i < ps.length; i++) {
      setSharingIdx(i);
      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(ps[i].uri!, { mimeType: 'application/pdf', dialogTitle: ps[i].dialogTitle });
        } else {
          // expo-sharing unavailable (rare) — RN Share still hands the file
          // URL to the OS on iOS; Android degrades to sharing the path text.
          await Share.share(Platform.OS === 'ios' ? { url: ps[i].uri! } : { message: ps[i].uri! });
        }
      } catch {
        // One sheet failing must not strand the remaining posters.
      }
    }
    setSharingIdx(null);
    if (ps.length > 0) setHasShared(true);
  };

  const shareOneNative = async (p: Poster) => {
    if (!p.uri) return;
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(p.uri, { mimeType: 'application/pdf', dialogTitle: p.dialogTitle });
      } else {
        await Share.share(Platform.OS === 'ios' ? { url: p.uri } : { message: p.uri });
      }
    } catch { /* sheet dismissed */ }
  };

  const shareAll = (list?: Poster[]) => (Platform.OS === 'web' ? shareAllWeb(list) : shareAllNative(list));
  const shareOne = (p: Poster) => (Platform.OS === 'web' ? shareOneWeb(p) : shareOneNative(p));

  // ── Generate the posters, then auto-share ────────────────────────────────
  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setPhase('generating');
      setDoneCount(0);
      setMultiShareOk(null);
      const next = initialPosters(weekEnding);
      setPosters([...next]);

      // 1) Both datasets in parallel — one bulletin failing must not sink
      //    the other; the failed card says so and the rest ship.
      const [salesD, teamD] = await Promise.allSettled([
        apiService.getWeeklyBulletin(weekEnding).then((r) => r.data as Bulletin),
        apiService.getTeamBulletin(weekEnding).then((r) => r.data as TeamBulletin),
      ]);
      const jobs: Array<{ idx: number; data: PromiseSettledResult<any>; build: (d: any) => Promise<string> }> = [
        { idx: 0, data: salesD, build: (d) => getSalesBulletinPosterHtml(d) },
        { idx: 1, data: teamD, build: (d) => getTeamBulletinPosterHtml(d) },
      ];

      // 2) Capture sequentially — keeps memory calm on iOS and lets the
      //    progress line count up "1/2 → 2/2".
      let ok = 0;
      for (const job of jobs) {
        next[job.idx] = { ...next[job.idx], status: 'rendering' };
        setPosters([...next]);
        try {
          if (job.data.status !== 'fulfilled') throw new Error(errDetail(job.data.reason));
          const html = await job.build(job.data.value);
          if (Platform.OS === 'web') {
            const { file, dataUrl } = await renderPosterPngWeb(html, next[job.idx].filename);
            next[job.idx] = { ...next[job.idx], status: 'ready', file, dataUrl };
          } else {
            const uri = await renderPosterPdfNative(html);
            next[job.idx] = { ...next[job.idx], status: 'ready', uri };
          }
          ok += 1;
        } catch (e: any) {
          next[job.idx] = { ...next[job.idx], status: 'failed', note: errDetail(e) };
        }
        setPosters([...next]);
        setDoneCount(job.idx + 1);
      }

      if (ok === 0) {
        setErrorNote(next.find((p) => p.note)?.note || 'Try again.');
        setPhase('error');
        return;
      }
      setPhase('ready');

      // 3) Share. Native fires the sequential sheets right away (same
      //    no-gesture pattern the ?autoshare=1 flows already use). Web
      //    attempts the one-sheet share too — browsers that demand a fresh
      //    tap simply leave the big Share button waiting.
      if (Platform.OS === 'web') {
        const files = next.filter((p) => p.file).map((p) => p.file!);
        const nav: any = typeof navigator !== 'undefined' ? navigator : null;
        const can = !!(files.length && nav?.share && nav?.canShare?.({ files }));
        setMultiShareOk(can);
        if (can) await shareAllWeb(next);
      } else {
        await shareAllNative(next);
      }
    } catch (e: any) {
      setErrorNote(errDetail(e));
      setPhase('error');
    } finally {
      busyRef.current = false;
    }
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sharingNow = sharingIdx !== null;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header bar */}
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Share Bulletins</Text>
        <View style={styles.headerBtn} />
      </View>

      {/* Week chip — the completed week the posters cover */}
      <View style={styles.weekChipRow}>
        <Ionicons name="calendar-outline" size={14} color={colors.primary} />
        <Text style={styles.weekChipText}>{prettyWeekRange(weekEnding)}</Text>
        <Text style={styles.weekChipSub}>w/e {prettyDate(weekEnding)}</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 + tabBarClearance }} showsVerticalScrollIndicator={false}>
        {phase === 'error' ? (
          <EmptyState
            emoji="🗞️"
            title="Bulletins aren't ready yet"
            subtitle={errorNote}
            actionLabel="Try again"
            onAction={run}
          />
        ) : (
          <View style={{ paddingHorizontal: 14 }}>
            {/* Progress banner while generating */}
            {phase === 'generating' && (
              <View style={styles.progressCard}>
                <BrandLoader size={44} />
                <Text style={styles.progressTitle}>Generating last week's bulletins… {Math.min(doneCount + 1, jobsTotal)}/{jobsTotal}</Text>
                <Text style={styles.progressSub}>They'll be ready to send in a moment.</Text>
              </View>
            )}

            {/* Native sequential-share hint */}
            {sharingNow && (
              <View style={styles.sharingHint}>
                <Ionicons name="share-outline" size={15} color={colors.primary} />
                <Text style={styles.sharingHintText}>
                  Sharing {Math.min((sharingIdx || 0) + 1, sharingTotal)} of {sharingTotal}… close each sheet to get the next poster.
                </Text>
              </View>
            )}

            {/* Poster thumbnails */}
            <View style={styles.thumbRow}>
              {posters.map((p, i) => (
                <Reveal key={p.key} index={i} style={styles.thumbCol}>
                  <View style={[styles.thumbCard, { borderColor: p.status === 'ready' ? p.accent : colors.border }]}>
                    {p.status === 'ready' && p.dataUrl ? (
                      <Image source={{ uri: p.dataUrl }} style={styles.thumbImage} resizeMode="cover" />
                    ) : (
                      <View style={styles.thumbPlaceholder}>
                        <Ionicons name={p.icon} size={26} color={p.status === 'ready' ? p.accent : POSTER.rule} />
                        {p.status === 'ready' ? (
                          <View style={styles.readyPill}>
                            <Ionicons name="checkmark" size={11} color={POSTER.forest} />
                            <Text style={styles.readyPillText}>PDF ready</Text>
                          </View>
                        ) : p.status === 'rendering' ? (
                          <Text style={styles.thumbStateText}>Rendering…</Text>
                        ) : p.status === 'failed' ? (
                          <Text style={styles.thumbStateText}>Not available this week</Text>
                        ) : (
                          <Text style={styles.thumbStateText}>Queued</Text>
                        )}
                      </View>
                    )}
                  </View>
                  <View style={styles.thumbLabelRow}>
                    <View style={[styles.thumbDot, { backgroundColor: p.accent }]} />
                    <Text style={styles.thumbLabel} numberOfLines={1}>{p.title}</Text>
                  </View>
                  {p.status === 'ready' && (
                    <TouchableOpacity style={styles.miniShareBtn} onPress={() => shareOne(p)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Ionicons name="share-outline" size={13} color={colors.primary} />
                      <Text style={styles.miniShareText}>{Platform.OS === 'web' && multiShareOk === false ? 'Share / save' : 'Share'}</Text>
                    </TouchableOpacity>
                  )}
                </Reveal>
              ))}
            </View>

            {/* Primary share button */}
            {phase === 'ready' && readyPosters.length > 0 && (
              Platform.OS === 'web' && multiShareOk === false ? (
                <View style={styles.fallbackNote}>
                  <Ionicons name="information-circle-outline" size={15} color={colors.textMuted} />
                  <Text style={styles.fallbackNoteText}>
                    This browser shares one image at a time — use the button under each bulletin.
                  </Text>
                </View>
              ) : (
                <PressableScale
                  style={[styles.shareAllBtn, sharingNow && { opacity: 0.5 }]}
                  onPress={() => shareAll()}
                  disabled={sharingNow}
                >
                  <Ionicons name="logo-whatsapp" size={19} color="#fff" />
                  <Text style={styles.shareAllText}>
                    {sharingNow
                      ? `Sharing ${Math.min((sharingIdx || 0) + 1, sharingTotal)} of ${sharingTotal}…`
                      : hasShared
                        ? 'Share again'
                        : `Share ${readyPosters.length === jobsTotal ? 'all' : `${readyPosters.length}`} to WhatsApp`}
                  </Text>
                </PressableScale>
              )
            )}

            {phase === 'ready' && (
              <Text style={styles.footNote}>
                Sign-ups & Team cover w/e {prettyDate(weekEnding)}
              </Text>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────
const createStyles = (colors: any) => StyleSheet.create({
  root: { flex: 1 },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontFamily: fonts.display, color: colors.text, letterSpacing: 0.3 },
  weekChipRow: {
    alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
    marginVertical: 10,
  },
  weekChipText: { fontSize: 13, fontWeight: '800', color: colors.text },
  weekChipSub: { fontSize: 11, fontWeight: '700', color: colors.textMuted },

  progressCard: {
    alignItems: 'center', gap: 8,
    backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border,
    paddingVertical: 22, paddingHorizontal: 16, marginBottom: 14,
  },
  progressTitle: { fontSize: 14, fontWeight: '900', color: colors.text, letterSpacing: 0.2, textAlign: 'center' },
  progressSub: { fontSize: 12, fontWeight: '600', color: colors.textMuted, textAlign: 'center' },

  sharingHint: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
  },
  sharingHintText: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.text },

  thumbRow: { flexDirection: 'row', gap: 10 },
  thumbCol: { flex: 1 },
  thumbCard: {
    aspectRatio: PAGE_W_PT / PAGE_H_PT, borderRadius: 12, borderWidth: 1.5,
    overflow: 'hidden', backgroundColor: POSTER.deep,
  },
  thumbImage: { width: '100%', height: '100%' },
  thumbPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 8 },
  readyPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: POSTER.lime, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3,
  },
  readyPillText: { color: POSTER.forest, fontSize: 9, fontWeight: '900', letterSpacing: 0.3 },
  thumbStateText: { color: POSTER.rule, fontSize: 10, fontWeight: '700', textAlign: 'center' },
  thumbLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8, justifyContent: 'center' },
  thumbDot: { width: 6, height: 6, borderRadius: 3 },
  thumbLabel: { fontSize: 11, fontWeight: '800', color: colors.text },
  miniShareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    marginTop: 6, paddingVertical: 5, borderRadius: 8,
    backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.border,
  },
  miniShareText: { fontSize: 11, fontWeight: '800', color: colors.primary },

  fallbackNote: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, marginTop: 18,
  },
  fallbackNoteText: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.textMuted },

  shareAllBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#25D366', borderRadius: 14, paddingVertical: 14,
    marginTop: 18,
  },
  shareAllText: { color: '#fff', fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
  footNote: { fontSize: 10, fontWeight: '600', color: colors.textMuted, textAlign: 'center', marginTop: 14 },
});
