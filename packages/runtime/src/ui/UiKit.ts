// UiKit: the widget-facing helpers for text, panels, materials and color ramps.
//
// - Text is troika-three-text (SDF). Texts created here are synced by the host
//   once per frame in a batch (`flush()`), so widgets just call `.set(str)`.
// - Panels share cached rounded-rect geometry; materials are cached by
//   (color, opacity, side). Both are tagged as shared: widgets MUST clone a
//   material before mutating it (`mat.clone()`), or every user of that color
//   changes.
// - The text implementation is injectable (`textFactory`) so the runtime runs
//   headless in Node tests, where troika's worker/WebGL path is unavailable.

import * as THREE from 'three';
import type { TextOptions, Theme, UiKit } from '@evolspace/protocol';
import { SYSTEM_STYLE } from '../theme.ts';
import { fontUrl, type FontKey } from './fonts.ts';
import { markShared, roundedRectGeometry, roundedRectOutline } from './geometry.ts';
import { glyphSetOfFont, sanitizeText } from './glyphs.ts';

/** The troika Text surface the runtime relies on (structural, so a stub can stand in). */
export interface TextLike extends THREE.Mesh {
  text: string;
  font: string | null;
  fontSize: number;
  color: string | number | THREE.Color | null;
  maxWidth: number;
  anchorX: number | string;
  anchorY: number | string;
  lineHeight: number | 'normal';
  textAlign: 'left' | 'right' | 'center' | 'justify';
  whiteSpace: 'normal' | 'nowrap';
  overflowWrap: 'normal' | 'break-word';
  clipRect: [number, number, number, number] | null;
  fillOpacity: number;
  depthOffset: number;
  outlineWidth: number | string;
  outlineColor: string | number | THREE.Color;
  outlineOpacity: number;
  readonly textRenderInfo: { blockBounds: [number, number, number, number] } | null;
  sync(callback?: () => void): void;
  dispose(): void;
}

export type TextFactory = () => TextLike;

export type RuntimeText = TextLike & { set(text: string): void };

/** Extra text options available to runtime/system code (superset of the widget TextOptions). */
export interface TextOptionsEx extends TextOptions {
  weight?: 'regular' | 'semibold';
  lineHeight?: number;
  textAlign?: 'left' | 'right' | 'center' | 'justify';
  whiteSpace?: 'normal' | 'nowrap';
  opacity?: number;
  /** Outline for legibility over busy passthrough backgrounds. */
  outline?: { width: number; color?: string; opacity?: number };
}

export interface PanelOptions {
  color?: string;
  radius?: number;
  opacity?: number;
  /** Border color, or false for none. Default theme.border. */
  border?: string | false;
}

export type Ramp = 'sequential' | 'diverging' | 'palette';

export interface UiKitOptions {
  textFactory?: TextFactory;
  fontBase?: string;
}

export class RuntimeUiKit implements UiKit {
  private materials = new Map<string, THREE.Material>();
  private dirty = new Set<RuntimeText>();
  private rampCache = new Map<string, THREE.Color>();
  private readonly makeText: TextFactory;
  private readonly fontBase: string | undefined;

  constructor(readonly theme: Theme, opts: UiKitOptions = {}) {
    if (!opts.textFactory) throw new Error('RuntimeUiKit: textFactory is required (use createUiKit())');
    this.makeText = opts.textFactory;
    this.fontBase = opts.fontBase;
  }

  // ------------------------------------------------------------------ text

  text(content: string, opts?: TextOptions): RuntimeText {
    return this.textEx(content, opts);
  }

  textEx(content: string, o: TextOptionsEx = {}): RuntimeText {
    const t = this.makeText() as RuntimeText;
    const key: FontKey = o.font === 'mono' ? 'mono' : o.weight === 'semibold' ? 'sansSemiBold' : 'sans';
    t.font = fontUrl(key, this.fontBase);
    installTextSanitizer(t);
    t.text = content == null ? '' : String(content);
    t.fontSize = o.size ?? 0.03;
    t.color = o.color ?? this.theme.text;
    if (o.maxWidth !== undefined) {
      t.maxWidth = o.maxWidth;
      t.overflowWrap = 'break-word';
    }
    t.anchorX = o.anchorX ?? 'center';
    t.anchorY = o.anchorY ?? 'middle';
    if (o.lineHeight !== undefined) t.lineHeight = o.lineHeight;
    if (o.textAlign) t.textAlign = o.textAlign;
    if (o.whiteSpace) t.whiteSpace = o.whiteSpace;
    if (o.opacity !== undefined) t.fillOpacity = o.opacity;
    if (o.outline) {
      t.outlineWidth = o.outline.width;
      t.outlineColor = o.outline.color ?? this.theme.background;
      t.outlineOpacity = o.outline.opacity ?? 0.8;
    }
    const kit = this;
    // Compare against the last raw input (t.text holds the sanitized string),
    // and against t.text in case widget code assigned it directly meanwhile.
    let lastRaw: string | null = content == null ? '' : String(content);
    let lastClean = t.text;
    t.set = function set(this: RuntimeText, s: string) {
      const str = s == null ? '' : String(s);
      if (str === lastRaw && t.text === lastClean) return;
      lastRaw = str;
      t.text = str;
      lastClean = t.text;
      kit.dirty.add(t);
    };
    // A text disposed before the next flush must not be synced (that would
    // re-create its GPU resources).
    const dispose = t.dispose;
    t.dispose = function disposeText(this: RuntimeText) {
      kit.dirty.delete(t);
      dispose.call(t);
    };
    this.dirty.add(t);
    return t;
  }

