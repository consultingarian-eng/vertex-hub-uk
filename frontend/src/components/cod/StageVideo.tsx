/**
 * StageVideo — the "watch this first" briefing at the top of a COD stage.
 *
 * Dependency-free on purpose: CG1 ships primarily as a PWA, so web gets a
 * real inline HTML5 player (Cloudinary streams fine); native gets a play
 * card that opens the video in the system player via Linking. No expo-av,
 * no native rebuild.
 *
 * Visual system ("Ink & Cube" §4 COD): the briefing is a DepthCard like the
 * stage hero and the cards under it — a floating card face, a 26px
 * gradient-rimmed play well (the stage hero's link-well recipe) and the
 * WATCH FIRST tag as a brand-gradient pill in white.
 *
 * The player sits in an ink WELL with a POSTER plate. Without one the browser
 * paints the asset's first decoded frame at rest, and the Stage 1 briefing
 * opens on a white title slide — a ~308x174 white slab on the dark page
 * (review R1). The plate below is 53x30 (= 848x480, the asset's exact ratio,
 * so `object-fit: contain` fits it edge to edge with no letterbox seam) and
 * carries the page's own violet bloom, so the card reads as a dark player in
 * both themes until the rep hits play. Nothing about playback changes.
 *
 * Review R2: the largest element on the COD page was still a raw <video
 * controls> — a near-black slab wearing the BROWSER's grey scrub bar and
 * play/volume/fullscreen glyphs inside an otherwise overhauled white card. So
 * the well now wears a GRADIENT_XP rim and, until the first tap, a POSTER face
 * with a 56px gradient Keycap play key — the same key language as the rest of
 * the stage. The <video> stays mounted underneath (so the tap can call play()
 * synchronously inside the gesture and no browser blocks the audio), but it
 * only takes the `controls` attribute once playback has started: every static
 * screenshot the owner judges from now shows the designed face, and the
 * letterbox is colors.ink rather than #000 so it matches the well in both
 * themes. Same URL, same element, same focus-pause — playback is untouched.
 */
import React, { useRef, useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, Linking, Image } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { useColors, fonts } from '../../theme/ThemeContext';
import { GRADIENT, GRADIENT_XP } from '../../theme/brand';
import { DepthCard } from '../ui/DepthCard';
import { Keycap } from '../ui/Keycap';
import { apiService } from '../../api/client';

// 53x30 PNG (848:480 — the briefing assets' ratio): forest bloom, well under 1 kB
// inline so it needs no network request and cannot itself flash white.
const POSTER_PLATE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADUAAAAeCAIAAAAD78HSAAACh0lEQVR42s1X223DMBC7AhqjS3SA7r+V2Q9LOvIesgv0o26RxHIS0XxJ+fj8/jLIn5kB99NfjQPAevRTGjc+3SMAxvyK/3QwoGH7zteVjRiG5vO/Ha/P8AKk8AeaIkjGuF/C2l9kMP1/MzIHK30dkb5scIfH6n6QmEFzH3FwFNT5dyC+QI/7Qdw8/c3Sg/rEH1SvIHQHDkczzDy6ZCvCBheR3jBnd5SqL+zkxTfg5A6BxZHOikQenBTFPTpMNbKccaC3rC3SbHE2Zy3IUw/sWY/5KJF1GY+hAU0PUdYpIliAMjfHmn6uvPhecVoJNmdwZZ1CuAf2O3lyw0j5wdmLlQF1KaNY+HplAQ2xy+kw0yXOxql10Zw37eMrqflSm8CR1vOzQmcQ+mn9LWHl9nEQkwFpE8ubg3U3gWbJ+73+5k6uvBhhcQ4WpBVV0ODezrwDZ8J9tX/Bkxeh1DlDq0hgSttWnHxpDbi0B6v75eTFhWrh3wiC25S2WnE7g4v93LW0QXA5YRbIczoL2rYNAF79VHHtJmv5A5Mlg6jMJ5xNZAwawQZq0ESw0z9wwayTuCzntAPYzVLRubVTjllTvR+wlTHsuuq8shFRbGaUy00De9HpJF6JtqBpqEnDvb5dh2TwZp+FBrlQvOiCI3mxzvVZ8Vvf1n98Gn+WALEIQ2KIsyioZdpCPe1+TvqGhGShY5AthFesyZyp4qEOtZ58f3rhsLSFJCc6yXw5MWV64npT5JoP8h+6nw/1FlX6OcIKVwNnUeitbD6GXTgTVwmN7MU2MaG9E51B0MTfqf9iSZ+7Rtg6tPc7ZBvfdfbfY9eoFxMsrsl86eno85vFjatc7hoq59zevJN4ffwAKQYSNKpwD9oAAAAASUVORK5CYII=';

// Soft amber→green bloom raked across the poster plate (the ink hero's own
// light). Raw rgba, never a concatenated token.
const BLOOM = ['rgba(231,182,92,0.30)', 'rgba(58,122,86,0.16)', 'rgba(5,15,11,0)'] as const;

export function useCodVideos() {
  return useQuery({
    queryKey: ['cod-videos'],
    queryFn: () => apiService.getCodVideos().then((r) => r.data),
    staleTime: 10 * 60 * 1000,
  });
}

/**
 * The designed face of the well: the violet poster plate with a 56px gradient
 * play key centred on it. Static — no loop, one Keycap.
 */
