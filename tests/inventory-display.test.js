const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp(role) {
    const elements = new Map();
    const context = {
        tailwind: {}, window: {}, console,
        firebase: { initializeApp() {}, firestore: () => ({ collection: () => ({ doc: () => ({}) }) }) },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, {
                    value: '', innerHTML: '', hidden: false,
                    classList: { toggle() {} }
                });
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    context.role = role;
    vm.runInContext(`
        currentUserProfile = { active: true, role, bestoreRole: role };
        PRODUCTS = [{ id: 'ACC-1', title: 'Cable', brand: 'Marca', category: 'audio',
            stock: 5, minStock: 1, cost: 1234, price: 5000, cashPrice: 4500, status: 'Activo' }];
    `, context);
    context.document.getElementById('accCategoryFilter').value = 'ALL';
    context.document.getElementById('accSubcategoryFilter').value = 'ALL';
    return { context, elements };
}

test('el vendedor ve precios y stock sin el costo unitario ni el valor total a costo', () => {
    const { context, elements } = createApp('seller');
    context.renderAccTable();
    const body = elements.get('accTableBody').innerHTML;
    const totals = elements.get('accTableTotals').innerHTML;
    assert.equal(elements.get('accCostHeader').hidden, true);
    assert.equal(elements.get('accCostColumn').hidden, true);
    assert.doesNotMatch(body, /Costo|1\.234/);
    assert.doesNotMatch(totals, /Valor a costo|6\.170/);
    assert.match(body, /data-label="Lista"[^>]*>[\s\S]*?\$5\.000/);
    assert.match(body, /data-label="Efectivo"[^>]*>\$4\.500/);
    assert.match(body, /5 un\./);
    assert.match(totals, /Valor a precio de lista/);
});

test('el administrador conserva el costo y cambiar de rol vuelve a actualizar la vista', () => {
    const { context, elements } = createApp('admin');
    context.renderAccTable();
    assert.equal(elements.get('accCostHeader').hidden, false);
    assert.equal(elements.get('accCostColumn').hidden, false);
    assert.match(elements.get('accTableBody').innerHTML, /data-label="Costo"[^>]*>\$1\.234/);
    assert.match(elements.get('accTableTotals').innerHTML, /Valor a costo[\s\S]*\$6\.170/);
    vm.runInContext("currentUserProfile = { active: true, role: 'seller', bestoreRole: 'seller' }", context);
    context.renderAccTable();
    assert.equal(elements.get('accCostHeader').hidden, true);
    assert.doesNotMatch(elements.get('accTableBody').innerHTML, /data-label="Costo"/);
    assert.doesNotMatch(elements.get('accTableTotals').innerHTML, /Valor a costo/);
});

test('la tabla vacía usa la cantidad de columnas correspondiente al rol', () => {
    for (const [role, colspan] of [['admin', 8], ['seller', 7]]) {
        const { context, elements } = createApp(role);
        vm.runInContext('PRODUCTS = []', context);
        context.renderAccTable();
        assert.match(elements.get('accTableBody').innerHTML, new RegExp(`colspan="${colspan}"`));
    }
});

test('el punto de venta ordena precios de menor a mayor en todas las categorías y búsquedas', () => {
    const { context, elements } = createApp('seller');
    const grid = context.document.getElementById('posItemsGrid');
    grid.querySelectorAll = () => [];
    vm.runInContext(`
        PRODUCTS = [
            { id: 'A', title: 'Cable caro', brand: 'Marca', category: 'audio', stock: 1, price: 300, status: 'Activo' },
            { id: 'B', title: 'Cable barato', brand: 'Marca', category: 'audio', stock: 1, price: 50, status: 'Activo' },
            { id: 'C', title: 'Funda', brand: 'Marca', category: 'fundas', stock: 1, price: 150, status: 'Activo' },
            { id: 'D', title: 'Sin stock', brand: 'Marca', category: 'audio', stock: 0, price: 1, status: 'Anulado' }
        ];
        PHONES = [
            { id: 'P1', brand: 'Phone', model: 'Caro', storage: '128', condition: 'Nuevo', status: 'En Stock', price: 250, imei: '1' },
            { id: 'P2', brand: 'Phone', model: 'Barato', storage: '128', condition: 'Usado', status: 'En Stock', price: 100, imei: '2' }
        ];
    `, context);
    const ids = () => [...grid.innerHTML.matchAll(/addPOSItem\('([^']+)'/g)].map(match => match[1]);
    context.renderPOSItemsGrid();
    assert.deepEqual(ids(), ['B', 'P2', 'C', 'P1', 'A']);
    vm.runInContext("posState.selectedCategory = 'audio'", context);
    context.renderPOSItemsGrid();
    assert.deepEqual(ids(), ['B', 'A']);
    vm.runInContext("posState.selectedCategory = 'celulares'", context);
    context.renderPOSItemsGrid();
    assert.deepEqual(ids(), ['P2', 'P1']);
    vm.runInContext("posState.selectedCategory = 'ALL'", context);
    context.document.getElementById('posSearchInput').value = 'cable';
    context.renderPOSItemsGrid();
    assert.deepEqual(ids(), ['B', 'A']);
});
