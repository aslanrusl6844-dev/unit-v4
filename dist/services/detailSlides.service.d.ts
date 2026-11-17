import type { ProductDetails } from './productAgent.service';
export type SceneImage = {
    img: {
        data: Buffer;
        mime: string;
    };
    headline: string;
    caption: string;
};
/**
 * Слайды «Детали» в стиле rich content: сцены от нейросети (если есть), реальные ракурсы,
 * состав, характеристики, применение. Весь текст рисуем сами — нейросеть путает кириллицу.
 */
export declare function renderDetailSlides(d: ProductDetails, firstPhoto: Buffer | null, photoMime?: string, extra?: {
    scenes?: SceneImage[];
    otherPhotos?: Array<{
        data: Buffer;
        mime: string;
    }>;
}): Promise<Buffer[]>;