function PlayFace({ ink, children }: { ink: string; children?: React.ReactNode }) {
  return (
    <View pointerEvents="none" style={[s.face, { backgroundColor: ink }]}>
      <Image source={{ uri: POSTER_PLATE }} style={s.plate} resizeMode="cover" />
      {/* Plum bloom over the plate so the well reads as the same ink material
          as the stage hero above it rather than as a black hole. */}
      <LinearGradient
        colors={BLOOM}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={s.plate}
      />
      <Keycap size={56} tone="gradient">
        <Ionicons name="play" size={26} color="#fff" style={s.playGlyph} />
      </Keycap>
      {children}
    </View>
  );
}

export function StageVideo({ url, title }: { url?: string | null; title: string }) {
  const colors = useColors();
  const videoRef = useRef<any>(null);
  // Browser chrome is mounted only once the rep has actually started the
  // briefing, so the resting card is the designed face (review R2).
  const [started, setStarted] = useState(false);
  // Tab screens stay mounted — without this, a playing video keeps its audio
  // running after you switch tabs. Pause whenever the screen loses focus.
  useFocusEffect(
    useCallback(() => {
      return () => { try { videoRef.current?.pause?.(); } catch { /* ignore */ } };
    }, []),
  );
  // play() is called inside the press handler (not in an effect after the
  // re-render) so it is still inside the user gesture and Safari/Chrome let the
  // audio through — the video element is already in the DOM, just chrome-less.
  const start = useCallback(() => {
    setStarted(true);
    try { videoRef.current?.play?.(); } catch { /* ignore */ }
  }, []);
  if (!url) return null;
  return (
    <DepthCard style={s.wrap}>
      <View style={s.head}>
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.playWell}>
          <Ionicons name="play" size={13} color="#fff" />
        </LinearGradient>
        <Text style={[s.title, { color: colors.text }]} numberOfLines={2}>{title}</Text>
        <LinearGradient colors={GRADIENT} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={s.tagPill}>
          <Text style={s.tag}>WATCH FIRST</Text>
        </LinearGradient>
      </View>
      {/* GRADIENT_XP rim — the same lit edge the XP rails and rings wear. */}
      <LinearGradient colors={GRADIENT_XP} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.rim}>
        {Platform.OS === 'web' ? (
          // The well is opaque ink in its own right, so an unloaded, letterboxed
          // or failed video can never show anything pale through it.
          <View style={[s.well, { backgroundColor: colors.ink }]}>
            {
              // @ts-ignore — raw DOM element on web only
              <video ref={videoRef} src={url} poster={POSTER_PLATE} controls={started} playsInline preload="metadata"
                style={{
                  display: 'block', position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                  // objectFit stays `contain`: these briefings are slide decks,
                  // and `cover` would crop the words off the edges. The ink
                  // letterbox (was '#000') now matches the well in both themes.
                  objectFit: 'contain', backgroundColor: colors.ink,
                }} />
            }
            {started ? null : (
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={0.85}
                onPress={start}
                accessibilityRole="button"
                accessibilityLabel={title}
              >
                <PlayFace ink={colors.ink} />
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <TouchableOpacity
            style={[s.well, { backgroundColor: colors.ink }]}
            activeOpacity={0.85}
            onPress={() => Linking.openURL(url)}
          >
            <PlayFace ink={colors.ink}>
              <Text style={s.playText}>Play video</Text>
            </PlayFace>
          </TouchableOpacity>
        )}
      </LinearGradient>
      <Text style={[s.sub, { color: colors.textMuted }]}>
        This briefing sets the expectations for the stage — watch it before working the modules.
      </Text>
    </DepthCard>
  );
}

const s = StyleSheet.create({
  // DepthCard owns the fill + layered shadow; the outer margins keep the
  // card exactly where the hosts place it (onboarding / cod-intro cancel the
  // 12px with a -12 wrapper, so this number must not change).
  wrap: { borderRadius: 18, padding: 12, marginHorizontal: 12, marginTop: 12 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  // 1.5px gradient rim around the well (carries the radius the well clips to).
  rim: { borderRadius: 13.5, padding: 1.5 },
  // Ink well: the radius/clip lives here so the raw <video> stays square-edged
  // (a DOM element's own border-radius does not clip its control bar on iOS).
  // 848:480 is the briefing assets' exact ratio, so the face has no seam.
  well: { borderRadius: 12, overflow: 'hidden', aspectRatio: 848 / 480, maxHeight: 260 },
  // Poster face: the violet bloom plate behind the play key.
  face: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 8 },
  plate: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%' },
  // Optical centring: a play triangle's mass sits left of its glyph box.
  playGlyph: { marginLeft: 3 },
  playWell: {
    width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 4px 10px -3px rgba(58,122,86,0.55)',
  },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 14, letterSpacing: -0.2 },
  tagPill: {
    borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3,
    boxShadow: '0 4px 10px -4px rgba(58,122,86,0.65)',
  },
  // Unbounded SemiBold — never add fontWeight to displayWide (faux-bold on web)
  tag: { fontFamily: fonts.displayWide, fontSize: 8, letterSpacing: 0.5, color: '#fff' },
  // Sits over the poster face on native (the face is pointer-events none).
  playText: { fontFamily: fonts.bodyBold, fontSize: 13, color: '#fff' },
  sub: { fontFamily: fonts.body, fontSize: 11.5, lineHeight: 16, marginTop: 10 },
});
