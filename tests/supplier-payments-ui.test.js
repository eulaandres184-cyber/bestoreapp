const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp() {
    const elements = new Map();
    const stored = new Map();
    const notifications = [];
    const errors = [];
    function element() {
        const classes = new Set();
        return {
            value: '',
            textContent: '',
            innerHTML: '',
            disabled: false,
            required: false,
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                toggle(name, force) {
                    if (force === undefined ? !classes.has(name) : force) classes.add(name);
                    else classes.delete(name);
                }
            },
            reset() {}
        };
    }

    const context = {
        tailwind: {},
        window: {},
        console: { log() {}, warn() {}, error(...args) { errors.push(args); } },
        firebase: {
            initializeApp() {},
            firestore: () => ({ collection: () => ({ doc: () => ({}) }) }),
            auth: () => ({ currentUser: { uid: 'admin' } })
        },
        localStorage: {
            getItem(key) { return stored.get(key) || null; },
            setItem(key, value) { stored.set(key, value); },
            removeItem(key) { stored.delete(key); }
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    context.requireAdmin = () => true;
    context.showToast = message => notifications.push(message);
    context.createOperationId = () => 'c0ffcccc-2222-4333-8444-555555555563';
    context.refreshSupplierPayments = async () => {};
    context.refreshSecureRegisters = async () => {};
    vm.runInContext("SUPPLIERS.push({ id: 'SUP-1', name: 'Proveedor Uno' })", context);
    return {
        context,
        element: id => context.document.getElementById(id),
        stored,
        notifications,
        errors
    };
}

test('el formulario convierte el importe a centavos y reintenta el mismo pago sin duplicarlo', async () => {
    const { context, element, stored } = createApp();
    element('supplierPaymentRecipient').value = 'SUP-1';
    element('supplierPaymentAmount').value = '12.34';
    element('supplierPaymentMedium').value = 'cash';
    element('supplierPaymentNote').value = 'Flete';
    const requests = [];
    context.callSecureFunction = async (name, payload) => {
        requests.push({ name, payload: JSON.parse(JSON.stringify(payload)) });
        if (requests.length === 1) throw new Error('Respuesta incierta');
        return {};
    };

    await context.saveSupplierPayment({ preventDefault() {} });
    const pendingKey = 'bestore_supplier_payment_pending_admin';
    const pending = JSON.parse(stored.get(pendingKey));
    element('supplierPaymentAmount').value = '99';
    element('supplierPaymentNote').value = 'Otro concepto';
    await context.saveSupplierPayment({ preventDefault() {} });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].name, 'recordSupplierPayment');
    assert.equal(requests[0].payload.amountCents, 1234);
    assert.equal(requests[0].payload.supplierId, 'SUP-1');
    assert.equal(requests[1].payload.operationId, pending.operationId);
    assert.deepEqual(requests[1].payload, requests[0].payload);
    assert.equal(stored.has(pendingKey), false);
});
