'use strict';

const plans = Object.freeze({
    'phone-mp-3': { label: 'Mercado Pago - 3 cuotas', cost: 0.127655 },
    'phone-mp-6': { label: 'Mercado Pago - 6 cuotas', cost: 0.177265 },
    'phone-mp-9': { label: 'Mercado Pago - 9 cuotas', cost: 0.237765 },
    'phone-mp-12': { label: 'Mercado Pago - 12 cuotas', cost: 0.288585 },
    'phone-pampa-4': { label: 'Banco Pampa - 4 cuotas', cost: 0.02 },
    'phone-pampa-20': { label: 'Banco Pampa - 20 cuotas', cost: 0.245 }
});

class DomainError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function assert(condition, message, code = 'invalid-argument') {
    if (!condition) throw new DomainError(code, message);
}

function money(value, label) {
    assert(Number.isSafeInteger(value) && value >= 0, `${label} debe ser un importe válido en centavos.`);
    return value;
}

function normalizeItems(items) {
    assert(Array.isArray(items) && items.length > 0 && items.length <= 100, 'El ticket debe contener entre 1 y 100 artículos.');
    const seen = new Set();
    return items.map(item => {
        assert(item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(item.id), 'Identificador de artículo inválido.');
        assert(!seen.has(item.id), 'No se admiten artículos duplicados.');
        seen.add(item.id);
        assert(Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10000, 'Cantidad inválida.');
        return { id: item.id, quantity: item.quantity };
    });
}

function calculateSale(items, catalog, payment) {
    const lines = items.map(item => {
        const product = catalog[item.id];
        assert(product && product.active === true, `El artículo ${item.id} no está disponible.`, 'failed-precondition');
        assert(Number.isSafeInteger(product.stock) && product.stock >= item.quantity, `Stock insuficiente para ${item.id}.`, 'failed-precondition');
        assert(typeof product.name === 'string' && product.name.length > 0 && product.name.length <= 200, `Nombre inválido para ${item.id}.`, 'failed-precondition');
        const unitPrice = money(product.priceCents, 'Precio');
        const lineTotal = unitPrice * item.quantity;
        money(lineTotal, 'Subtotal');
        return { id: item.id, name: product.name, quantity: item.quantity, unitPriceCents: unitPrice, totalCents: lineTotal };
    });
    const subtotal = lines.reduce((sum, line) => money(sum + line.totalCents, 'Subtotal'), 0);
    assert(payment && typeof payment === 'object', 'Forma de pago inválida.');
    const cash = money(payment.cashCents, 'Efectivo');
    const transfer = money(payment.transferCents, 'Transferencia');
    const cardBase = money(payment.cardBaseCents, 'Tarjeta');
    assert(money(cash + transfer + cardBase, 'Pago') === subtotal, 'Los medios de pago deben cubrir exactamente el subtotal.');
    let cardTotal = 0;
    let cardNet = 0;
    let cardPlan = '';
    if (cardBase > 0) {
        const plan = plans[payment.cardPlan];
        assert(plan, 'Plan de tarjeta inválido.');
        cardTotal = Math.round(cardBase / (1 - plan.cost) / 10000) * 10000;
        money(cardTotal, 'Total de tarjeta');
        assert(cardTotal > 0, 'El importe de tarjeta es demasiado bajo para redondearlo a $100.');
        cardNet = Math.round(cardTotal * (1 - plan.cost));
        cardPlan = plan.label;
    }
    return {
        items: lines,
        subtotalCents: subtotal,
        totalCents: money(cash + transfer + cardTotal, 'Total'),
        payment: { cashCents: cash, transferCents: transfer, cardBaseCents: cardBase, cardTotalCents: cardTotal, cardNetCents: cardNet, cardPlan }
    };
}

module.exports = { DomainError, assert, money, normalizeItems, calculateSale, plans };