  /** Queue a text for re-sync (after changing fontSize/color/maxWidth directly). */
  markDirty(t: RuntimeText): void {
    this.dirty.add(t);
  }

  /** Sync all texts changed since the last flush. Call once per frame. */
  flush(): void {
    if (!this.dirty.size) return;
    for (const t of this.dirty) {
      try {
        t.sync();
      } catch (err) {
        console.warn('text sync failed', err);
      }
    }
    this.dirty.clear();
  }

  // ------------------------------------------------------------------ panels & materials

  panel(width: number, height: number, opts: PanelOptions = {}): THREE.Mesh {
    const radius = opts.radius ?? SYSTEM_STYLE.panelRadius;
    const opacity = opts.opacity ?? SYSTEM_STYLE.panelOpacity;
    const mat = this.cachedMaterial(`panel|${opts.color ?? this.theme.background}|${opacity}`, () =>
      new THREE.MeshBasicMaterial({
        color: opts.color ?? this.theme.background,
        transparent: opacity < 1,
        opacity,
        // Panels write depth even when translucent so text/objects behind them
        // are hidden instead of bleeding through; renderOrder -1 draws them
        // before the text that sits on top.
        depthWrite: true,
        side: THREE.DoubleSide,
      }),
    );
    const mesh = new THREE.Mesh(roundedRectGeometry(width, height, radius), mat);
    mesh.renderOrder = -1;
    mesh.name = 'panel';
    if (opts.border !== false) {
      const border = new THREE.LineLoop(roundedRectOutline(width, height, radius), this.lineMaterial(opts.border ?? this.theme.border, 0.9));
      border.position.z = 0.0005;
      border.name = 'panel-border';
      border.raycast = noRaycast; // borders are decoration, never hit targets
      mesh.add(border);
    }
    return mesh;
  }

  material(color: string, opts: { opacity?: number; doubleSide?: boolean } = {}): THREE.Material {
    const opacity = opts.opacity ?? 1;
    const side = opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide;
    return this.cachedMaterial(`basic|${color}|${opacity}|${side}`, () =>
      new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side }),
    );
  }

  lineMaterial(color: string, opacity = 1): THREE.LineBasicMaterial {
    return this.cachedMaterial(`line|${color}|${opacity}`, () =>
      new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }),
    ) as THREE.LineBasicMaterial;
  }

  private cachedMaterial(key: string, make: () => THREE.Material): THREE.Material {
    let m = this.materials.get(key);
    if (!m) this.materials.set(key, (m = markShared(make())));
    return m;
  }

  // ------------------------------------------------------------------ color ramps

  /**
   * Map a value onto a theme ramp:
   * - 'sequential': t in [0, 1] (clamped), piecewise-linear across theme.sequential.
   * - 'diverging':  t in [-1, 1] (clamped): -1 → low, 0 → mid, +1 → high.
   * - 'palette':    integer t = category index (wraps); fractional t in [0,1) is scaled to the palette length.
   * Pass `target` to avoid allocating (per-frame use).
   */
  color(ramp: Ramp, t: number, target?: THREE.Color): THREE.Color {
    return rampColor(this.theme, ramp, t, target ?? new THREE.Color(), this.rampCache);
  }
}

const noRaycast = () => {};

/**
 * Route every assignment to `text.text` (by the kit or directly by widget code)
 * through sanitizeText(), so troika never sees a character our fonts lack.
 * Works for troika's prototype accessor and for plain data properties (stub).
 */
function installTextSanitizer(t: TextLike): void {
  let proto: object | null = t;
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'text'))) proto = Object.getPrototypeOf(proto);
  const clean = (v: unknown, font: string | null): string => {
    const str = v == null ? '' : String(v);
    const set = glyphSetOfFont(font);
    return set ? sanitizeText(str, set) : str;
  };
  if (desc && desc.get && desc.set) {
    const { get, set } = desc;
    Object.defineProperty(t, 'text', {
      configurable: true,
      enumerable: true,
      get() { return get.call(this); },
      set(v: unknown) { set.call(this, clean(v, (this as TextLike).font)); },
    });
  } else {
    let value = clean(t.text, t.font);
    Object.defineProperty(t, 'text', {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: (v: unknown) => { value = clean(v, t.font); },
    });
  }
}

export function rampColor(theme: Theme, ramp: Ramp, t: number, out: THREE.Color, cache?: Map<string, THREE.Color>): THREE.Color {
  const c = (hex: string): THREE.Color => {
    if (!cache) return new THREE.Color(hex);
    let v = cache.get(hex);
    if (!v) cache.set(hex, (v = new THREE.Color(hex)));
    return v;
  };
  if (!Number.isFinite(t)) t = 0;
  if (ramp === 'palette') {
    const p = theme.palette;
    const idx = Number.isInteger(t) ? t : Math.floor(Math.min(Math.max(t, 0), 0.999999) * p.length);
    return out.copy(c(p[((idx % p.length) + p.length) % p.length]));
  }
  if (ramp === 'diverging') {
    const [lo, mid, hi] = theme.diverging;
    const x = Math.min(1, Math.max(-1, t));
    return x < 0 ? out.lerpColors(c(mid), c(lo), -x) : out.lerpColors(c(mid), c(hi), x);
  }
  const s = theme.sequential;
  const x = Math.min(1, Math.max(0, t)) * (s.length - 1);
  const i = Math.min(s.length - 2, Math.floor(x));
  return out.lerpColors(c(s[i]), c(s[i + 1]), x - i);
}
