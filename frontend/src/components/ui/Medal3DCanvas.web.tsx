/**
 * Medal3DCanvas (web) — the REAL 3D medal renderer: a metallic coin rendered with three.js,
 * slowly turning under studio lighting, with the level emoji overlaid dead
 * center. Web-only by design — the PWA is the primary surface and WebGL is
 * universal there; native (Expo Go) resolves Medal3D.tsx instead, which
 * falls back to the reanimated coin so nothing fragile ships in the app
 * binary. Same props both sides: drop-in.
 */
import React, { useRef } from 'react';
import { View } from 'react-native';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

function Coin({ tint }: { tint: string }) {
  const group = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!group.current) return;
    const t = state.clock.getElapsedTime();
    group.current.rotation.y = Math.sin(t * 0.8) * 0.55;
    group.current.rotation.z = Math.sin(t * 0.5) * 0.08;
    group.current.rotation.x = 0.12 + Math.sin(t * 0.6) * 0.05;
  });
  return (
    <group ref={group}>
      {/* Face-on coin: rotate the cylinder so its flat face looks at the camera. */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[1.15, 1.15, 0.22, 64]} />
        <meshStandardMaterial color={tint} metalness={0.92} roughness={0.22} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.115]}>
        <cylinderGeometry args={[0.94, 0.94, 0.02, 64]} />
        <meshStandardMaterial color={tint} metalness={0.75} roughness={0.35} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.125]}>
        <torusGeometry args={[1.04, 0.045, 16, 64]} />
        <meshStandardMaterial color="#ffffff" metalness={1} roughness={0.15} />
      </mesh>
    </group>
  );
}

export default function Medal3DCanvas({ size = 56, tint = '#c9a227', children }: {
  size?: number; tint?: string; children?: React.ReactNode;
}) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Canvas
        style={{ position: 'absolute', top: -size * 0.25, left: -size * 0.25, width: size * 1.5, height: size * 1.5 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        camera={{ position: [0, 0, 3.1], fov: 45 }}
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[3, 4, 5]} intensity={2.2} />
        <directionalLight position={[-4, -2, 3]} intensity={0.7} color="#b7df58" />
        <pointLight position={[0, 0, 4]} intensity={0.9} color="#ffffff" />
        <Coin tint={tint} />
      </Canvas>
      {/* The emoji rides ON the coin — 2D over 3D keeps it crisp at any dpr. */}
      <View pointerEvents="none">{children}</View>
    </View>
  );
}
