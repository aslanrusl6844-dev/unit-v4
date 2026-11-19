import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoraCost, agoraMonthUsage, setAgoraUsageFetch } from '../src/services/agoraUsage.service';

test('стоимость: 10 000 бесплатных минут, потом по прайсу', () => {
  const z = { audio: 0, hd: 0, fullHd: 0, k2: 0, k4: 0, total: 0 };
  const r0 = { audio: 0, hd: 0, fullHd: 0, total: 0 };
  assert.deepEqual(agoraCost({ ...z, hd: 4000, total: 4000 }, r0), { costUsd: 0, freeLeft: 6000 });
  // 12 000 HD: 2 000 платных × $3.99/1000 = $7.98; запись 1 000 HD = $5.99
  assert.deepEqual(agoraCost({ ...z, hd: 12000, total: 12000 }, { ...r0, hd: 1000, total: 1000 }), { costUsd: 13.97, freeLeft: 0 });
});

test('расход за месяц из Agora API: проект по App ID, секунды → минуты, по дням', async () => {
  process.env.AGORA_CUSTOMER_ID = 'id';
  process.env.AGORA_CUSTOMER_SECRET = 'secret';
  const urls: string[] = [];
  setAgoraUsageFetch((async (url: string) => {
    urls.push(url);
    const body = url.includes('/dev/v1/projects')
      ? { projects: [{ id: 'p1', vendor_key: 'other' }, { id: 'p2', vendor_key: process.env.AGORA_APP_ID || 'eddfb3532542449897a94b234761dbc8' }] }
      : url.includes('business=cloudRecording')
        ? { usages: [{ date: '2026-11-18T00:00:00Z', usage: { durationVideoHd: 600 } }] }
        : { usages: [
          { date: '2026-11-17T00:00:00Z', usage: { durationVideoHd: 6000, durationAudioAll: 120 } },
          { date: '2026-11-18T00:00:00Z', usage: { durationVideoHd: 1200 } },
        ] };
    return { ok: true, json: async () => body } as any;
  }) as any);
  const u = await agoraMonthUsage('2026-11', new Date('2026-11-19T10:00:00Z'));
  assert.ok(urls[1].includes('project_id=p2') && urls[1].includes('from_date=2026-11-01') && urls[1].includes('to_date=2026-11-19'));
  assert.equal(u.minutes.hd, 120);
  assert.equal(u.minutes.audio, 2);
  assert.equal(u.recording.hd, 10);
  assert.equal(u.freeLeft, 10000 - 122);
  assert.deepEqual(u.days.map((d) => [d.date, d.minutes, d.recording]), [['2026-11-17', 102, 0], ['2026-11-18', 20, 10]]);
  setAgoraUsageFetch(null);
});
