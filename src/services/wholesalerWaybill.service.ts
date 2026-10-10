import PDFDocument from 'pdfkit';
import path from 'path';

export type WholesalerWaybillMarketplace = 'KASPI' | 'OZON' | 'WB';

export interface WholesalerWaybillItem {
  sku: string;
  article: string | null;
  name: string;
  quantity: number;
}

export interface WholesalerWaybillInput {
  wholesalerName: string;
  marketplace: WholesalerWaybillMarketplace;
  orderNumber: string;
  orderDate: Date;
  city: string | null;
  items: WholesalerWaybillItem[];
}

const FONT_REGULAR = path.join(__dirname, '../assets/fonts/DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/DejaVuSans-Bold.ttf');

const MARKETPLACE_NAMES: Record<WholesalerWaybillMarketplace, string> = {
  KASPI: 'Kaspi',
  OZON: 'Ozon',
  WB: 'Wildberries',
};

/** Генерирует накладную оптовика по заказу. Цена и финансовые суммы не печатаются. */
export async function generateWholesalerWaybillPdf(input: WholesalerWaybillInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
  doc.registerFont('Body', FONT_REGULAR);
  doc.registerFont('Body-Bold', FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font('Body-Bold').fontSize(18).text('НАКЛАДНАЯ ОПТОВИКА');
  doc.moveDown(0.4);
  doc.font('Body').fontSize(10).fillColor('#555555')
    .text('My Market · документ для комплектации заказа');
  doc.moveDown(1.2);

  const line = () => {
    const y = doc.y + 4;
    doc.moveTo(42, y).lineTo(553, y).strokeColor('#D5D5D5').lineWidth(0.7).stroke();
    doc.y = y + 12;
  };

  doc.fillColor('#111111').font('Body-Bold').fontSize(11).text('Площадка');
  doc.font('Body').fontSize(11).text(MARKETPLACE_NAMES[input.marketplace]);
  doc.moveDown(0.5);
  doc.font('Body-Bold').text('Оптовик');
  doc.font('Body').text(input.wholesalerName);
  doc.moveDown(0.5);
  doc.font('Body-Bold').text('Заказ');
  doc.font('Body').text(input.orderNumber);
  doc.moveDown(0.5);
  doc.font('Body-Bold').text('Дата заказа');
  doc.font('Body').text(new Date(input.orderDate).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }));
  if (input.city) {
    doc.moveDown(0.5);
    doc.font('Body-Bold').text('Город');
    doc.font('Body').text(input.city);
  }
  line();

  doc.font('Body-Bold').fontSize(12).text('Товары');
  doc.moveDown(0.5);
  input.items.forEach((item, index) => {
    if (doc.y > 720) doc.addPage();
    doc.font('Body-Bold').fontSize(10).fillColor('#111111')
      .text(`${index + 1}. ${item.name}`, { continued: false });
    doc.font('Body').fontSize(9).fillColor('#555555')
      .text(`Количество: ${item.quantity} шт. · SKU: ${item.sku}`);
    if (item.article) doc.text(`Артикул площадки: ${item.article}`);
    doc.moveDown(0.6);
  });

  doc.moveDown(1);
  doc.font('Body').fontSize(9).fillColor('#777777')
    .text('Цена и суммы в этой накладной не указываются.');
  doc.end();
  return done;
}
