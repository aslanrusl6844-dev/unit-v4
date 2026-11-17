/** Строки/столбцы листа-сетки, нарезанного на слайды. */
export type Grid = {
    rows: number;
    cols: number;
};
type Run = {
    start: number;
    end: number;
};
/** Ищет сетку по пустым промежуткам между слайдами. null — не уверены. */
export declare function detectGrid(vc: number[], vr: number[], w: number, h: number): Grid | null;
/** Границы ячеек по одной оси: ищем пустые промежутки у ожидаемых позиций, иначе режем поровну. */
export declare function cutRanges(variance: number[], size: number, parts: number): Run[];
export type SplitResult = {
    grid: Grid;
    auto: boolean;
    slices: Buffer[];
};
/**
 * Квадрат 1:1 для маркетплейса БЕЗ потери качества: слайд остаётся в исходных пикселях (ничего не растягиваем и не обрезаем),
 * недостающие поля заливаются ровным цветом краёв слайда (сверху — цвет верхнего края, снизу — нижнего).
 */
export declare function toSquare(slice: Buffer): Promise<Buffer>;
/** Режет лист с несколькими слайдами на отдельные картинки (по строкам слева направо, сверху вниз). */
export declare function splitSheet(input: Buffer, grid?: Grid, square?: boolean): Promise<SplitResult>;
/** «2x5», «2×5», «2 на 5» → { rows: 2, cols: 5 }. */
export declare function parseGrid(text: string): Grid | null;
/** Быстрая проверка: похоже ли фото на лист из нескольких слайдов (по пустым промежуткам). */
export declare function peekGrid(input: Buffer): Promise<Grid | null>;
export {};
