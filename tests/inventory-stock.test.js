const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp(stock, status) {
    const values = {
        prodId: 'ACC-1', prodTitle: 'Producto', prodCategory: 'audio',
        prodBrand: '', prodStock: String(stock), prodMinStock: '3',
        prodCost: '0', prodCurrency: 'ARS', prodPrice: '1000', prodBarcode: ''
    };
    const elements = new Map(Object.entries(values).map(([id, value]) => [id, { value }]));
    const db = { collection: () => ({ doc: () => ({}) }) };
    const context = {
        tailwind: {}, firebase: { initializeApp() {}, firestore: () => db },
        window: {}, console,
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, { value: '', textContent: '', reset() {} });
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    context.requireAdmin = () => true;
    context.callSecureFunction = async (name, payload) => { context.saved = { functionName: name, ...payload }; };
    context.saveLocalState = async () => true;
    for (const name of ['renderDashboard', 'renderAccTable', 'renderCaseSubcategoryOptions',
        'updateAccessorySubcategoryFilter', 'showProductFeedback', 'showToast']) context[name] = () => {};
    context.initialStatus = status;
    vm.runInContext("PRODUCTS = [{ id: 'ACC-1', title: 'Producto', category: 'audio', stock: 0, price: 1000, status: initialStatus }]", context);
    return context;
}

test('guardar stock positivo reactiva el producto en el catálogo y el backend', async () => {
    for (const stock of [1, 5]) {
        const context = createApp(stock, 'Anulado');
        await context.saveProduct({ preventDefault() {} });
        assert.equal(context.saved.functionName, 'saveInventoryItem');
        assert.equal(context.saved.stock, stock);
        assert.equal(context.saved.active, true);
        assert.equal(vm.runInContext('PRODUCTS[0].status', context), 'Activo');
    }
});

test('guardar stock cero deja el producto inactivo', async () => {
    const context = createApp(0, 'Activo');
    await context.saveProduct({ preventDefault() {} });
    assert.equal(context.saved.stock, 0);
    assert.equal(context.saved.active, false);
    assert.equal(vm.runInContext('PRODUCTS[0].status', context), 'Anulado');
});

test('el ajuste rápido reactiva con una unidad y anula al volver a cero', async () => {
    const context = createApp(0, 'Anulado');
    await context.quickAddStock('ACC-1', 1);
    assert.equal(context.saved.active, true);
    assert.equal(vm.runInContext('PRODUCTS[0].stock', context), 1);
    assert.equal(vm.runInContext('PRODUCTS[0].status', context), 'Activo');
    await context.quickAddStock('ACC-1', -1);
    assert.equal(context.saved.active, false);
    assert.equal(vm.runInContext('PRODUCTS[0].status', context), 'Anulado');
});

test('si falla el backend no se reactiva el producto localmente', async () => {
    const context = createApp(1, 'Anulado');
    context.console = { error() {} };
    context.callSecureFunction = async () => { throw new Error('Error de conexión'); };
    await context.saveProduct({ preventDefault() {} });
    assert.equal(vm.runInContext('PRODUCTS[0].status', context), 'Anulado');
    assert.equal(vm.runInContext('PRODUCTS[0].stock', context), 0);
});

test('guardar un producto en USD conserva esa cotización y usa ARS para el precio de caja', async () => {
    const context = createApp(1, 'Activo');
    vm.runInContext("dailyDollarRate = 1200", context);
    context.document.getElementById('prodCurrency').value = 'USD';
    context.document.getElementById('prodPrice').value = '15.5';

    await context.saveProduct({ preventDefault() {} });

    assert.equal(context.saved.priceCents, 1860000);
    assert.equal(vm.runInContext('PRODUCTS[0].currency', context), 'USD');
    assert.equal(vm.runInContext('PRODUCTS[0].priceUsd', context), 15.5);
    assert.equal(vm.runInContext('PRODUCTS[0].price', context), 18600);
    vm.runInContext('dailyDollarRate = 1300; normalizeCommercialData()', context);
    assert.equal(vm.runInContext('PRODUCTS[0].price', context), 20150);
});
