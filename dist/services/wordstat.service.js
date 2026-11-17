"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORDSTAT_REGIONS = void 0;
exports.mapWordstatTop = mapWordstatTop;
exports.getWordstatTop = getWordstatTop;
const axios_1 = __importDefault(require("axios"));
const prisma_1 = require("../db/prisma");
/**
 * Яндекс Wordstat через Yandex Search API (метод topRequests):
 * POST https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests
 * Авторизация — API-ключ сервисного аккаунта (Authorization: Api-key …),
 * folderId — каталог, где создан ключ.
 */
const WORDSTAT_URL = 'https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests';
/** Регионы Яндекса (geo id). Список можно расширять по справочнику регионов Яндекса. */
exports.WORDSTAT_REGIONS = {
    KZ: { id: '159', label: 'Казахстан' },
    'KZ-ALA': { id: '162', label: 'Алматы' },
    'KZ-AST': { id: '163', label: 'Астана' },
};
const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};
function mapList(list) {
    if (!Array.isArray(list))
        return [];
    return list
        .map((x) => ({ phrase: String(x?.phrase ?? x?.text ?? '').trim(), count: toNum(x?.count ?? x?.shows ?? x?.value) }))
        .filter((x) => x.phrase);
}
/**
 * Разбор ответа topRequests. Поля Яндекса: results (запросы со словом) и
 * associations (похожие запросы), count приходит строкой. Разбор терпимый:
 * незнакомый формат даёт пустые списки, а не падение.
 */
function mapWordstatTop(json, phrase, regionLabel) {
    const top = mapList(json?.results ?? json?.topRequests);
    const associations = mapList(json?.associations);
    const total = json?.totalCount != null ? toNum(json.totalCount) : null;
    return { phrase, regionLabel, total, top, associations };
}
async function getWordstatTop(phrase, geo, numPhrases = 100) {
    const region = exports.WORDSTAT_REGIONS[geo];
    if (!region)
        throw new Error('Неизвестный регион');
    const store = await prisma_1.prisma.yandexCloudStore.findFirst({ orderBy: { updatedAt: 'desc' } });
    if (!store)
        throw new Error('Yandex Cloud не подключён: добавь Folder ID и ключ в «Настройках».');
    try {
        const res = await axios_1.default.post(WORDSTAT_URL, { phrase, numPhrases, regions: [region.id], devices: ['DEVICE_ALL'], folderId: store.folderId }, { timeout: 20_000, headers: { Authorization: `Api-key ${store.apiKey}`, 'Content-Type': 'application/json' } });
        return mapWordstatTop(res.data, phrase, region.label);
    }
    catch (err) {
        const status = err?.response?.status;
        const raw = err?.response?.data;
        const body = raw == null ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw);
        const hint = status === 401 || status === 403
            ? ' Проверьте, что ключ создан в AI Studio, не отозван, а Folder ID — из того же облака, что и ключ, и привязан платёжный аккаунт.'
            : status === 429
                ? ' Яндекс временно ограничил число запросов — повторите чуть позже.'
                : '';
        throw new Error(`Wordstat (${status ?? 'нет ответа'}): ${String(err?.message ?? err)}${body ? ` — ${body.slice(0, 300)}` : ''}.${hint}`);
    }
}
//# sourceMappingURL=wordstat.service.js.map