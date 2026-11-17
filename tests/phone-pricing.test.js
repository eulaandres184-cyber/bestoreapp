const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function createApp() {
    const elements = new Map();
    const storage = new Map();
    const db = { collection: () => ({ doc: () => ({}) }) };
    const context = {
        tailwind: {}, firebase: { initializeApp() {}, firestore: () => db, auth: () => ({ currentUser: { uid: 'user' } }) }, crypto: webcrypto,
        localStorage: { setItem: (key, value) => storage.set(key, value), getItem: key => storage.get(key) || null }, window: {}, console: { error() {} },
        document: { getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', classList: { add() {}, remove() {}, toggle() {} } });
            return elements.get(id);
        } }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    context.requireAdmin = () => true;
    for (const name of ['saveLocalState', 'renderDashboard', 'renderAccTable', 'renderPhonesTable',
        'renderPOSItemsGrid', 'renderPOSTicket', 'showToast']) context[name] = () => {};
    vm.runInContext(`dailyDollarRate = 1590;
        PHONES = [{id:'PH-1', brand:'Apple', model:'15', storage:'128GB', condition:'Nuevo',
        currency:'USD', priceUsd:480, price:763200, status:'En Stock'}]`, context);
    return { context, elements, storage };
}

test('el ticket fija el precio seguro y lo conserva al cambiar la cotización', async () => {
    const { context } = createApp();
    context.callSecureFunction = async (name, payload) => {
        if (name === 'quotePhone') return { quoteId: payload.quoteId, priceCents: 76320000 };
        if (name === 'updateDollarRate') return { rate: payload.rate, phones: [{ id: 'PH-1', currency: 'USD', priceUsd: 480, price: 816000, status: 'Reservado' }] };
        throw new Error(name);
    };
    await context.addPOSItem('PH-1', 'phone');
    assert.equal(vm.runInContext('posState.ticket[0].price', context), 763200);
    assert.match(vm.runInContext('posState.ticket[0].quoteId', context), /^[0-9a-f-]{36}$/);
    context.document.getElementById('dailyDollarRate').value = '1700';
    await context.updateDollarRate();
    assert.equal(vm.runInContext('PHONES[0].price', context), 816000);
    assert.equal(vm.runInContext('posState.ticket[0].price', context), 763200);
});

test('si falla la cotización segura no se agrega el celular', async () => {
    const { context } = createApp();
    context.callSecureFunction = async () => { throw new Error('Sin conexión'); };
    await context.addPOSItem('PH-1', 'phone');
    assert.equal(vm.runInContext('posState.ticket.length', context), 0);
    assert.equal(vm.runInContext('PHONES[0].status', context), 'En Stock');
});

test('no elimina el celular si no puede cancelar el precio reservado', async () => {
    const { context } = createApp();
    context.callSecureFunction = async (name, payload) => {
        if (name === 'quotePhone') return { quoteId: payload.quoteId, priceCents: 76320000 };
        throw new Error('Sin conexión');
    };
    await context.addPOSItem('PH-1', 'phone');
    await context.updatePOSTicketQty('PH-1', -999);
    assert.equal(vm.runInContext('posState.ticket.length', context), 1);
    assert.equal(vm.runInContext('PHONES[0].status', context), 'Reservado');
});

test('si falla el cambio de cotización conserva el valor anterior', async () => {
    const { context } = createApp();
    context.document.getElementById('dailyDollarRate').value = '1700';
    context.callSecureFunction = async () => { throw new Error('Sin conexión'); };
    await context.updateDollarRate();
    assert.equal(vm.runInContext('dailyDollarRate', context), 1590);
    assert.equal(vm.runInContext('PHONES[0].price', context), 763200);
    assert.equal(context.document.getElementById('dailyDollarRate').value, 1590);
});

test('recupera un ticket pendiente del mismo usuario con su precio cotizado', async () => {
    const { context } = createApp();
    context.callSecureFunction = async (name, payload) => ({ quoteId: payload.quoteId, priceCents: 76320000 });
    await context.addPOSItem('PH-1', 'phone');
    const quoteId = vm.runInContext('posState.ticket[0].quoteId', context);
    vm.runInContext("posState.ticket = []; PHONES[0].status = 'En Stock'; PHONES[0].price = 816000", context);
    context.restoreTicketDraft('user', true);
    assert.equal(vm.runInContext('posState.ticket[0].quoteId', context), quoteId);
    assert.equal(vm.runInContext('posState.ticket[0].price', context), 763200);
    assert.equal(vm.runInContext('PHONES[0].status', context), 'Reservado');
    context.restoreTicketDraft('otro', true);
    assert.equal(vm.runInContext('posState.ticket.length', context), 0);
});

test('el comprobante transmite la cotización y se puede recuperar después de reiniciar', async () => {
    const { context } = createApp();
    let recorded;
    let attempts = 0;
    context.callSecureFunction = async (name, payload) => {
        if (name === 'quotePhone') return { quoteId: payload.quoteId, priceCents: 76320000 };
        if (name === 'recordSale') {
            recorded = payload;
            if (attempts++ === 0) throw new Error('Sin conexión');
            return { ticketId: '01234567-1234-4234-8234-012345678901', ticketNumber: 1, subtotalCents: 76320000, totalCents: 76320000,
                items: [{ id: 'PH-1', name: 'Apple 15', unitPriceCents: 76320000, stockAfter: 0 }],
                payment: { cashCents: 0, transferCents: 76320000, cardBaseCents: 0, cardTotalCents: 0, cardNetCents: 0 } };
        }
        throw new Error(name);
    };
    for (const name of ['renderSalesTable', 'openReceiptModal', 'refreshSecureRegisters', 'renderCashRegister']) context[name] = () => {};
    await context.addPOSItem('PH-1', 'phone');
    const quoteId = vm.runInContext('posState.ticket[0].quoteId', context);
    await context.processPOSCheckout();
    const operationId = vm.runInContext('SALES[0].backendOperationId', context);
    vm.runInContext("SALES = []; posState.ticket = []; pendingSaleId = null; posOperationInProgress = false; PHONES[0].status = 'En Stock'", context);
    context.restoreTicketDraft('user', true);
    assert.equal(vm.runInContext('SALES[0].backendOperationId', context), operationId);
    assert.equal(await context.finalizePendingSale(), true);
    assert.equal(recorded.items[0].quoteId, quoteId);
    assert.equal(recorded.payment.transferCents, 76320000);
    assert.equal(recorded.payment.cardBaseCents, 0);
    assert.equal(vm.runInContext('SALES[0].items[0].price', context), 763200);
});

test('impide cobrar si no se puede conservar el ticket en el dispositivo', async () => {
    const { context } = createApp();
    context.localStorage.setItem = () => { throw new Error('Almacenamiento lleno'); };
    vm.runInContext("posState.ticket = [{id:'A', title:'Cable', price:1000, quantity:1, type:'acc'}]", context);
    context.processPOSCheckout();
    assert.equal(vm.runInContext('SALES.length', context), 0);
});
