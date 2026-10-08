/**
 * SafeLottie — LottieView behind a guard rail. Lottie is decoration here,
 * never structure: if the module fails to load on some platform/bundle, or
 * the render throws, this renders nothing instead of taking the screen
 * down with it. Use for sparkle only.
 */
import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';

let LottieView: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  LottieView = require('lottie-react-native').default;
} catch {
  LottieView = null;
}

type Props = {
  source: any;
  style?: StyleProp<ViewStyle>;
  loop?: boolean;
  autoPlay?: boolean;
  speed?: number;
};

class LottieBoundary extends React.Component<{ children: React.ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError() { return { dead: true }; }
  componentDidCatch() {} // decoration — swallow
  render() { return this.state.dead ? null : this.props.children; }
}

export function SafeLottie({ source, style, loop = false, autoPlay = true, speed = 1 }: Props) {
  if (!LottieView) return null;
  return (
    <LottieBoundary>
      <LottieView source={source} style={style} loop={loop} autoPlay={autoPlay} speed={speed} />
    </LottieBoundary>
  );
}
