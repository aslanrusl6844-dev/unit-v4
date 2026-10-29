import sharp from 'sharp';

/** Строки/столбцы листа-сетки, нарезанного на слайды. */
export type Grid = { rows: number; cols: number };

const LOW_VAR = 30; // дисперсия яркости вдоль линии, ниже которой линия считается «пустой» (фон/промежуток)

type Run = { start: number; end: number };

function lowRuns(variance: number[], minLen: number): Run[] {
  const runs: Run[] = [];
  let s = -1;
  for (let i = 0; i <= variance.length; i++) {
    const low = i < variance.length && variance[i] < LOW_VAR;
    if (low && s < 0) s = i;
    if (!low && s >= 0) {
      if (i - s >= minLen) runs.push({ start: s, end: i });
      s = -1;
    }
  }
  return runs;
}

function lineVariance(data: Uint8Array, w: number, h: number, axis: 'col' | 'row'): number[] {
  const n = axis === 'col' ? w : h;
  const m = axis === 'col' ? h : w;
  const out: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0, sum2 = 0;
    for (let j = 0; j < m; j++) {
      const v = axis === 'col' ? data[j * w + i] : data[i * w + j];
      sum += v; sum2 += v * v;
    }
    const mean = sum / m;
    out[i] = sum2 / m - mean * mean;
  }
  return out;
}

/** Ищет сетку по пустым промежуткам между слайдами. null — не уверены. */
export function detectGrid(vc: number[], vr: number[], w: number, h: number): Grid | null {
  const inner = (runs: Run[], size: number) => runs.filter((r) => r.start > size * 0.05 && r.end < size * 0.95);
  const cols = inner(lowRuns(vc, 2), w).length + 1;
  const rows = inner(lowRuns(vr, 2), h).length + 1;
  if (cols * rows < 2 || cols * rows > 12 || cols > 6 || rows > 12) return null;
  return { rows, cols };
}

/** Границы ячеек по одной оси: ищем пустые промежутки у ожидаемых позиций, иначе режем поровну. */
export function cutRanges(variance: number[], size: number, parts: number): Run[] {
  const cell = size / parts;
  const runs = lowRuns(variance, 2);
  const ranges: Run[] = [];
  let from = 0;
  const lead = runs.find((r) => r.start === 0 && r.end < cell * 0.3);
  if (lead) from = lead.end;
  for (let k = 1; k <= parts; k++) {
    let to: number;
    if (k === parts) {
      const tail = runs.find((r) => r.end === size && r.start > size - cell * 0.3);
      to = tail ? tail.start : size;
    } else {
      const expected = k * cell;
      const gap = runs
        .filter((r) => (r.start + r.end) / 2 > expected - cell * 0.25 && (r.start + r.end) / 2 < expected + cell * 0.25)
        .sort((a, b) => Math.abs((a.start + a.end) / 2 - expected) - Math.abs((b.start + b.end) / 2 - expected))[0];
      to = gap ? gap.start : Math.round(expected);
      ranges.push({ start: from, end: Math.max(from + 1, to) });
      from = gap ? gap.end : Math.round(expected);
      continue;
    }
    ranges.push({ start: from, end: Math.max(from + 1, to) });
  }
  return ranges;
}

export type SplitResult = { grid: Grid; auto: boolean; slices: Buffer[] };

/** Средний цвет полосы пикселей у края картинки. */
async function edgeColor(img: Buffer, edge: 'top' | 'bottom' | 'left' | 'right', w: number, h: number) {
  const t = Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const region = edge === 'top' ? { left: 0, top: 0, width: w, height: t }
    : edge === 'bottom' ? { left: 0, top: h - t, width: w, height: t }
    : edge === 'left' ? { left: 0, top: 0, width: t, height: h }
    : { left: w - t, top: 0, width: t, height: h };
  const st = await sharp(img).extract(region).resize(1, 1, { fit: 'fill' }).raw().toBuffer();
  return { r: st[0], g: st[1], b: st[2] };
}

/**
 * Квадрат 1:1 для маркетплейса БЕЗ потери качества: слайд остаётся в исходных пикселях (ничего не растягиваем и не обрезаем),
 * недостающие поля заливаются ровным цветом краёв слайда (сверху — цвет верхнего края, снизу — нижнего).
 */
export async function toSquare(slice: Buffer): Promise<Buffer> {
  const meta = await sharp(slice).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const size = Math.max(w, h);
  const q = { quality: 95, chromaSubsampling: '4:4:4' } as const;
  if (w === h) return sharp(slice).jpeg(q).toBuffer();
  const wide = w > h;
  const a = await edgeColor(slice, wide ? 'top' : 'left', w, h);
  const b = await edgeColor(slice, wide ? 'bottom' : 'right', w, h);
  const pad = size - (wide ? h : w);
  const first = Math.floor(pad / 2);
  const second = pad - first;
  return sharp(slice)
    .extend(wide ? { top: first, bottom: second, left: 0, right: 0, background: a } : { top: 0, bottom: 0, left: first, right: second, background: a })
    .composite([{
      input: { create: { width: wide ? w : second, height: wide ? second : h, channels: 3, background: b } },
      left: wide ? 0 : first + w,
      top: wide ? first + h : 0,
    }])
    .jpeg(q)
    .toBuffer();
}

/** Режет лист с несколькими слайдами на отдельные картинки (по строкам слева направо, сверху вниз). */
export async function splitSheet(input: Buffer, grid?: Grid, square = true): Promise<SplitResult> {
  const img = sharp(input, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < 50 || h < 50) throw new Error('картинка слишком маленькая');
  // Для анализа уменьшаем: быстрее и устойчивее к шуму.
  const scale = Math.min(1, 1200 / Math.max(w, h));
  const aw = Math.max(1, Math.round(w * scale));
  const ah = Math.max(1, Math.round(h * scale));
  const gray = await img.clone().resize(aw, ah).greyscale().raw().toBuffer();
  const vc = lineVariance(gray, aw, ah, 'col');
  const vr = lineVariance(gray, aw, ah, 'row');
  const auto = !grid;
  const g = grid ?? detectGrid(vc, vr, aw, ah);
  if (!g) throw new Error('не смог определить сетку — напишите её, например 2x5 (строк × столбцов)');
  const xs = cutRanges(vc, aw, g.cols);
  const ys = cutRanges(vr, ah, g.rows);
  const png = await img.clone().png().toBuffer();
  const slices: Buffer[] = [];
  for (const y of ys) {
    for (const x of xs) {
      const left = Math.max(0, Math.round(x.start / scale));
      const top = Math.max(0, Math.round(y.start / scale));
      const width = Math.min(w - left, Math.max(1, Math.round((x.end - x.start) / scale)));
      const height = Math.min(h - top, Math.max(1, Math.round((y.end - y.start) / scale)));
      const piece = await sharp(png).extract({ left, top, width, height }).png().toBuffer();
      slices.push(square ? await toSquare(piece) : await sharp(piece).jpeg({ quality: 92 }).toBuffer());
    }
  }
  return { grid: g, auto, slices };
}

/** «2x5», «2×5», «2 на 5» → { rows: 2, cols: 5 }. */
export function parseGrid(text: string): Grid | null {
  const m = /^\s*(\d{1,2})\s*(?:x|х|×|\*|на)\s*(\d{1,2})\s*$/i.exec(text);
  if (!m) return null;
  const rows = Number(m[1]), cols = Number(m[2]);
  if (rows < 1 || cols < 1 || rows * cols < 2 || rows * cols > 12) return null;
  return { rows, cols };
}
