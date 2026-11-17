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

async function textImage(markup: string, opts: { bold?: boolean; size: number; width?: number; color?: string; align?: 'left' | 'centre' }): Promise<Buffer> {
  return sharp({
    text: {
      text: `<span foreground="${opts.color ?? '#111111'}">${markup}</span>`,
      fontfile: opts.bold ? FONT_BOLD : FONT,
      font: `${opts.bold ? 'DejaVu Sans Bold' : 'DejaVu Sans'} ${opts.size}`,
      width: opts.width,
      wrap: 'word',
      align: opts.align ?? 'left',
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

/**
 * Карточка товара «столбиком»: широкая картинка 3:1 — слева фото товара (≈1/3 ширины сообщения),
 * справа крупно «N шт». Telegram показывает её узкой полосой, поэтому фото выходят маленькими.
 */
export async function buildQtyCard(image: Buffer | null, qty: number, nameIfNoPhoto = '', stickers: string[] = []): Promise<Buffer> {
  const H = 300;
  const W = 900;
  const layers: { input: Buffer; top: number; left: number }[] = [];
  let hasPhoto = false;
  if (image) {
    try {
      layers.push({ input: await sharp(image, { failOn: 'none' }).rotate().resize(H, H, { fit: 'contain', background: '#ffffff' }).png().toBuffer(), top: 0, left: 0 });
      hasPhoto = true;
    } catch { /* битое фото */ }
  }
  if (!hasPhoto) {
    // Без фото — вместо картинки короткое название, чтобы было понятно, что это за товар.
    const label = nameIfNoPhoto ? escMarkup(nameIfNoPhoto.slice(0, 80)) : 'нет фото';
    let ph = await textImage(label, { size: nameIfNoPhoto ? 24 : 30, color: nameIfNoPhoto ? '#333333' : '#999999', width: H - 30 });
    const m0 = await sharp(ph).metadata();
    if ((m0.height ?? 0) > H - 20) ph = await sharp(ph).extract({ left: 0, top: 0, width: m0.width ?? H - 30, height: H - 20 }).png().toBuffer();
    const m = await sharp(ph).metadata();
    layers.push({ input: ph, top: Math.round(H / 2 - (m.height ?? 30) / 2), left: Math.round(H / 2 - (m.width ?? 120) / 2) });
  }
  // Справа: крупно «N шт», под ним — 4 цифры со стикеров Ozon (как внизу этикетки), через « · ».
  const codes = stickers.filter(Boolean);
  const qtyImg = await textImage(`${qty} шт`, { bold: true, size: codes.length ? 110 : 130, color: '#E53935' });
  const qm = await sharp(qtyImg).metadata();
  const qh = qm.height ?? 120;
  let codesImg: Buffer | null = null;
  let ch = 0;
  if (codes.length) {
    const size = codes.length <= 3 ? 52 : codes.length <= 6 ? 40 : 30;
    codesImg = await textImage(codes.join('   '), { bold: true, size, color: '#111111', width: W - H - 40, align: 'centre' });
    const cm = await sharp(codesImg).metadata();
    if ((cm.height ?? 0) > H - qh - 40) codesImg = await sharp(codesImg).extract({ left: 0, top: 0, width: cm.width ?? W - H - 40, height: H - qh - 40 }).png().toBuffer();
    ch = (await sharp(codesImg).metadata()).height ?? 0;
  }
  const top0 = Math.round((H - qh - (codesImg ? ch + 18 : 0)) / 2);
  layers.push({ input: qtyImg, top: top0, left: H + Math.round((W - H - (qm.width ?? 300)) / 2) });
  if (codesImg) {
    const cw = (await sharp(codesImg).metadata()).width ?? 300;
    layers.push({ input: codesImg, top: top0 + qh + 18, left: H + Math.round((W - H - cw) / 2) });
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite([...(hasPhoto ? [] : [{ input: await sharp({ create: { width: H, height: H, channels: 3, background: '#eeeeee' } }).png().toBuffer(), top: 0, left: 0 }]), ...layers])
    .jpeg({ quality: 85 }).toBuffer();
}
