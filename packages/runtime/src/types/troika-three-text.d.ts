// Minimal typings for troika-three-text 0.52 (the package ships none).
// Only the surface the runtime uses is declared.

declare module 'troika-three-text' {
  import { Mesh, Color, Material } from 'three';

  export interface TextRenderInfo {
    /** [minX, minY, maxX, maxY] of the text block in local units. */
    blockBounds: [number, number, number, number];
    visibleBounds: [number, number, number, number];
    lineHeight?: number;
  }

  export class Text extends Mesh {
    text: string;
    font: string | null;
    fontSize: number;
    fontWeight: number | 'normal' | 'bold';
    color: string | number | Color | null;
    maxWidth: number;
    anchorX: number | 'left' | 'center' | 'right' | string;
    anchorY: number | 'top' | 'top-baseline' | 'top-cap' | 'top-ex' | 'middle' | 'bottom-baseline' | 'bottom' | string;
    lineHeight: number | 'normal';
    letterSpacing: number;
    textAlign: 'left' | 'right' | 'center' | 'justify';
    whiteSpace: 'normal' | 'nowrap';
    overflowWrap: 'normal' | 'break-word';
    clipRect: [number, number, number, number] | null;
    outlineWidth: number | string;
    outlineColor: string | number | Color;
    outlineOpacity: number;
    outlineBlur: number | string;
    fillOpacity: number;
    depthOffset: number;
    sdfGlyphSize: number | null;
    gpuAccelerateSDF: boolean;
    curveRadius: number;
    material: Material;
    readonly textRenderInfo: TextRenderInfo | null;
    sync(callback?: () => void): void;
    dispose(): void;
  }

  export function configureTextBuilder(config: {
    defaultFontURL?: string;
    sdfGlyphSize?: number;
    sdfExponent?: number;
    sdfMargin?: number;
    textureWidth?: number;
    useWorker?: boolean;
    unicodeFontsURL?: string | null;
  }): void;

  export function preloadFont(
    options: { font?: string; characters?: string | string[]; sdfGlyphSize?: number; lang?: string },
    callback: () => void,
  ): void;
}
