import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = 'postgresql://stub:stub@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const { financeBySrid } = require('../src/integrations/wb.client');

test('WB: суммы по srid из нового отчёта (деньги строками)', () => {
  const m = financeBySrid([
    { srid: 'a', ppvzSalesCommission: '120.50', deliveryService: '50', rebillLogisticCost: '-10', acquiringFee: '3.2' },
    { srid: 'a', ppvzSalesCommission: '-20', deliveryService: '0', acquiringFee: '0' },
    { srid: '', ppvzSalesCommission: '999' },
  ]);
  assert.deepEqual(m.get('a'), { commission: 140.5, logistics: 60, acquiring: 3.2 });
  assert.equal(m.size, 1);
});
