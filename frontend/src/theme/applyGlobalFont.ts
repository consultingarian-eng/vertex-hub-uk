/**
 * Applies the brand body font (Inter) as the app-wide default for <Text> and
 * <TextInput> — so all 87+ screens adopt Inter without editing every style.
 *
 * Why not Text.defaultProps.style? React ignores a default `style` whenever a
 * component passes its own `style` prop (props override defaults, they don't
 * merge), and nearly every Text in the app is styled. Instead we wrap the
 * forwardRef `render` and inject Inter as the *base* of the style array:
 *
 *     style: [{ fontFamily: 'Inter' }, el.props.style]
 *
 * The instance's own style comes LAST, so it always wins — meaning:
 *   • a Text that sets its own fontFamily (e.g. Ionicons' icon font, or an
 *     explicit SpaceGrotesk/JetBrains Mono heading) keeps it, and
 *   • everything else falls back to Inter instead of the system font.
 *
 * fontWeight still works via synthesis (fake-bold) on Inter; screens that need
 * true weights use the named families (Inter-Bold, SpaceGrotesk-Bold, …).
 *
 * Imported for its side effect once, at the top of app/_layout.tsx.
 */
import React from 'react';
import { Platform, Text, TextInput } from 'react-native';

const BASE = { fontFamily: 'Inter' as const };

function patch(Component: any) {
  if (!Component || Component.__brandFontPatched) return;
  const original = Component.render;
  // forwardRef components expose a mutable `render` function — the reliable
  // injection point in RN 0.81. If it's not present (e.g. a plain class),
  // skip rather than risk breaking rendering.
  if (typeof original !== 'function') return;
  Component.render = function (...args: any[]) {
    const el = original.apply(this, args);
    if (!el) return el;
    // Prepend Inter as the base so the element's own style (icon fonts,
    // explicit brand fonts, …) still wins. A style ARRAY is valid on native
    // RN; on react-native-web the render output is a DOM host element whose
    // `style` must be a plain object, so we never take this path on web.
    return React.cloneElement(el, {
      style: [BASE, (el.props && el.props.style) || undefined],
    });
  };
  Component.__brandFontPatched = true;
}

// Native only. On web, react-native-web resolves styles onto DOM elements and
// an array style throws ("indexed property setter on CSSStyleDeclaration"),
// blanking the app — so we skip the patch there. Web still gets brand fonts on
// every explicitly-styled surface (headings, numbers, front-door); generic
// body text falls back to the system font.
if (Platform.OS !== 'web') {
  patch(Text);
  patch(TextInput);
}

export {};
