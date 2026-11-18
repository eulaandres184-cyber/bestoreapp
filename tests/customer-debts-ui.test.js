const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp() {
    const stored = new Map();
    const elements = new Map();
    const context = {
        tailwind: {}, window: {}, console: { error() {} },
        firebase: {
            initializeApp() {},
            firestore: () => ({ collection: () => ({ doc: () => ({}) }) }),
            auth: () => ({ currentUser: { uid: 'seller' } })
        },
        localStorage: {
            getItem(key) { return stored.get(key) || null; },
            setItem(key, value) { stored.set(key, value); },
            removeItem(key) { stored.delete(key); }
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { toggle() {} } });
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    context.showToast = () => {};
    context.createOperationId = () => '11111111-2222-4333-8444-555555555555';
    context.refreshSecureRegisters = async () => {};
    return { context, stored, elements };
}

test('el dashboard muestra deudas y escapa los datos del cliente', async () => {
    const { context, elements } = createApp();
    context.callSecureFunction = async () => [{
        ticketId: '01234567-1234-4234-8234-012345678901', ticketNumber: 1,
        customerName: '<Cliente>', totalCents: 100000, paidCents: 0, balanceCents: 100000,
        locked: false, items: [{ name: '<Cable>', quantity: 1 }], payments: [], createdAt: null
    }];
    await context.refreshCustomerDebts();
    assert.match(elements.get('customerDebtsList').innerHTML, /&lt;Cliente&gt;/);
    assert.match(elements.get('customerDebtsList').innerHTML, /&lt;Cable&gt;/);
    assert.match(elements.get('customerDebtsList').innerHTML, /Precio actualizable/);
    assert.match(elements.get('customerDebtsStatus').textContent, /1 deuda/);
});

test('un cobro incierto se reintenta con la misma operación y no permite otro', async () => {
    const { context, stored } = createApp();
    const requests = [];
    context.refreshCustomerDebts = async () => {};
    context.callSecureFunction = async (name, payload) => {
        requests.push(JSON.parse(JSON.stringify(payload)));
        if (requests.length === 1) throw new Error('Respuesta incierta');
        return {};
    };
    const event = { preventDefault() {}, currentTarget: { elements: {
        amount: { value: '12.34' }, medium: { value: 'transfer' }, plan: { value: '' }
    } } };
    const ticketId = '01234567-1234-4234-8234-012345678901';
    await context.submitCustomerDebtPayment(event, ticketId, 100000);
    assert.equal(stored.size, 1);
    await context.submitCustomerDebtPayment(event, ticketId, 100000);
    assert.equal(requests.length, 1);
    await context.retryCustomerDebtPayment();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].payment.transferCents, 1234);
    assert.equal(stored.size, 0);
});

test('la alerta aparece exactamente a las 48 horas y desaparece al resolver el saldo', async () => {
    const { context, elements } = createApp();
    const now = Date.parse('2026-11-18T18:00:00Z');
    context.Date = class extends Date { static now() { return now; } };
    context.isAdmin = () => true;
    let balance = 10000;
    let age = 48 * 60 * 60 * 1000 - 1;
    context.callSecureFunction = async () => [{
        creditId: '01234567-1234-4234-8234-012345678901', ticketNumber: 1,
        customerName: '<Cliente>', reason: 'Cambio', balanceCents: balance,
        items: [{ id: 'A', name: '<Cable>', quantity: 1 }], history: [],
        createdAt: new Date(now - age).toISOString(), alertPeriods: Math.floor(age / (48 * 60 * 60 * 1000))
    }];
    await context.refreshReturnCredits();
    assert.match(elements.get('returnCreditsStatus').textContent, /0 con alerta/);
    assert.doesNotMatch(elements.get('returnCreditsList').innerHTML, /Alerta:/);
    age++;
    await context.refreshReturnCredits();
    assert.match(elements.get('returnCreditsStatus').textContent, /1 con alerta/);
    assert.match(elements.get('returnCreditsList').innerHTML, /1 período/);
    assert.match(elements.get('returnCreditsList').innerHTML, /&lt;Cliente&gt;/);
    age *= 2;
    await context.refreshReturnCredits();
    assert.match(elements.get('returnCreditsList').innerHTML, /2 período/);
    balance = 0;
    await context.refreshReturnCredits();
    assert.match(elements.get('returnCreditsStatus').textContent, /0 con alerta/);
    assert.match(elements.get('returnCreditsList').innerHTML, /Resuelta/);
});

test('una devolución incierta se reintenta con la solicitud original', async () => {
    const { context, stored } = createApp();
    context.requireAdmin = () => true;
    context.refreshReturnCredits = async () => {};
    context.refreshSecureRegisters = async () => {};
    context.refreshSecureInventory = async () => {};
    context.closeReturnEntry = () => {};
    context.closeReturnResolution = () => {};
    context.renderSalesTable = () => {};
    context.renderDashboard = () => {};
    context.renderAccTable = () => {};
    context.renderPhonesTable = () => {};
    context.renderPOSItemsGrid = () => {};
    context.refreshSalesSummary = () => {};
    const requests = [];
    context.callSecureFunction = async (name, payload) => {
        requests.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
        if (requests.length === 1) throw new Error('Respuesta incierta');
        return {};
    };
    const payload = { operationId: '01234567-1234-4234-8234-012345678901', customerName: 'Ana' };
    await context.queueReturnOperation('createReturnCredit', payload);
    assert.equal(stored.size, 1);
    await context.retryReturnOperation();
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(stored.size, 0);
});

test('el cálculo del cambio conserva el precio del accesorio devuelto y suma los demás productos', () => {
    const { context } = createApp();
    context.fixtureResolution = {
        credit: { balanceCents: 100000, items: [{ id: 'A', quantity: 1, exchangedQuantity: 0, unitPriceCents: 100000 }] },
        inventory: [{ id: 'A', priceCents: 150000 }, { id: 'B', priceCents: 25000 }]
    };
    vm.runInContext('returnResolution = fixtureResolution', context);
    const preview = { textContent: '' };
    const form = {
        elements: { card: { value: '0' }, plan: { value: 'phone-mp-3' } },
        querySelector(selector) {
            if (selector === '[data-exchange-quantity="0"]') return { value: '1' };
            if (selector === '[data-exchange-quantity="1"]') return { value: '1' };
            return preview;
        }
    };
    context.updateReturnResolutionPreview(form);
    assert.match(preview.textContent, /1\.250,00/);
    assert.match(preview.textContent, /250,00/);
});
