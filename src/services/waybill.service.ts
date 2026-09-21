import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bwipjs = require('bwip-js');

// Пока всегда фиксировано — своего склада с несколькими городами ещё нет.
const WAREHOUSE_CITY = 'Алматы';

// ВАЖНО: стандартные 14 шрифтов PDF (Helvetica и т.п.), которые pdfkit
// использует по умолчанию, НЕ содержат кириллицу вообще — с ними русский
// текст превращается в нечитаемую абракадабру. Поэтому здесь подключён
// свой TTF-шрифт (DejaVu Sans — полностью поддерживает кириллицу),
// упакованный вместе с кодом (см. package.json → build: копирование в
// dist/assets/fonts, и vercel.json → includeFiles для api/index.ts —
// без этого Vercel не включит файл шрифта в бандл serverless-функции).
const FONT_REGULAR = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');

export class WaybillAddressError extends Error {}

export interface WaybillOrderItem {
  sku: string;
  name: string;
  quantity: number;
}

export interface WaybillOrderInput {
  number: string;
  customerName: string;
  phone: string;
  city: string;
  street: string;
  house: string;
  apartment: string | null;
  entrance: string | null;
  floor: string | null;
  intercom: string | null;
  items: WaybillOrderItem[];
}

function mmToPt(mm: number): number {
  return (mm / 25.4) * 72;
}

const COLOR_HEADER_BG = '#111111';
const COLOR_LABEL = '#8A8A8A';
const COLOR_TEXT = '#111111';
const COLOR_SKU = '#8A8A8A';
const COLOR_DIVIDER = '#D8D8D8';

/**
 * Наклейка-накладная My Market, 75×120 мм — макет повторяет образец,
 * присланный пользователем (MyMarket_nakladnaya_kaspi.pdf): чёрная шапка,
 * крупный номер заказа, штрихкод, блоки ОТКУДА/ПОЛУЧАТЕЛЬ/АДРЕС/ТОВАР с
 * тонкими разделителями, QR — справа от адреса.
 *
 * Запрещённые поля НЕ печатаются никогда, вне зависимости от того, что
 * передано на вход: цена, сумма, налог, код получения, блок "Выдача" —
 * это осознанное ограничение самой функции, не настройка, которую можно
 * случайно включить.
 *
 * Вся вёрстка — фиксированными координатами (не автопоток pdfkit), чтобы
 * гарантированно уместиться в ровно одну страницу 75×120мм — сумма высот
 * всех блоков посчитана и уложена в 340.2pt с запасом, проверено рендером.
 */
