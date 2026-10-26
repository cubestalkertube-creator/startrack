// Анимированные GIF: разбор на кадры (ImageDecoder из WebCodecs) и сборка обратно (gifenc).
// Нужно, чтобы гифку на аватарку или баннер можно было обрезать и уменьшить, не потеряв анимацию.
import { GIFEncoder, applyPalette, quantize } from 'gifenc';

export type Gif = {
  w: number; h: number;
  count: number; // сколько кадров попадёт в результат
  first: ImageBitmap; // первый кадр — для окна обрезки
  each(fn: (img: CanvasImageSource, delay: number) => Promise<void>): Promise<void>;
  close(): void;
};

// null — картинка не анимированная или браузер не умеет разбирать GIF по кадрам.
// Длинную гифку прореживаем до maxFrames кадров (задержки растягиваем — скорость та же).
export async function decodeGif(file: Blob, maxFrames = 150): Promise<Gif | null> {
  const D = (window as any).ImageDecoder;
  if (!D) return null;
  let dec: any;
  try {
    dec = new D({ data: await file.arrayBuffer(), type: 'image/gif' });
    await dec.tracks.ready;
    await dec.completed;
    const n: number = dec.tracks.selectedTrack.frameCount;
    if (n < 2) { dec.close(); return null; }
    const step = Math.ceil(n / maxFrames);
    const f0 = (await dec.decode({ frameIndex: 0 })).image;
    const w = f0.displayWidth, h = f0.displayHeight;
    const first = await createImageBitmap(f0);
    f0.close();
    return {
      w, h, first, count: Math.ceil(n / step),
      async each(fn) {
        for (let i = 0; i < n; i += step) {
          const img = (await dec.decode({ frameIndex: i })).image;
          // duration — в микросекундах; браузеры показывают задержку меньше 20 мс как 100 мс
          const delay = Math.max(20, Math.round(((img.duration ?? 100000) / 1000) * step));
          try { await fn(img, delay); } finally { img.close(); }
        }
      },
      close() { first.close(); dec.close(); },
    };
  } catch {
    dec?.close();
    return null;
  }
}

// Собирает GIF размером w×h: каждый кадр рисует paint (обрезка и масштаб), progress — доля 0..1
export async function encodeGif(gif: Gif, w: number, h: number, paint: (ctx: CanvasRenderingContext2D, img: CanvasImageSource) => void,
  progress: (p: number) => void): Promise<Blob> {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const enc = GIFEncoder();
  let done = 0;
  await gif.each(async (img, delay) => {
    ctx.clearRect(0, 0, w, h);
    paint(ctx, img);
    const { data } = ctx.getImageData(0, 0, w, h);
    let alpha = false;
    for (let k = 3; k < data.length; k += 4) if (data[k] < 128) { alpha = true; break; }
    // прозрачность GIF — однобитная; без неё цвета точнее
    const format = alpha ? 'rgba4444' : 'rgb565';
    const palette = quantize(data, 256, { format, oneBitAlpha: alpha });
    const index = applyPalette(data, palette, format);
    const ti = alpha ? palette.findIndex((p: number[]) => p[3] === 0) : -1;
    enc.writeFrame(index, w, h, { palette, delay, transparent: ti >= 0, transparentIndex: Math.max(ti, 0), dispose: alpha ? 2 : -1 });
    progress(++done / gif.count);
    await new Promise((r) => setTimeout(r)); // окно не должно замирать
  });
  enc.finish();
  return new Blob([enc.bytes()], { type: 'image/gif' });
}
