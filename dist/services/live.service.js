"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.replayPrefix = exports.RECORDER_UID = exports.MAX_SKUS = exports.TOKEN_TTL_S = exports.LIVE_STALE_MS = exports.agoraConfigured = exports.AGORA_APP_ID = void 0;
exports.agoraToken = agoraToken;
exports.newChannel = newChannel;
exports.cleanSkus = cleanSkus;
exports.parseSkus = parseSkus;
exports.isOnAir = isOnAir;
exports.activeCreatorByPhone = activeCreatorByPhone;
exports.closeStaleStreams = closeStaleStreams;
exports.videoDto = videoDto;
exports.streamDto = streamDto;
exports.creatorNames = creatorNames;
exports.activeLiveCategories = activeLiveCategories;
exports.shopCategoryBySku = shopCategoryBySku;
exports.catsFor = catsFor;
exports.recordingConfigured = recordingConfigured;
exports.setRecordingFetch = setRecordingFetch;
exports.startRecording = startRecording;
exports.stopRecording = stopRecording;
exports.resolveReplays = resolveReplays;
exports.viewersOf = viewersOf;
exports.notifyFollowers = notifyFollowers;
exports.bannerDto = bannerDto;
/**
 * My Market Live: шортс креаторов и прямые эфиры (Agora).
 * Видео — в Cloudflare R2, эфир — Agora (токены выдаёт сервер), чат эфира — у нас в базе.
 */
