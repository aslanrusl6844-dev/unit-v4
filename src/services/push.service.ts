import { env } from '../config/env';
import { logger } from '../utils/logger';
import { prisma } from '../db/prisma';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

async function getAccessToken(): Promise<string | null> {
  const keyJson = env.firebaseKey;
  if (!keyJson) return null;
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
    const crypto = await import('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(key.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });
    const data = await res.json() as { access_token?: string };
    return data.access_token ?? null;
  } catch (err) {
    logger.error({ err }, '[Push] Ошибка получения токена');
    return null;
  }
}

export async function sendPush(phone: string, payload: PushPayload): Promise<void> {
  const token = await getAccessToken();
  if (!token) return;
  const projectId = 'my-market-3e032';
  const devices = await prisma.shopCustomerPushToken.findMany({ where: { phone } });
  for (const device of devices) {
    try {
      await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: payload.title, body: payload.body },
            data: payload.data,
          },
        }),
      });
    } catch (err) {
      logger.error({ err }, '[Push] Ошибка отправки');
    }
  }
}
