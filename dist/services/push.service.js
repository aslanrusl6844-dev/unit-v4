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
exports.sendPush = sendPush;
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
const prisma_1 = require("../db/prisma");
async function getAccessToken() {
    const keyJson = env_1.env.firebaseKey;
    if (!keyJson)
        return null;
    try {
        const key = JSON.parse(keyJson);
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
            iss: key.client_email,
            sub: key.client_email,
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600,
            scope: 'https://www.googleapis.com/auth/firebase.messaging',
        })).toString('base64url');
        const crypto = await Promise.resolve().then(() => __importStar(require('crypto')));
        const sign = crypto.createSign('RSA-SHA256');
        sign.update(`${header}.${payload}`);
        const signature = sign.sign(key.private_key, 'base64url');
        const jwt = `${header}.${payload}.${signature}`;
        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        });
        const data = await res.json();
        return data.access_token ?? null;
    }
    catch (err) {
        logger_1.logger.error({ err }, '[Push] Ошибка получения токена');
        return null;
    }
}
async function sendPush(phone, payload, onlyNotification = false) {
    const token = await getAccessToken();
    if (!token) {
        logger_1.logger.error('[Push] Нет access token — FIREBASE_KEY не настроен или неверный');
        return;
    }
    const projectId = 'my-market-3e032';
    const devices = await prisma_1.prisma.shopCustomerPushToken.findMany({ where: { phone } });
    logger_1.logger.info({ phone, count: devices.length }, '[Push] Устройств для отправки');
    for (const device of devices) {
        try {
            const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: {
                        token: device.token,
                        notification: { title: payload.title, body: payload.body },
                        ...(onlyNotification ? {} : { data: payload.data }),
                    },
                }),
            });
            const body = await res.text();
            logger_1.logger.info({ status: res.status, body: body.slice(0, 200) }, '[Push] Ответ FCM');
        }
        catch (err) {
            logger_1.logger.error({ err }, '[Push] Ошибка отправки');
        }
    }
}
//# sourceMappingURL=push.service.js.map