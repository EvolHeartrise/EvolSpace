// Unlit shader materials for resid-flow. Everything is billboarded in view
// space in the vertex shader (works per eye in WebXR), so trajectories are
// cheap two-vertex-wide strips that read as tubes, and nodes/ticks are single
// instanced quads. Colors are linear; <colorspace_fragment> converts to the
// renderer's output color space.

import type * as THREE_NS from 'three';

type ThreeLib = typeof THREE_NS;

/** Selection/hover token comparisons tolerate float attributes. */
const COMMON = /* glsl */ `
float tokenIs(float tok, float sel) { return sel < -0.5 ? 0.0 : 1.0 - step(0.5, abs(tok - sel)); }
`;

const RIBBON_VERT = /* glsl */ `
attribute vec3 aTangent;
attribute vec4 aData;   // side, u, weight, token
attribute vec3 aColor;
uniform float uWidth;
uniform float uMinWidth;
uniform float uSel;
uniform float uHover;
uniform float uDim;
varying vec3 vColor;
varying float vSide;
varying float vU;
varying float vPhase;
varying float vBright;
varying float vEmph;
${COMMON}
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 t = (modelViewMatrix * vec4(aTangent, 0.0)).xyz;
  float scale = length(modelViewMatrix[0].xyz);
  vec3 side = cross(t, normalize(-mv.xyz));
  float sl = length(side);
  side = sl > 1e-8 ? side / sl : vec3(1.0, 0.0, 0.0);
  float tok = aData.w;
  float isSel = tokenIs(tok, uSel);
  float isHov = tokenIs(tok, uHover);
  float emph = max(isSel, isHov * 0.7);
  float w = (uMinWidth + (uWidth - uMinWidth) * aData.z) * (1.0 + 0.9 * isSel + 0.5 * isHov);
  mv.xyz += side * (aData.x * 0.5 * w * scale);
  gl_Position = projectionMatrix * mv;
  // Dim everything else while a token is selected (uDim = 1).
  float others = (uSel > -0.5 && uDim > 0.5) ? 0.32 : 1.0;
  vBright = mix(others, 1.15, emph) * (0.6 + 0.4 * aData.z);
  vEmph = emph;
  vColor = aColor;
  vSide = aData.x;
  vU = aData.y;
  vPhase = fract(sin(tok * 12.9898 + 0.5) * 43758.5453);
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform float uTime;
uniform float uParticles;
uniform float uSpeed;
uniform float uPeriod;
uniform float uLens;
uniform float uOpacity;
varying vec3 vColor;
varying float vSide;
varying float vU;
varying float vPhase;
varying float vBright;
varying float vEmph;
void main() {
  // Fake cylinder shading across the strip.
  float shade = sqrt(max(0.0, 1.0 - vSide * vSide));
  vec3 c = vColor * (0.45 + 0.55 * shade) * vBright;
  // Glow where the trajectory crosses the lens plane.
  float lens = 1.0 - smoothstep(0.0, 0.14, abs(vU - uLens));
  c += vColor * lens * 0.55;
  // Flow particles: comets travelling toward increasing u (upward / key→query).
  if (uParticles > 0.5) {
    float s = fract((vU - uTime * uSpeed) / uPeriod + vPhase);
    float comet = pow(s, 14.0) * shade;
    c = mix(c, vec3(1.0), comet * (0.55 + 0.35 * vEmph) * min(1.0, vBright + 0.3));
  }
  gl_FragColor = vec4(c, uOpacity);
  #include <colorspace_fragment>
}
`;

const NODE_VERT = /* glsl */ `
attribute vec4 aInfo;   // token, layer, weight, unused
attribute vec3 aColor;
uniform float uSize;
uniform float uSel;
uniform float uHover;
uniform float uLensLayer;
uniform float uDim;
varying vec2 vUv;
varying vec3 vColor;
varying float vSel;
varying float vBright;
${COMMON}
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float scale = length(modelViewMatrix[0].xyz);
  float isSel = tokenIs(aInfo.x, uSel);
  float isHov = tokenIs(aInfo.x, uHover);
  float onLens = 1.0 - step(0.5, abs(aInfo.y - uLensLayer));
  float s = uSize * (0.65 + 0.5 * aInfo.z) * (1.0 + 0.45 * onLens + 0.9 * isSel * onLens + 0.5 * isHov);
  mv.xy += position.xy * s * scale;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0;
  vColor = aColor;
  vSel = max(isSel, isHov);
  float others = (uSel > -0.5 && uDim > 0.5) ? 0.4 : 1.0;
  vBright = mix(others, 1.2, max(isSel, isHov)) * mix(0.85, 1.15, onLens);
}
`;

