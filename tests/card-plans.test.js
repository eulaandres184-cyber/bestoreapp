const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function createApp() {
    const select = {
        value: '',
        innerHTML: '',
        get options() {
            return [...this.innerHTML.matchAll(/<option /g)];
        },
        classList: { add() {}, remove() {}, toggle() {} }
    };
    const elements = new Map([
        ['cardPlanSelect', select],
        ['cardPlanHint', { textContent: '' }]
    ]);
    const db = { collection: () => ({ doc: () => ({}) }) };
    const context = {
        tailwind: {},
        firebase: { initializeApp() {}, firestore: () => db },
        crypto: webcrypto,
        window: {},
        document: {
            getElementById(id) {
                if (!elements.has(id)) {
                    elements.set(id, {
                        value: '',
                        className: '',
                        textContent: '',
                        classList: { add() {}, remove() {}, toggle() {} }
                    });
                }
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    return { context, select, elements };
}

test('los seis planes aplican la fórmula y el redondeo de la tabla', () => {
    const { context, select } = createApp();
    context.updatePOSCardPlanOptions();
    const expected = [
        ['phone-mp-3', 114600],
        ['phone-mp-6', 121500],
        ['phone-mp-9', 131200],
        ['phone-mp-12', 140600],
        ['phone-pampa-4', 102000],
        ['phone-pampa-20', 132500]
    ];
    for (const [plan, total] of expected) {
        select.value = plan;
        const charge = context.calculateCardCharges(100000);
        assert.equal(100000 + charge.total, total, plan);
        assert.equal(context.calculateCardCharges(0).total, 0, plan);
    }
});

test('accesorios, celulares y tickets mixtos usan los mismos planes', () => {
    const { context, select } = createApp();
    const options = [];
    for (const ticket of [
        [{ type: 'acc' }],
        [{ type: 'phone' }],
        [{ type: 'acc' }, { type: 'phone' }]
    ]) {
        context.ticketFixture = ticket;
        vm.runInContext('posState.ticket = ticketFixture; updatePOSCardPlanOptions()', context);
        options.push(select.innerHTML);
    }
    assert.equal(options[0], options[1]);
    assert.equal(options[0], options[2]);
});

test('seleccionar tarjeta con el ticket vacío inicializa los planes', () => {
    const { context, select, elements } = createApp();
    context.setPOSPaymentMethod('card');
    assert.equal(select.options.length, 6);
    assert.equal(select.value, 'phone-mp-3');
    assert.equal(elements.get('posTotal').textContent, '$0');
});

test('el resumen no inventa el medio de pagos históricos y calcula tarjeta neta', () => {
    const { context } = createApp();
    const result = context.summarizePayments([
        { paymentVersion: 2, paymentMethod: 'Pago mixto', paymentBreakdown: { cash: 100, transfer: 200, card: 500 }, cardCommission: 50, cardCommissionVat: 10 },
        { paymentMethod: 'Efectivo/Transferencia', paymentBreakdown: { cash: 300, card: 0 } },
        { paymentMethod: 'Tarjeta/Cuotas', total: 250 },
        { paymentMethod: 'Cuenta corriente', total: 1000 }
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { cash: 100, transfer: 200, card: 440, cardUnknownNet: 250, unclassified: 300 });
});

test('efectivo y transferencia quedan registrados por separado', () => {
    for (const [method, expected] of [['cash', 'cash'], ['transfer', 'transfer']]) {
        const { context } = createApp();
        for (const name of ['saveLocalState', 'renderDashboard', 'renderAccTable', 'renderPhonesTable', 'renderSalesTable', 'renderPOSItemsGrid', 'openReceiptModal', 'showToast']) {
            context[name] = () => {};
        }
        context.methodFixture = method;
        vm.runInContext("posState.ticket = [{id:'A', title:'Producto', price:1000, quantity:1, type:'acc'}]; posState.paymentMethod = methodFixture", context);
        context.processPOSCheckout();
        const sale = vm.runInContext('SALES[0]', context);
        assert.equal(sale.paymentBreakdown[expected], 1000);
        assert.equal(sale.paymentBreakdown[method === 'cash' ? 'transfer' : 'cash'], 0);
        assert.match(sale.backendOperationId, /^[0-9a-f-]{36}$/i);
        assert.equal(sale.backendPayment[expected === 'cash' ? 'cashCents' : 'transferCents'], 100000);
    }
});

test('no registra cuenta corriente ni plan canje todavía no soportados', () => {
    const { context } = createApp();
    const messages = [];
    context.showToast = message => messages.push(message);
    context.methodFixture = 'account';
    vm.runInContext("posState.ticket = [{id:'A', title:'Producto', price:1000, quantity:1, type:'acc'}]; posState.paymentMethod = methodFixture", context);
    context.processPOSCheckout();
    assert.equal(vm.runInContext('SALES.length', context), 0);
    assert.match(messages.pop(), /Cuenta corriente todavía no está integrada/);

    context.methodFixture = 'cash';
    vm.runInContext("posState.paymentMethod = methodFixture", context);
    context.document.getElementById('posCanjeDeduction').value = '100';
    context.processPOSCheckout();
    assert.equal(vm.runInContext('SALES.length', context), 0);
    assert.match(messages.pop(), /Plan canje todavía no está integrado/);
});

test('el backend confirma el ticket y conserva su operación al pasar al historial', async () => {
    const { context } = createApp();
    const node = id => context.document.getElementById(id);
    const storedRequest = {};
    const result = {
        ticketId: '01234567-1234-4234-8234-012345678901',
        items: [{ id: 'A', name: 'Producto seguro', quantity: 1, unitPriceCents: 100000, totalCents: 100000, stockAfter: 4 }],
        subtotalCents: 100000,
        totalCents: 100000,
        payment: { cashCents: 100000, transferCents: 0, cardBaseCents: 0, cardTotalCents: 0, cardNetCents: 0, cardPlan: '' }
    };
    context.firebase.app = () => ({
        functions: () => ({
            httpsCallable: name => async payload => {
                assert.equal(name, 'recordSale');
                Object.assign(storedRequest, payload);
                return { data: result };
            }
        })
    });
    for (const name of ['saveLocalState', 'renderDashboard', 'renderAccTable', 'renderPhonesTable', 'renderSalesTable', 'renderPOSItemsGrid', 'renderPOSTicket', 'renderCashRegister', 'refreshSecureRegisters', 'openReceiptModal', 'showToast']) {
        context[name] = async () => true;
    }
    vm.runInContext("PRODUCTS = [{id:'A', title:'Producto', stock:4, price:1000, status:'Activo'}]; posState.ticket = [{id:'A', title:'Producto', price:1000, quantity:1, type:'acc'}]; posState.paymentMethod = 'cash'", context);
    context.processPOSCheckout();
    const operationId = vm.runInContext('SALES[0].backendOperationId', context);
    assert.equal(await context.finalizePendingSale('Impreso'), true);
    assert.equal(storedRequest.operationId, operationId);
    assert.equal(storedRequest.payment.cashCents, 100000);
    assert.equal(vm.runInContext('SALES[0].id', context), result.ticketId);
    assert.equal(vm.runInContext('SALES[0].status', context), 'Confirmada');
    assert.equal(vm.runInContext('PRODUCTS[0].stock', context), 4);
});

test('la venta mixta guarda los tres medios y valida el total al centavo', () => {
    const { context, elements } = createApp();
    const node = id => context.document.getElementById(id);
    for (const name of ['saveLocalState', 'renderDashboard', 'renderAccTable', 'renderPhonesTable', 'renderSalesTable', 'renderPOSItemsGrid', 'openReceiptModal']) {
        context[name] = () => {};
    }
    const messages = [];
    context.showToast = message => messages.push(message);
    context.updatePOSCardPlanOptions();
    vm.runInContext("posState.ticket = [{id:'A', title:'Producto', price:1000, quantity:1, type:'acc'}]; posState.paymentMethod = 'mixed'", context);
    node('mixedCashAmount').value = '200';
    node('mixedTransferAmount').value = '300';
    node('mixedCardAmount').value = '499.99';
    context.processPOSCheckout();
    assert.match(messages.pop(), /debe completar/);
    node('mixedCardAmount').value = '500';
    context.processPOSCheckout();
    const sale = vm.runInContext('SALES[0]', context);
    assert.equal(sale.paymentVersion, 2);
    assert.equal(sale.paymentBreakdown.cash, 200);
    assert.equal(sale.paymentBreakdown.transfer, 300);
    assert.equal(sale.paymentBreakdown.card, 600);
    assert.equal(sale.total, 1100);
    assert.equal(sale.backendPayment.cashCents, 20000);
    assert.equal(sale.backendPayment.transferCents, 30000);
    assert.equal(sale.backendPayment.cardBaseCents, 50000);
    assert.equal(elements.get('posCheckoutButton').disabled, true);
});
