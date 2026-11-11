'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSale, normalizeItems } = require('../domain');

const catalog = { ACC1: { active: true, name: 'Cable', stock: 5, priceCents: 10000000 } };
const item = [{ id: 'ACC1', quantity: 1 }];

test('calcula los seis planes sobre el precio de catálogo', () => {
    for (const [plan, expected] of [
        ['phone-mp-3', 11460000], ['phone-mp-6', 12150000],
        ['phone-mp-9', 13120000], ['phone-mp-12', 14060000],
        ['phone-pampa-4', 10200000], ['phone-pampa-20', 13250000]
    ]) {
        const sale = calculateSale(item, catalog, { cashCents: 0, transferCents: 0, cardBaseCents: 10000000, cardPlan: plan });
        assert.equal(sale.totalCents, expected);
        assert.ok(sale.payment.cardNetCents <= sale.payment.cardTotalCents);
    }
});

test('divide pagos mixtos y no acepta precios enviados por el cliente', () => {
    const sale = calculateSale(item, catalog, { cashCents: 2000000, transferCents: 3000000, cardBaseCents: 5000000, cardPlan: 'phone-mp-3' });
    assert.equal(sale.subtotalCents, 10000000);
    assert.equal(sale.payment.cashCents, 2000000);
    assert.equal(sale.payment.transferCents, 3000000);
    assert.equal(sale.payment.cardTotalCents, 5730000);
});

test('rechaza stock insuficiente, artículos repetidos e importes inválidos', () => {
    assert.throws(() => normalizeItems([{ id: 'A', quantity: 1 }, { id: 'A', quantity: 1 }]), /duplicados/);
    assert.throws(() => normalizeItems([{ id: '../A', quantity: 1 }]), /inválido/);
    assert.throws(() => calculateSale([{ id: 'ACC1', quantity: 6 }], catalog, {}), /Stock insuficiente/);
    assert.throws(() => calculateSale(item, catalog, { cashCents: -1, transferCents: 0, cardBaseCents: 0 }), /importe válido/);
    assert.throws(() => calculateSale(item, catalog, { cashCents: 9999999, transferCents: 0, cardBaseCents: 0 }), /cubrir exactamente/);
    assert.throws(() => calculateSale(item, catalog, { cashCents: 0, transferCents: 0, cardBaseCents: 10000000, cardPlan: 'falso' }), /inválido/);
});

test('no registra un pago de tarjeta redondeado a cero', () => {
    const cheap = { X: { active: true, name: 'X', stock: 1, priceCents: 100 } };
    assert.throws(() => calculateSale([{ id: 'X', quantity: 1 }], cheap, { cashCents: 0, transferCents: 0, cardBaseCents: 100, cardPlan: 'phone-mp-3' }), /demasiado bajo/);
});