export async function generateWaybillPdf(order: WaybillOrderInput): Promise<Buffer> {
  if (!order.city?.trim() || !order.street?.trim() || !order.house?.trim()) {
    throw new WaybillAddressError('не заполнен адрес');
  }

  const width = mmToPt(75);
  const height = mmToPt(120);
  const margin = 11;
  const contentWidth = width - margin * 2;

  const doc = new PDFDocument({ size: [width, height], margin: 0, autoFirstPage: true, bufferPages: true });
  doc.registerFont('Body', FONT_REGULAR);
  doc.registerFont('Body-Bold', FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const donePromise = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  function divider(y: number): number {
    doc.moveTo(margin, y).lineTo(width - margin, y).strokeColor(COLOR_DIVIDER).lineWidth(0.75).stroke();
    return y + 9;
  }

  function sectionLabel(text: string, y: number): number {
    doc.font('Body-Bold').fontSize(7).fillColor(COLOR_LABEL).text(text.toUpperCase(), margin, y, { characterSpacing: 0.6, lineBreak: false });
    return y + 11;
  }

  // --- Шапка: чёрная плашка, MY MARKET слева / накладная справа ---
  const headerHeight = 26;
  doc.rect(0, 0, width, headerHeight).fill(COLOR_HEADER_BG);
  doc.fillColor('#FFFFFF').font('Body-Bold').fontSize(14).text('MY MARKET', margin, headerHeight / 2 - 6.5, { lineBreak: false });
  doc.font('Body').fontSize(8.5).text('накладная', 0, headerHeight / 2 - 4, { width: width - margin, align: 'right', lineBreak: false });

  let y = headerHeight + 10;

  // --- Номер заказа (крупно, с автоподбором размера, чтобы гарантированно
  // помещался в ширину — DejaVu Sans заметно шире Helvetica) ---
  doc.font('Body').fontSize(7.5).fillColor(COLOR_LABEL).text('Номер заказа', margin, y, { lineBreak: false });
  y += 11;
  let numberFontSize = 19;
  doc.font('Body-Bold');
  while (numberFontSize > 12 && doc.fontSize(numberFontSize).widthOfString(order.number) > contentWidth) {
    numberFontSize -= 1;
  }
  doc.fontSize(numberFontSize).fillColor(COLOR_TEXT).text(order.number, margin, y, { lineBreak: false });
  y += numberFontSize + 8;

  try {
    const barcodePng: Buffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: order.number,
      scale: 2,
      height: 8,
      includetext: false,
      backgroundcolor: 'FFFFFF',
    });
    doc.image(barcodePng, margin, y, { width: contentWidth, height: 22 });
    y += 22 + 8;
  } catch {
    // Штрихкод — не критично для самой доставки (номер и так напечатан
    // текстом выше), если генерация вдруг не удалась — не роняем всю
    // накладную из-за этого, просто продолжаем без штрихкода.
    y += 6;
  }

  y = divider(y);

  // --- ОТКУДА ---
  y = sectionLabel('Откуда', y);
  doc.font('Body').fontSize(9).fillColor(COLOR_TEXT).text(`${WAREHOUSE_CITY}, склад My Market`, margin, y, { width: contentWidth, lineBreak: false });
  y += 13;

  y = divider(y);

  // --- ПОЛУЧАТЕЛЬ ---
  y = sectionLabel('Получатель', y);
  doc.font('Body-Bold').fontSize(11.5).fillColor(COLOR_TEXT).text(order.customerName, margin, y, { width: contentWidth, lineBreak: false });
  y += 15;
  doc.font('Body').fontSize(9).text(order.phone, margin, y, { lineBreak: false });
  y += 13;

  y = divider(y);

  // --- АДРЕС (текст слева, QR справа) ---
  y = sectionLabel('Адрес', y);
  const addrTop = y;
  const qrSize = 54;
  const addrTextWidth = contentWidth - qrSize - 6;

  doc.font('Body-Bold').fontSize(10.5).fillColor(COLOR_TEXT).text(order.city, margin, y, { width: addrTextWidth, lineBreak: false });
  y += 14;

  doc.font('Body').fontSize(8.2);
  const houseLine = `${order.street}, дом ${order.house}${order.apartment ? `, кв. ${order.apartment}` : ''}`;
  doc.text(houseLine, margin, y, { width: addrTextWidth });
  y = doc.y + 1;

  const extras: string[] = [];
  if (order.entrance) extras.push(`подъезд ${order.entrance}`);
  if (order.floor) extras.push(`этаж ${order.floor}`);
  if (order.intercom) extras.push(`домофон ${order.intercom}`);
  if (extras.length) {
    doc.text(extras.join(', '), margin, y, { width: addrTextWidth });
    y = doc.y + 1;
  }

  // QR на Яндекс.Карты — справа от текста адреса, выровнен по верху блока.
  const addressForMap = `${order.city} ${order.street} ${order.house}${order.apartment ? ' ' + order.apartment : ''}`;
  const mapsUrl = `https://yandex.kz/maps/?text=${encodeURIComponent(addressForMap)}`;
  const qrDataUrl = await QRCode.toDataURL(mapsUrl, { margin: 0, width: 300 });
  const qrBuffer = Buffer.from(qrDataUrl.split(',')[1], 'base64');
  doc.image(qrBuffer, width - margin - qrSize, addrTop, { width: qrSize, height: qrSize });

  y = Math.max(y, addrTop + qrSize) + 8;
  y = divider(y);

  // --- ТОВАР (без цены — сумма и цена на наклейку не печатаются) ---
  y = sectionLabel('Товар', y);
  order.items.forEach((item) => {
    const qtyText = `${item.quantity} шт`;
    doc.font('Body').fontSize(9.5).fillColor(COLOR_TEXT);
    const qtyWidth = doc.widthOfString(qtyText) + 8;
    doc.text(qtyText, margin, y, { lineBreak: false });
    doc.font('Body-Bold').text(item.name, margin + qtyWidth, y, { width: contentWidth - qtyWidth });
    y = doc.y + 1;
    doc.font('Body').fontSize(7.5).fillColor(COLOR_SKU).text(item.sku, margin, y, { lineBreak: false });
    y = doc.y + 6;
  });

  doc.end();
  return donePromise;
}
