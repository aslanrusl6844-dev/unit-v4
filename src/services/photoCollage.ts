import path from 'path';
import sharp from 'sharp';

/**
 * Коллаж товаров для Telegram: сетка 3×N, на каждой плитке фото товара (≈1/3 ширины сообщения),
 * крупная плашка «N шт» и короткое название. Шрифт — свой файл (на сервере нет системных шрифтов).
 */
const FONT_BOLD = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');
const FONT = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');

const COLS = 3;
const TILE = 360;        // ширина плитки и высота фото
const NAME_H = 64;       // место под название
const GAP = 8;

export type CollageItem = { qty: number; name: string; image: Buffer | null; index: number };

const escMarkup = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function textImage(markup: string, opts: { bold?: boolean; size: number; width?: number; color?: string }): Promise<Buffer> {
  return sharp({
    text: {
      text: `<span foreground="${opts.color ?? '#111111'}">${markup}</span>`,
      fontfile: opts.bold ? FONT_BOLD : FONT,
      font: `${opts.bold ? 'DejaVu Sans Bold' : 'DejaVu Sans'} ${opts.size}`,
      width: opts.width,
      wrap: 'word',
      rgba: true,
      dpi: 72,
    },
  }).png().toBuffer();
}

async function tile(item: CollageItem): Promise<Buffer> {
  const layers: { input: Buffer; top: number; left: number }[] = [];
  // Фото — целиком, по центру квадрата, на белом.
  if (item.image) {
    try {
      const photo = await sharp(item.image, { failOn: 'none' }).rotate()
        .resize(TILE, TILE, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
      layers.push({ input: photo, top: 0, left: 0 });
    } catch { /* битое фото — останется серая плитка */ }
  }
  if (!layers.length) {
    const ph = await textImage('нет фото', { size: 22, color: '#999999' });
    const m = await sharp(ph).metadata();
    layers.push({ input: ph, top: Math.round(TILE / 2 - (m.height ?? 20) / 2), left: Math.round(TILE / 2 - (m.width ?? 80) / 2) });
  }
  // Плашка «N шт» — красная, крупно, в левом верхнем углу.
  const qty = await textImage(`${item.qty} шт`, { bold: true, size: 40, color: '#ffffff' });
  const qm = await sharp(qty).metadata();
  const bw = (qm.width ?? 100) + 28;
  const bh = (qm.height ?? 40) + 16;
  const badge = await sharp({ create: { width: bw, height: bh, channels: 4, background: '#E53935' } })
    .composite([{ input: qty, top: 8, left: 14 }]).png().toBuffer();
  layers.push({ input: badge, top: 10, left: 10 });
  // Номер позиции — справа сверху (совпадает с номером в подписи).
  const num = await textImage(String(item.index), { bold: true, size: 22, color: '#ffffff' });
  const nm = await sharp(num).metadata();
  const nb = await sharp({ create: { width: (nm.width ?? 20) + 18, height: (nm.height ?? 22) + 10, channels: 4, background: '#00000099' } })
    .composite([{ input: num, top: 5, left: 9 }]).png().toBuffer();
  layers.push({ input: nb, top: 10, left: TILE - ((nm.width ?? 20) + 18) - 10 });
  // Название — две строки под фото.
  const name = await textImage(escMarkup(item.name.slice(0, 70)), { size: 19, width: TILE - 16 });
  const cropped = await sharp(name).extract({ left: 0, top: 0, width: Math.min((await sharp(name).metadata()).width ?? TILE - 16, TILE - 16), height: Math.min((await sharp(name).metadata()).height ?? NAME_H, NAME_H - 10) }).png().toBuffer();
  layers.push({ input: cropped, top: TILE + 6, left: 8 });
  return sharp({ create: { width: TILE, height: TILE + NAME_H, channels: 3, background: item.image ? '#ffffff' : '#eeeeee' } })
    .composite(layers).jpeg({ quality: 85 }).toBuffer();
}

/** Один коллаж (до 9 товаров) → JPEG. */
export async function buildCollage(items: CollageItem[]): Promise<Buffer> {
  const tiles = await Promise.all(items.map(tile));
  const rows = Math.ceil(items.length / COLS);
  const cols = Math.min(COLS, items.length);
  const width = cols * TILE + (cols + 1) * GAP;
  const height = rows * (TILE + NAME_H) + (rows + 1) * GAP;
  return sharp({ create: { width, height, channels: 3, background: '#e9e9e9' } })
    .composite(tiles.map((t, i) => ({
      input: t,
      left: GAP + (i % COLS) * (TILE + GAP),
      top: GAP + Math.floor(i / COLS) * (TILE + NAME_H + GAP),
    })))
    .jpeg({ quality: 82 }).toBuffer();
}
