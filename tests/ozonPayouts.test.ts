import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const { payoutPeriodOf } = require('../src/services/ozonPayouts.service');
const { ozonClient } = require('../src/integrations/ozon.client');

test('payoutPeriodOf: 1–15 и 16–конец месяца по Алматы', () => {
  assert.deepEqual(payoutPeriodOf(new Date('2026-11-09T10:00:00Z')), { key: '2026-11-01', from: '2026-11-01', to: '2026-11-15' });
  assert.deepEqual(payoutPeriodOf(new Date('2026-11-15T20:00:00Z')), { key: '2026-11-16', from: '2026-11-16', to: '2026-11-30' });
  assert.deepEqual(payoutPeriodOf(new Date('2026-02-20T00:00:00Z')).to, '2026-02-28');
});

test('fetchFinanceByPosting: разбор posting_accruals (выручка +, удержания −)', async () => {
  const http = {
    post: async (url: string) => {
      if (url === '/v1/finance/accrual/types') return { data: { accrual_types: [
        { id: 1, name: 'Выручка' }, { id: 2, name: 'Вознаграждение за продажу' }, { id: 3, name: 'Логистика' }, { id: 4, name: 'Эквайринг' },
      ] } };
      return { data: { posting_accruals: [{ posting_number: 'P-1', accruals: [
        { accrual_date: '2026-11-05', accrued: { amount: '10000' }, type_id: 1 },
        { accrual_date: '2026-11-05', accrued: { amount: '-1200' }, type_id: 2 },
        { accrual_date: '2026-11-06', accrued: { amount: '-699' }, type_id: 3 },
        { accrual_date: '2026-11-06', accrued: { amount: '-150' }, type_id: 4 },
      ] }, { posting_number: 'P-2', accruals: [] }] } };
    },
  };
  ozonClient.accrualTypes = null;
  const m = await ozonClient.fetchFinanceByPosting(http, ['P-1', 'P-2']);
  const f = m.get('P-1');
  assert.equal(f.revenue, 10000);
  assert.equal(f.commission, 1200);
  assert.equal(f.logistics, 699);
  assert.equal(f.acquiring, 150);
  assert.equal(f.payout, 7951);
  assert.equal(f.settledAt.toISOString().slice(0, 10), '2026-11-05');
  assert.equal(m.has('P-2'), false);
});
