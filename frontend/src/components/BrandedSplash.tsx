import React, { useEffect, useRef, useMemo } from 'react';
import {
  View, Text, StyleSheet, Animated, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme/ThemeContext';
import { APP_NAME, ORG_NAME, brand, fonts, GRADIENT } from '../theme/brand';
import { DotField } from './ui/Decor';
import { VertexLogo } from './ui/VertexMark';
import { BrandLoader } from './ui/BrandLoader';

// Vertex brand splash — the logo on a forest (or paper) surface, halftone
// dot fields in the corners, gradient organisation pill.
const DARK_BG  = '#061410';   // = darkColors.page (the abyss the PageField paints)
const LIGHT_BG = '#f0f4e9';   // = lightColors.page — no colour jump when the app mounts

export function BrandedSplash() {
  const { effective } = useTheme();
  const dark = effective === 'dark';

  // Fade-in the whole screen once on mount
  const opacity = useRef(new Animated.Value(0)).current;
  // Gentle continuous pulse on the logo only
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 600,
      useNativeDriver: Platform.OS !== 'web',
    }).start();

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.05, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 1.00, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
      ])
    ).start();
  }, [opacity, pulse]);

  const styles = useMemo(() => createStyles(dark), [dark]);

  return (
    <Animated.View style={[styles.root, { opacity }]}>
      {/* Lime glow + the logo's halftone dots fading in from two corners */}
      <View style={styles.glow} pointerEvents="none" />
      <DotField size={240} opacity={dark ? 0.22 : 0.16} corner="top-right" style={{ top: 0, right: 0 }} />
      <DotField size={280} opacity={dark ? 0.18 : 0.12} corner="bottom-left" style={{ bottom: 0, left: 0 }} />

      {/* The Vertex logo: lime on forest at night, brand green on paper */}
      <Animated.View style={[styles.logoWrap, { transform: [{ scale: pulse }] }]}>
        <VertexLogo width={240} color={dark ? brand.lime : brand.mid} />
      </Animated.View>

      {/* Wordmark */}
      <Text style={styles.title}>{APP_NAME.toUpperCase()}</Text>

      {/* Organisation pill — brand gradient */}
      <LinearGradient
        colors={GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.badge}
      >
        <Text style={styles.badgeText}>{ORG_NAME.toUpperCase()}</Text>
      </LinearGradient>

      {/* Tagline */}
      <Text style={styles.tagline}>LEARN TODAY, LEAD TOMORROW.</Text>

      {/* The logo's dot trail as the loading indicator */}
      <View style={styles.spinnerWrap}>
        <BrandLoader size={36} />
      </View>
    </Animated.View>
  );
}

const createStyles = (dark: boolean) =>
  StyleSheet.create({
    root: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: dark ? DARK_BG : LIGHT_BG,
    },
    glow: {
      position: 'absolute',
      top: '32%',
      width: 320,
      height: 320,
      borderRadius: 160,
      backgroundColor: brand.lime,
      opacity: dark ? 0.16 : 0.22,
    },
    logoWrap: {
      marginBottom: 20,
    },
    title: {
      fontFamily: fonts.display,
      fontSize: 24,
      fontWeight: '800',
      letterSpacing: 1,
      color: dark ? brand.paper : brand.forest,
      marginBottom: 12,
    },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 20,
      paddingHorizontal: 18,
      paddingVertical: 5,
      marginBottom: 14,
    },
    badgeText: {
      fontFamily: fonts.displayMedium,
      color: '#fff',
      fontSize: 14,
      fontWeight: '700',
      letterSpacing: 2,
      lineHeight: 20,
    },
    tagline: {
      fontFamily: fonts.mono,
      fontSize: 10,
      letterSpacing: 2.5,
      color: dark ? brand.sage : brand.muted,
      fontWeight: '500',
    },
    spinnerWrap: {
      position: 'absolute',
      bottom: 80,
      alignSelf: 'center',
    },
  });

export default BrandedSplash;
