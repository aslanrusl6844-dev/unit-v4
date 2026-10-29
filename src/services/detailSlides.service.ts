import fs from 'fs';
import path from 'path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import type { ProductDetails } from './productAgent.service';

const W = 1080;
const H = 1440;
const INK = '#1f2a24';
const MUTED = '#6b756f';
const ACCENT = '#2f6b4f';
const SOFT = '#e8f0ea';
const BG = '#faf8f3';

type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({
  type,
  props: { style: { display: 'flex', ...style }, ...extra, ...(children !== undefined ? { children } : {}) },
});

let fontsCache: any[] | null = null;
function fonts() {
  if (fontsCache) return fontsCache;
  const dirs = [path.join(__dirname, '../assets/fonts'), path.join(process.cwd(), 'dist/assets/fonts'), path.join(process.cwd(), 'src/assets/fonts')];
  const dir = dirs.find((d) => fs.existsSync(path.join(d, 'manrope-cyrillic-400-normal.woff')));
  if (!dir) throw new Error('шрифты для слайдов не найдены');
  const list: any[] = [];
  for (const subset of ['cyrillic', 'latin']) {
    for (const weight of [400, 700, 800]) {
      list.push({ name: subset === 'latin' ? 'ManropeLat' : 'Manrope', weight, style: 'normal', data: fs.readFileSync(path.join(dir, `manrope-${subset}-${weight}-normal.woff`)) });
    }
  }
  return (fontsCache = list);
}

async function toPng(root: Node): Promise<Buffer> {
  const svg = await satori(root as any, { width: W, height: H, fonts: fonts() });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng());
}

const frame = (title: string, kicker: string, body: Node, name: string) =>
  h('div', { width: W, height: H, backgroundColor: BG, flexDirection: 'column', padding: 72, fontFamily: 'Manrope, ManropeLat', color: INK }, [
    h('div', { fontSize: 28, fontWeight: 700, color: ACCENT, letterSpacing: 2, textTransform: 'uppercase' }, kicker),
    h('div', { fontSize: 64, fontWeight: 800, lineHeight: 1.1, marginTop: 18 }, title),
    h('div', { width: 96, height: 8, backgroundColor: ACCENT, borderRadius: 4, marginTop: 28, marginBottom: 40 }, ''),
    h('div', { width: W - 144, flexDirection: 'column' }, [body]),
    h('div', { marginTop: 'auto', fontSize: 26, color: MUTED, justifyContent: 'space-between' }, [h('div', {}, name.slice(0, 48)), h('div', { fontWeight: 700, color: ACCENT }, 'My Market')]),
  ]);

const fit = (len: number, big: number, small: number, limit: number) => (len > limit ? small : big);

function coverSlide(d: ProductDetails, photoDataUri: string | null): Node {
  const feats = d.features.slice(0, 4);
  return h('div', { width: W, height: H, backgroundColor: BG, flexDirection: 'column', fontFamily: 'Manrope, ManropeLat', color: INK }, [
    h('div', { width: W, height: 760, backgroundColor: SOFT }, photoDataUri
      ? h('img', { width: W, height: 760, objectFit: 'contain' }, undefined, { src: photoDataUri, width: W, height: 760 })
      : ''),
    h('div', { flexDirection: 'column', padding: '48px 72px 0 72px', flexGrow: 1 }, [
      h('div', { fontSize: fit(d.name.length, 60, 46, 40), fontWeight: 800, lineHeight: 1.12 }, d.name),
      h('div', { flexDirection: 'column', marginTop: 32 }, feats.map((f) =>
        h('div', { alignItems: 'center', marginBottom: 16 }, [
          h('div', { width: 18, height: 18, borderRadius: 9, backgroundColor: ACCENT, marginRight: 20, flexShrink: 0 }, ''),
          h('div', { fontSize: 32, fontWeight: 600 as any, lineHeight: 1.25 }, f),
        ]))),
      h('div', { marginTop: 'auto', marginBottom: 40, fontSize: 26, fontWeight: 700, color: ACCENT }, 'My Market'),
    ]),
  ]);
}

function textSlide(title: string, kicker: string, text: string, name: string): Node {
  return frame(title, kicker, h('div', { fontSize: fit(text.length, 42, 34, 420), lineHeight: 1.5, flexDirection: 'column', width: W - 144 }, text), name);
}

function charsSlide(d: ProductDetails): Node {
  const rows = d.characteristics.slice(0, 10);
  return frame('Характеристики', 'О товаре',
    h('div', { flexDirection: 'column' }, rows.map((r, i) =>
      h('div', { padding: '30px 0', width: W - 144, borderBottom: i === rows.length - 1 ? '0' : '2px solid #e4e0d6', justifyContent: 'space-between', alignItems: 'flex-start' }, [
        h('div', { fontSize: 34, color: MUTED, width: 340, flexShrink: 0 }, r.name),
        h('div', { fontSize: 36, fontWeight: 700, textAlign: 'right', flexGrow: 1, flexShrink: 1, width: 560, justifyContent: 'flex-end' }, r.value),
      ]))), d.name);
}

function featuresSlide(d: ProductDetails): Node {
  return frame('Почему выбирают', 'Преимущества',
    h('div', { flexDirection: 'column' }, d.features.slice(0, 6).map((f, i) =>
      h('div', { alignItems: 'center', marginBottom: 30 }, [
        h('div', { width: 76, height: 76, borderRadius: 38, backgroundColor: ACCENT, color: '#fff', fontSize: 36, fontWeight: 800, alignItems: 'center', justifyContent: 'center', marginRight: 28, flexShrink: 0 }, String(i + 1)),
        h('div', { fontSize: 36, fontWeight: 700, lineHeight: 1.25, flexGrow: 1 }, f),
      ]))), d.name);
}

/** Слайды «Детали»: обложка с фото, состав, характеристики, преимущества, применение — только то, что есть в карточке. */
export async function renderDetailSlides(d: ProductDetails, firstPhoto: Buffer | null, photoMime = 'image/jpeg'): Promise<Buffer[]> {
  const uri = firstPhoto ? `data:${photoMime};base64,${firstPhoto.toString('base64')}` : null;
  const nodes: Node[] = [coverSlide(d, uri)];
  if (d.composition) nodes.push(textSlide('Состав', 'Что внутри', d.composition, d.name));
  if (d.characteristics.length) nodes.push(charsSlide(d));
  if (d.usage) nodes.push(textSlide('Применение', 'Как использовать', d.usage, d.name));
  if (d.features.length > 4) nodes.push(featuresSlide(d));
  const out: Buffer[] = [];
  for (const n of nodes.slice(0, 5)) out.push(await toPng(n));
  return out;
}
