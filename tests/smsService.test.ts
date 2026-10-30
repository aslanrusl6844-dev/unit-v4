import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1:1/none';
process.env.SMS_API_KEY = 'test-sms-key';
process.env.SMS_PROVIDER = 'smsc';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendSms } = require('../src/services/sms.service');

const realFetch = globalThis.fetch;
let lastBody = '';
const stub = (reply: string, status = 200) => {
  globalThis.fetch = (async (_url: any, init?: any) => { lastBody = String(init?.body ?? ''); return new Response(reply, { status }); }) as typeof fetch;
};

describe('sendSms: ответ SMSC', () => {
  test('просит JSON-ответ (fmt=3)', async () => {
    stub(JSON.stringify({ id: 1, cnt: 1 }));
    assert.equal(await sendSms('77001112233', 'x'), true);
    assert.equal(new URLSearchParams(lastBody).get('fmt'), '3');
    globalThis.fetch = realFetch;
  });
  test('JSON-ошибка = не отправлено', async () => {
    stub(JSON.stringify({ error: 'insufficient funds', error_code: 3 }));
    assert.equal(await sendSms('77001112233', 'x'), false);
    globalThis.fetch = realFetch;
  });
  test('текстовая ошибка «ERROR = 2 (...)» больше не считается успехом', async () => {
    stub('ERROR = 2 (Not enough money)');
    assert.equal(await sendSms('77001112233', 'x'), false);
    globalThis.fetch = realFetch;
  });
  test('текстовый успех «OK - 1 SMS» принимается', async () => {
    stub('OK - 1 SMS, ID - 5');
    assert.equal(await sendSms('77001112233', 'x'), true);
    globalThis.fetch = realFetch;
  });
  test('HTTP-ошибка = не отправлено', async () => {
    stub('oops', 500);
    assert.equal(await sendSms('77001112233', 'x'), false);
    globalThis.fetch = realFetch;
  });
});