const NODE_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vSel;
varying float vBright;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  vec3 c = vColor * vBright;
  // Bright core, darker rim; selected/hovered nodes get a white ring.
  c *= mix(1.15, 0.55, smoothstep(0.45, 0.95, r));
  float ring = smoothstep(0.68, 0.76, r) * (1.0 - smoothstep(0.9, 0.98, r));
  c = mix(c, vec3(1.0), ring * vSel);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

const TICK_VERT = /* glsl */ `
attribute vec4 aTick;   // value, kind, token, layer
uniform float uNodeSize;
uniform float uBarW;
uniform float uBarH;
uniform float uSel;
uniform float uLensLayer;
uniform vec3 uColA;
uniform vec3 uColB;
varying vec3 vColor;
${COMMON}
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float scale = length(modelViewMatrix[0].xyz);
  float h = max(0.0008, aTick.x * uBarH);
  // Bars stand to the right of the node (screen space), attn then MLP.
  float x = uNodeSize * 0.75 + uBarW * (0.5 + aTick.y * 1.6);
  vec2 off = vec2(x + position.x * uBarW, -uNodeSize * 0.35 + (position.y + 0.5) * h);
  mv.xy += off * scale;
  gl_Position = projectionMatrix * mv;
  float focus = max(tokenIs(aTick.z, uSel), 1.0 - step(0.5, abs(aTick.w - uLensLayer)));
  vColor = mix(uColA, uColB, aTick.y) * mix(0.45, 1.1, focus);
}
`;

const TICK_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
  #include <colorspace_fragment>
}
`;

export interface RibbonUniforms {
  [k: string]: { value: unknown };
  uWidth: { value: number };
  uMinWidth: { value: number };
  uSel: { value: number };
  uHover: { value: number };
  uDim: { value: number };
  uTime: { value: number };
  uParticles: { value: number };
  uSpeed: { value: number };
  uPeriod: { value: number };
  uLens: { value: number };
  uOpacity: { value: number };
}

export function ribbonMaterial(THREE: ThreeLib, opts: { transparent?: boolean } = {}): THREE_NS.ShaderMaterial & { uniforms: RibbonUniforms } {
  const uniforms: RibbonUniforms = {
    uWidth: { value: 0.006 }, uMinWidth: { value: 0.0015 }, uSel: { value: -1 }, uHover: { value: -1 }, uDim: { value: 1 },
    uTime: { value: 0 }, uParticles: { value: 1 }, uSpeed: { value: 1.4 }, uPeriod: { value: 3.2 }, uLens: { value: -100 },
    uOpacity: { value: 1 },
  };
  const m = new THREE.ShaderMaterial({
    uniforms, vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG,
    side: THREE.DoubleSide, transparent: !!opts.transparent, depthWrite: !opts.transparent,
  });
  return m as THREE_NS.ShaderMaterial & { uniforms: RibbonUniforms };
}

export function nodeMaterial(THREE: ThreeLib): THREE_NS.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 0.012 }, uSel: { value: -1 }, uHover: { value: -1 }, uLensLayer: { value: -100 }, uDim: { value: 1 } },
    vertexShader: NODE_VERT, fragmentShader: NODE_FRAG, side: THREE.DoubleSide,
  });
}

export function tickMaterial(THREE: ThreeLib, colA: THREE_NS.Color, colB: THREE_NS.Color): THREE_NS.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uNodeSize: { value: 0.012 }, uBarW: { value: 0.0028 }, uBarH: { value: 0.03 }, uSel: { value: -1 }, uLensLayer: { value: -100 },
      uColA: { value: colA }, uColB: { value: colB },
    },
    vertexShader: TICK_VERT, fragmentShader: TICK_FRAG, side: THREE.DoubleSide,
  });
}