const crypto_1 = require("crypto");
const agora_token_1 = require("agora-token");
const prisma_1 = require("../db/prisma");
const env_1 = require("../config/env");
const mediaStorage_service_1 = require("./mediaStorage.service");
const logger_1 = require("../utils/logger");
/** App ID проекта Agora не секрет (он и так есть в приложении); сертификат — только в переменных Vercel. */
exports.AGORA_APP_ID = process.env.AGORA_APP_ID?.trim() || 'eddfb3532542449897a94b234761dbc8';
const agoraConfigured = () => !!process.env.AGORA_APP_CERTIFICATE?.trim();
exports.agoraConfigured = agoraConfigured;
/** Эфир без отметки креатора дольше этого — считается завершённым (приложение закрыли, пропала сеть). */
exports.LIVE_STALE_MS = 90_000;
exports.TOKEN_TTL_S = 4 * 60 * 60;
exports.MAX_SKUS = 10;
function agoraToken(channel, role) {
    const cert = process.env.AGORA_APP_CERTIFICATE?.trim();
    if (!cert)
        throw new Error('AGORA_APP_CERTIFICATE не настроен');
    return agora_token_1.RtcTokenBuilder.buildTokenWithUid(exports.AGORA_APP_ID, cert, channel, 0, role === 'host' ? agora_token_1.RtcRole.PUBLISHER : agora_token_1.RtcRole.SUBSCRIBER, exports.TOKEN_TTL_S, exports.TOKEN_TTL_S);
}
function newChannel() {
    return `mm-${(0, crypto_1.randomBytes)(6).toString('hex')}`;
}
function cleanSkus(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = raw.map((s) => String(s ?? '').trim()).filter((s) => s && s.length <= 60);
    return Array.from(new Set(out)).slice(0, exports.MAX_SKUS);
}
function parseSkus(raw) {
    try {
        const v = JSON.parse(raw ?? '[]');
        return Array.isArray(v) ? v.map(String) : [];
    }
    catch {
        return [];
    }
}
/** Эфир действительно идёт: статус live и креатор недавно отмечался. */
function isOnAir(s, now = Date.now()) {
    if (s.status !== 'live')
        return false;
    const beat = s.lastBeatAt ?? s.startedAt;
    return !!beat && now - new Date(beat).getTime() < exports.LIVE_STALE_MS;
}
/** Активный креатор по телефону (или null). */
async function activeCreatorByPhone(phone) {
    const c = await prisma_1.prisma.creator.findUnique({ where: { phone } });
    return c && c.active ? c : null;
}
/** Закрывает «зависшие» эфиры (креатор пропал) — вызывается при чтении списков. Запись тоже останавливаем. */
async function closeStaleStreams(now = Date.now()) {
    const stale = await prisma_1.prisma.liveStream.findMany({ where: { status: 'live', lastBeatAt: { lt: new Date(now - exports.LIVE_STALE_MS) } }, take: 20 });
    for (const s of stale) {
        await prisma_1.prisma.liveStream.update({ where: { id: s.id }, data: { status: 'ended', endedAt: new Date(now) } });
        await stopRecording(s);
    }
}
function videoDto(v, creatorName, liked = false) {
    return {
        id: v.id, title: v.title, videoUrl: v.videoUrl, skus: parseSkus(v.skus), likes: v.likes, views: v.views,
        status: v.status, creatorName, liked, createdAt: v.createdAt,
    };
}
function streamDto(s, creatorName) {
    return {
        id: s.id, title: s.title, status: isOnAir(s) ? 'live' : s.status === 'live' ? 'ended' : s.status,
        skus: parseSkus(s.skus), scheduledAt: s.scheduledAt, startedAt: s.startedAt, endedAt: s.endedAt, creatorName,
        replayUrl: s.replayUrl ?? null, likes: s.likes ?? 0, views: s.views ?? 0, viewers: 0,
    };
}
/** Имена креаторов одним запросом. */
async function creatorNames(ids) {
    const uniq = Array.from(new Set(ids));
    if (!uniq.length)
        return new Map();
    const rows = await prisma_1.prisma.creator.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
}
async function activeLiveCategories() {
    const rows = await prisma_1.prisma.liveCategory.findMany({ where: { active: true }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
    return rows.map((r) => ({ id: r.id, title: r.title, categories: parseSkus(r.categories) }));
}
/** Раздел каталога для каждого артикула (артикул витрины или sku). */
async function shopCategoryBySku(skus) {
    const uniq = Array.from(new Set(skus.filter(Boolean)));
    if (!uniq.length)
        return new Map();
    const rows = await prisma_1.prisma.product.findMany({
        where: { OR: [{ shopArticle: { in: uniq } }, { sku: { in: uniq } }] },
        select: { sku: true, shopArticle: true, category: true },
    });
    const map = new Map();
    for (const r of rows) {
        if (!r.category)
            continue;
        if (r.shopArticle)
            map.set(r.shopArticle, r.category);
        map.set(r.sku, r.category);
    }
    return map;
}
/** id вкладок, в которые попадает набор товаров. */
function catsFor(skus, bySku, cats) {
    const shopCats = new Set(skus.map((s) => bySku.get(s)).filter((c) => !!c));
    return cats.filter((c) => c.categories.some((x) => shopCats.has(x))).map((c) => c.id);
}
// ---------------------------------------------------------------------------
// Повторы: облачная запись Agora (смешанная, вертикальная 720×1280) прямо в наш R2.
// Нужны AGORA_CUSTOMER_ID / AGORA_CUSTOMER_SECRET (RESTful API в консоли Agora),
// карта в Agora и включённый Cloud Recording. Без них эфиры работают, просто без записи.
// ---------------------------------------------------------------------------
exports.RECORDER_UID = '999';
function recordingConfigured() {
    return !!(process.env.AGORA_CUSTOMER_ID?.trim() && process.env.AGORA_CUSTOMER_SECRET?.trim() && (0, exports.agoraConfigured)() && (0, mediaStorage_service_1.isR2Configured)());
}
let fetchImpl = (...a) => fetch(...a);
/** Для тестов. */
function setRecordingFetch(f) { fetchImpl = f; }
async function agoraRest(path, body) {
    const auth = Buffer.from(`${process.env.AGORA_CUSTOMER_ID?.trim()}:${process.env.AGORA_CUSTOMER_SECRET?.trim()}`).toString('base64');
    const res = await fetchImpl(`https://api.agora.io/v1/apps/${exports.AGORA_APP_ID}/cloud_recording${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=utf-8', authorization: `Basic ${auth}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok)
        throw new Error(`Agora запись ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
}
/** Папка записи эфира в R2 (Agora разрешает только латиницу и цифры). */
const replayPrefix = (streamId) => ['live', streamId.replace(/[^a-zA-Z0-9]/g, '')];
exports.replayPrefix = replayPrefix;
/** Запустить запись эфира. Ошибка не мешает эфиру — просто не будет повтора. */
async function startRecording(stream) {
    if (!recordingConfigured())
        return;
    try {
        const acq = await agoraRest('/acquire', { cname: stream.channel, uid: exports.RECORDER_UID, clientRequest: { resourceExpiredHour: 24, scene: 0 } });
        const resourceId = acq.resourceId;
        const st = await agoraRest(`/resourceid/${resourceId}/mode/mix/start`, {
            cname: stream.channel,
            uid: exports.RECORDER_UID,
            clientRequest: {
                token: agoraToken(stream.channel, 'audience'),
                recordingConfig: {
                    channelType: 1, // эфир
                    streamTypes: 2, // звук и видео
                    maxIdleTime: 120, // ведущий пропал на 2 минуты — запись останавливается сама
                    transcodingConfig: { width: 720, height: 1280, fps: 24, bitrate: 1500, mixedVideoLayout: 1 },
                },
                recordingFileConfig: { avFileType: ['hls', 'mp4'] },
                storageConfig: {
                    vendor: 11, // S3-совместимое хранилище — Cloudflare R2
                    region: 0,
                    bucket: env_1.env.r2.bucket,
                    accessKey: env_1.env.r2.accessKeyId,
                    secretKey: env_1.env.r2.secretAccessKey,
                    fileNamePrefix: (0, exports.replayPrefix)(stream.id),
                    extensionParams: { endpoint: `https://${env_1.env.r2.accountId}.r2.cloudflarestorage.com` },
                },
            },
        });
        await prisma_1.prisma.liveStream.update({ where: { id: stream.id }, data: { recResourceId: resourceId, recSid: st.sid, recState: 'recording' } });
    }
    catch (err) {
        logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Live] запись эфира не запустилась');
        await prisma_1.prisma.liveStream.update({ where: { id: stream.id }, data: { recState: 'failed' } }).catch(() => undefined);
    }
}
/** Остановить запись (если шла). Файлы Agora догружает в R2 сама; ссылку найдём по папке. */
async function stopRecording(stream) {
    if (stream.recState !== 'recording' || !stream.recResourceId || !stream.recSid || !recordingConfigured())
        return;
    try {
        const r = await agoraRest(`/resourceid/${stream.recResourceId}/sid/${stream.recSid}/mode/mix/stop`, {
            cname: stream.channel, uid: exports.RECORDER_UID, clientRequest: {},
        });
        const files = r?.serverResponse?.fileList ?? [];
        const mp4 = (Array.isArray(files) ? files : []).map((f) => (typeof f === 'string' ? f : f?.fileName)).find((n) => typeof n === 'string' && n.endsWith('.mp4'));
        await prisma_1.prisma.liveStream.update({ where: { id: stream.id }, data: { recState: 'stopped', ...(mp4 ? { replayUrl: (0, mediaStorage_service_1.r2PublicUrl)(mp4) } : {}) } });
    }
    catch (err) {
        // Запись могла уже остановиться сама (maxIdleTime) — это нормально, файл найдём в R2.
        logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Live] остановка записи');
        await prisma_1.prisma.liveStream.update({ where: { id: stream.id }, data: { recState: 'stopped' } }).catch(() => undefined);
    }
}
/** Для завершённых эфиров без ссылки на повтор — ищем mp4 в папке записи в R2. */
async function resolveReplays(limit = 5) {
    if (!(0, mediaStorage_service_1.isR2Configured)())
        return;
    const since = new Date(Date.now() - 3 * 24 * 60 * 60_000);
    const rows = await prisma_1.prisma.liveStream.findMany({
        where: { status: 'ended', replayUrl: null, recState: { in: ['recording', 'stopped'] }, endedAt: { gte: since } },
        orderBy: { endedAt: 'desc' },
        take: limit,
    });
    for (const s of rows) {
        try {
            if (s.recState === 'recording')
                await stopRecording(s);
            const keys = await (0, mediaStorage_service_1.r2ListKeys)((0, exports.replayPrefix)(s.id).join('/') + '/');
            const mp4 = keys.filter((k) => k.endsWith('.mp4')).sort()[0];
            if (mp4)
                await prisma_1.prisma.liveStream.update({ where: { id: s.id }, data: { replayUrl: (0, mediaStorage_service_1.r2PublicUrl)(mp4), recState: 'stopped' } });
        }
        catch (err) {
            logger_1.logger.warn({ err: String(err?.message ?? err) }, '[Live] поиск файла повтора');
        }
    }
}
// ---------------------------------------------------------------------------
// Сколько зрителей сейчас в эфире — у Agora (REST «пользователи канала»), кэш 20 с.
// ---------------------------------------------------------------------------
const viewersCache = new Map();
async function viewersOf(channel) {
    const hit = viewersCache.get(channel);
    if (hit && Date.now() - hit.at < 20_000)
        return hit.n;
    const id = process.env.AGORA_CUSTOMER_ID?.trim();
    const secret = process.env.AGORA_CUSTOMER_SECRET?.trim();
    if (!id || !secret)
        return hit?.n ?? 0;
    try {
        const auth = Buffer.from(`${id}:${secret}`).toString('base64');
        const res = await fetchImpl(`https://api.agora.io/dev/v1/channel/user/${exports.AGORA_APP_ID}/${encodeURIComponent(channel)}`, {
            headers: { authorization: `Basic ${auth}` },
            signal: AbortSignal.timeout(5_000),
        });
        const data = await res.json().catch(() => ({}));
        const d = data?.data ?? {};
        const n = Number(d.audience_total ?? (Array.isArray(d.audience) ? d.audience.length : 0)) || 0;
        viewersCache.set(channel, { at: Date.now(), n });
        return n;
    }
    catch {
        return hit?.n ?? 0;
    }
}
/** Покупатели с «колокольчиком» на этого креатора получают пуш: эфир начался. */
async function notifyFollowers(stream, creatorName) {
    try {
        const rows = await prisma_1.prisma.liveFollow.findMany({ where: { creatorId: stream.creatorId }, take: 5000 });
        if (!rows.length)
            return 0;
        const phones = rows.filter((r) => !r.pushToken && r.phone).map((r) => r.phone);
        const byPhone = phones.length ? await prisma_1.prisma.shopCustomerPushToken.findMany({ where: { phone: { in: phones } } }) : [];
        const tokens = [...rows.map((r) => r.pushToken).filter(Boolean), ...byPhone.map((t) => t.token)];
        if (!tokens.length)
            return 0;
        const { sendBroadcast } = await Promise.resolve().then(() => __importStar(require('./pushBroadcast.service')));
        await sendBroadcast({
            title: `${creatorName || 'Креатор'} в эфире`,
            body: `«${stream.title}» — заходите, смотрите и покупайте`,
            tokens,
            data: { type: 'live', streamId: stream.id },
        });
        return tokens.length;
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Live] пуш подписчикам не ушёл');
        return 0;
    }
}
function bannerDto(b) {
    return { id: b.id, imageUrl: b.imageUrl, title: b.title ?? '', linkType: b.linkType ?? '', linkValue: b.linkValue ?? '' };
}
//# sourceMappingURL=live.service.js.map