// Headless stand-in for troika Text: a mesh with the same fields whose sync()
// estimates the text block bounds. Used by Node tests (and anything else that
// runs the runtime without WebGL). Never renders glyphs.

import * as THREE from 'three';
import type { TextFactory, TextLike } from './UiKit.ts';

class StubText extends THREE.Mesh {
  text = '';
  font: string | null = null;
  fontSize = 0.03;
  color: string | number | THREE.Color | null = null;
  maxWidth = Infinity;
  anchorX: number | string = 'center';
  anchorY: number | string = 'middle';
  lineHeight: number | 'normal' = 'normal';
  textAlign: 'left' | 'right' | 'center' | 'justify' = 'left';
  whiteSpace: 'normal' | 'nowrap' = 'normal';
  overflowWrap: 'normal' | 'break-word' = 'normal';
  clipRect: [number, number, number, number] | null = null;
  fillOpacity = 1;
  depthOffset = 0;
  outlineWidth: number | string = 0;
  outlineColor: string | number | THREE.Color = 0;
  outlineOpacity = 1;
  syncCount = 0;
  private info: { blockBounds: [number, number, number, number] } | null = null;

  get textRenderInfo() {
    return this.info;
  }

  sync(cb?: () => void): void {
    this.syncCount++;
    const { width, height } = estimateTextBlock(this.text, this.fontSize, this.maxWidth, this.lineHeight);
    const x0 = this.anchorX === 'left' ? 0 : this.anchorX === 'right' ? -width : -width / 2;
    const y1 = this.anchorY === 'top' ? 0 : this.anchorY === 'bottom' ? height : height / 2;
    this.info = { blockBounds: [x0, y1 - height, x0 + width, y1] };
    this.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y1 - height, 0), new THREE.Vector3(x0 + width, y1, 0));
    cb?.();
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** Rough text block size: 0.55em average advance, wrapped at maxWidth. */
export function estimateTextBlock(text: string, fontSize: number, maxWidth: number, lineHeight: number | 'normal' = 'normal') {
  const lh = (typeof lineHeight === 'number' ? lineHeight : 1.2) * fontSize;
  const adv = 0.55 * fontSize;
  const perLine = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.max(1, Math.floor(maxWidth / adv)) : Infinity;
  let lines = 0;
  let widest = 0;
  for (const para of (text || '').split('\n')) {
    const n = para.length;
    const l = perLine === Infinity ? 1 : Math.max(1, Math.ceil(n / perLine));
    lines += l;
    widest = Math.max(widest, Math.min(n, perLine === Infinity ? n : perLine) * adv);
  }
  return { width: widest, height: Math.max(1, lines) * lh };
}

export const stubTextFactory: TextFactory = () => new StubText() as unknown as TextLike;
