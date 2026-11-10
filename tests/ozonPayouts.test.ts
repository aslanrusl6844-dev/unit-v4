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
        { id: 1, name: 'DefectRate' }, { id: 2, name: 'SaleCommission' }, { id: 3, name: 'Logistic' }, { id: 4, name: 'Acquiring' },
      ] } };
      return { data: { posting_accruals: [{ posting_number: 'P-1', accruals: [
        { accrual_date: '2026-11-04', accrued: { amount: '-100' }, type_id: 1 },
        { accrual_date: '2026-11-05', accrued: { amount: '-1200' }, type_id: 2 },
        { accrual_date: '2026-11-06', accrued: { amount: '-699' }, type_id: 3 },
        { accrual_date: '2026-11-06', accrued: { amount: '-150' }, type_id: 4 },
      ] }, { posting_number: 'P-2', accruals: [] }] } };
    },
  };
  ozonClient.accrualTypes = null;
  const m = await ozonClient.fetchFinanceByPosting(http, ['P-1', 'P-2']);
  const f = m.get('P-1');
  assert.equal(f.revenue, 0);
  assert.equal(f.commission, 1200);
  assert.equal(f.logistics, 699);
  assert.equal(f.acquiring, 150);
  assert.equal(f.other, 100);
  assert.equal(f.payout, -2149);
  assert.equal(f.settledAt.toISOString().slice(0, 10), '2026-11-05');
  assert.equal(m.has('P-2'), false);
});

test('ozonFeeKind: английские названия Ozon', () => {
  const { ozonFeeKind } = require('../src/integrations/ozon.client');
  assert.equal(ozonFeeKind('SaleCommission'), 'commission');
  assert.equal(ozonFeeKind('LastMileCourier'), 'logistics');
  assert.equal(ozonFeeKind('Drop-Off'), 'logistics');
  assert.equal(ozonFeeKind('Acquiring'), 'acquiring');
  assert.equal(ozonFeeKind('DefectRate'), 'other');
});

test('withActionPrice: цена в акции ниже обычной — берём её', () => {
  const { withActionPrice } = require('../src/services/sync.service');
  const m = new Map([['111', 46222]]);
  assert.equal(withActionPrice(57057, '111', m), 46222);
  assert.equal(withActionPrice(57057, '222', m), 57057);
  assert.equal(withActionPrice(40000, '111', m), 40000);
});

test('mapTeezOrder: к выплате и дата получения из Teez', () => {
  const { mapTeezOrder } = require('../src/integrations/teez.client');
  const o = mapTeezOrder({ orderGuid: 'g1', createdDate: '2026-11-01T10:00:00Z', receivedDate: '2026-11-04T10:00:00Z', statusKey: 'received', barcode: '460123', productName: 'Шампунь', quantity: 2, quantityReturned: 0, price: 5000, commissionAmount: 600, payoutAmount: 4400 });
  assert.equal(o.status, 'COMPLETED');
  assert.equal(o.payoutAmount, 8800);
  assert.equal(o.settledAt.toISOString().slice(0, 10), '2026-11-04');
  const pending = mapTeezOrder({ orderGuid: 'g2', createdDate: '2026-11-01T10:00:00Z', statusKey: 'pending', barcode: '1', quantity: 1, price: 100, payoutAmount: 80 });
  assert.equal(pending.settledAt, null);
});
