import JSZip from 'jszip';
import { SHOP_CATEGORIES } from '../config/shopCategories';

function canonicalCategory(raw: string): string | null {
  const key = normalizeKey(raw);
  return SHOP_CATEGORIES.find((category) => normalizeKey(category) === key) ?? null;
}

export interface ImportError {
  file: string;
  message: string;
}

export interface CatalogImageItem {
  source: string;
  category: string;
  type: string;
  ext: string;
  contentType: string;
  buffer: Buffer;
}

export interface ParsedImageZip {
  items: CatalogImageItem[];
  errors: ImportError[];
  skippedJunk: number;
}

export interface CatalogTypePair {
  category: string;
  type: string;
}

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

export function normalizeKey(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/ё/gi, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ru-RU');
}

export function cleanName(value: string): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function capitalizeFirst(value: string): string {
  const clean = cleanName(value);
  if (!clean) return clean;
  return clean.charAt(0).toLocaleUpperCase('ru-RU') + clean.slice(1);
}

/**
 * ZIP layout: "Название раздела/Название типа.jpg".
 * Nested folders are tolerated; the first folder is the category and the
 * file basename (without extension) is the type. Non-image/system files are
 * ignored rather than causing the whole archive to fail.
 */
export async function parseImageZip(input: Buffer): Promise<ParsedImageZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input, { checkCRC32: true });
  } catch {
    throw new Error('Не удалось прочитать ZIP. Проверьте, что загружен корректный ZIP-архив.');
  }

  const items: CatalogImageItem[] = [];
  const errors: ImportError[] = [];
  let skippedJunk = 0;

  for (const [source, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const normalizedPath = source.replace(/\\/g, '/');
    const segments = normalizedPath.split('/').filter(Boolean);
    const basename = segments[segments.length - 1] ?? '';
    if (!basename || basename === '.DS_Store' || segments.some((s) => s === '__MACOSX' || s.startsWith('._'))) {
      skippedJunk += 1;
      continue;
    }

    const dot = basename.lastIndexOf('.');
    if (dot <= 0) {
      skippedJunk += 1;
      continue;
    }
    const ext = basename.slice(dot + 1).toLowerCase();
    const contentType = IMAGE_TYPES[ext];
    if (!contentType) {
      skippedJunk += 1;
      continue;
    }

    if (segments.length < 2) {
      errors.push({ file: source, message: 'Поместите картинку в папку с названием раздела каталога.' });
      continue;
    }

    const categoryRaw = cleanName(segments[0]);
    const category = canonicalCategory(categoryRaw);
    if (!category) {
      errors.push({ file: source, message: `Неизвестный раздел каталога: «${categoryRaw}».` });
      continue;
    }

    const type = cleanName(basename.slice(0, dot));
    if (!type) {
      errors.push({ file: source, message: 'Не удалось определить название типа по имени файла.' });
      continue;
    }
    if (type.length > 60) {
      errors.push({ file: source, message: 'Название типа длиннее 60 символов.' });
      continue;
    }

    try {
      const buffer = await entry.async('nodebuffer');
      if (!buffer.length) {
        errors.push({ file: source, message: 'Файл пустой.' });
        continue;
      }
      items.push({ source, category, type, ext, contentType, buffer });
    } catch {
      errors.push({ file: source, message: 'Не удалось прочитать файл из ZIP-архива.' });
    }
  }

  return { items, errors, skippedJunk };
}

/** Parses one "Категория | Тип" pair per line without guessing category names. */
export function parseBulkText(text: string): { pairs: CatalogTypePair[]; errors: ImportError[] } {
  const pairs: CatalogTypePair[] = [];
  const errors: ImportError[] = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('|');
    if (separator < 0 || line.indexOf('|', separator + 1) >= 0) {
      errors.push({ file: `Строка ${index + 1}`, message: 'Ожидается формат «Категория | Тип».' });
      continue;
    }

    const categoryRaw = cleanName(line.slice(0, separator));
    const category = normalizeShopCategory(categoryRaw);
    const type = cleanName(line.slice(separator + 1));

    if (!category) {
      errors.push({ file: `Строка ${index + 1}`, message: `Неизвестный раздел каталога: «${categoryRaw}».` });
      continue;
    }
    if (!type) {
      errors.push({ file: `Строка ${index + 1}`, message: 'Название типа не должно быть пустым.' });
      continue;
    }
    if (type.length > 60) {
      errors.push({ file: `Строка ${index + 1}`, message: 'Название типа длиннее 60 символов.' });
      continue;
    }

    const key = `${category}|${normalizeKey(type)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ category, type });
  }

  return { pairs, errors };
}
