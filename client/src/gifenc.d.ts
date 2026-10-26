declare module 'gifenc' {
  type Format = 'rgb565' | 'rgb444' | 'rgba4444';
  type Palette = number[][];
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: Format; oneBitAlpha?: boolean | number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Format): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: {
      palette?: Palette; delay?: number; transparent?: boolean; transparentIndex?: number; dispose?: number; repeat?: number;
    }): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
  };
}
