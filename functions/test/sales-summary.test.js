'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeSales } = require('../sales-summary');

const now = new Date('2026-11-17T15:00:00Z');
const sale = (id, totalCents, date, refundedSources) => ({
    id, status: 'Confirmada', totalCents, createdAt: { toDate: () => new Date(date) },
    ...(refundedSources ? { refundedSources } : {})
});

test('acumula ventas netas, descuenta devoluciones y evita duplicados', () => {
    const secure = [
        sale('secure-1', 100000, '2026-11-17T03:00:00Z', { cash: 10000, transfer: 5000, card: 5000 }),
        sale('secure-2', 200000, '2026-11-17T02:59:59Z')
    ];
    const legacy = [
        { id: 'legacy-1', status: 'Confirmada', total: 250.5, date: '17/11/2026 10:30' },
        { id: 'secure-1', status: 'Confirmada', backendTicketId: 'secure-1', total: 1000, date: '17/11/2026' },
        { id: 'secure-2', status: 'Confirmada', total: 2000, date: '16/11/2026' },
        { id: 'pending', status: 'Pendiente de emisión' },
        { id: 'cancelled', status: 'Anulada' }
    ];
    assert.deepEqual(summarizeSales(secure, legacy, now), {
        todayCount: 2, todayCents: 125050, totalCount: 3, netCents: 305050
    });
});

test('una devolución total conserva la operación y deja su importe neto en cero', () => {
    const result = summarizeSales([sale('one', 10000, '2026-11-17T12:00:00Z',
        { cash: 10000, transfer: 0, card: 0 })], [], now);
    assert.deepEqual(result, { todayCount: 1, todayCents: 10000, totalCount: 1, netCents: 0 });
});

test('el cambio se suma como operación nueva después de descontar el crédito devuelto', () => {
    const original = sale('one', 10000, '2026-11-17T12:00:00Z', { cash: 10000, transfer: 0, card: 0 });
    const exchange = { id: 'change', totalCents: 12000, createdAt: { toDate: () => new Date('2026-11-17T13:00:00Z') } };
    assert.deepEqual(summarizeSales([original], [], now, [exchange]),
        { todayCount: 2, todayCents: 22000, totalCount: 2, netCents: 12000 });
    assert.throws(() => summarizeSales([], [], now, [{ ...exchange, totalCents: -1 }]), /Total del cambio/);
});

test('no inventa importes ni oculta referencias seguras faltantes o datos inválidos', () => {
    assert.throws(() => summarizeSales([], [{ id: 'x', backendTicketId: 'missing' }], now), /No se encontró/);
    assert.throws(() => summarizeSales([sale('x', 100, '2026-11-17T12:00:00Z',
        { cash: 101, transfer: 0, card: 0 })], [], now), /superan/);
    assert.throws(() => summarizeSales([], [{ id: 'x', total: 5, date: '31/02/2026' }], now), /fecha válida/);
    assert.throws(() => summarizeSales([], [{ id: 'x', total: NaN, date: '17/11/2026' }], now), /Total inválido/);
    assert.throws(() => summarizeSales([], [{ id: 'x', status: 'Anulada' }, { id: 'x', status: 'Anulada' }], now), /duplicado/);
});
