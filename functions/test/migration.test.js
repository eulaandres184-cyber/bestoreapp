'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { previewMigration } = require('../migration');

test('prepara una vista previa sin modificar el inventario ni el historial original', () => {
    const state = {
        products: [{ id: 'ACC-1', title: 'Cable', stock: 5, price: 250.5, status: 'Activo' }],
        phones: [{ id: 'PH-1', brand: 'Apple', model: '15', storage: '128GB', condition: 'Nuevo', status: 'Reservado', currency: 'USD', price: 1000 }],
        sales: [{ id: 'TK-1', status: 'Confirmada', items: [{ id: 'ACC-1', quantity: 1, price: 250.5 }], subtotal: 250.5, total: 250.5, paymentMethod: 'Efectivo/Transferencia' }]
    };
    const original = structuredClone(state);
    const result = previewMigration(state);
    assert.deepEqual(state, original);
    assert.equal(result.inventory[0].priceCents, 25050);
    assert.equal(result.inventory[0].stock, 5);
    assert.match(result.inventory[1].issues.join(), /reservado/);
    assert.match(result.inventory[1].issues.join(), /USD/);
    assert.match(result.sales[0].issues.join(), /sin discriminar/);
});

test('identifica duplicados y datos faltantes sin inventar valores', () => {
    const result = previewMigration({
        products: [{ id: 'X', title: 'X', stock: 1, price: 10 }, { id: 'X', title: 'X', stock: -1 }],
        phones: [],
        sales: [{ id: 'TK-1', items: [], total: 0, subtotal: 0 }, { id: 'TK-1', items: [], total: 0, subtotal: 0 }]
    });
    assert.match(result.inventory[1].issues.join(), /duplicado/);
    assert.match(result.inventory[1].issues.join(), /Precio inválido/);
    assert.match(result.sales[1].issues.join(), /duplicado/);
    assert.throws(() => previewMigration({}), /no contiene/);
});
