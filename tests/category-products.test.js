const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp(role) {
    function element(tag = 'div') {
        return {
            tag, value: '', textContent: '', children: [], hidden: true,
            classList: {
                add() {}, remove() {}, toggle() {}
            },
            append(...items) { this.children.push(...items); },
            appendChild(item) { this.children.push(item); },
            replaceChildren() { this.children = []; },
            addEventListener(event, callback) { this[event] = callback; }
        };
    }
    const elements = new Map();
    const context = {
        tailwind: {}, window: {}, console,
        firebase: { initializeApp() {}, firestore: () => ({ collection: () => ({ doc: () => ({}) }) }) },
        document: {
            createElement: element,
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    context.role = role;
    vm.runInContext(`
        currentUserProfile = { active: true, role, bestoreRole: role };
        CATEGORIES = [{ id: 'soportes', name: 'Soportes' }, { id: 'audio', name: 'Audio' }];
        PRODUCTS = [
            { id: 'ACC-1', title: 'Soporte', brand: '', category: 'soportes', subcategory: '',
              stock: 0, minStock: 3, cost: null, price: 6500, cashPrice: 6500, barcode: '', status: 'Anulado' },
            { id: 'ACC-2', title: 'Parlante', brand: 'Marca', category: 'audio', subcategory: '',
              stock: 2, minStock: 3, cost: 0, price: 10000, cashPrice: 10000, barcode: '', status: 'Activo' }
        ];
    `, context);
    context.hideProductFeedback = () => {};
    context.renderCaseSubcategoryOptions = () => {};
    context.updateProductSubcategoryField = () => {};
    return { context, elements };
}

test('administrador abre la ficha del producto seleccionado desde una categoría', () => {
    const { context, elements } = createApp('admin');
    let opened = false;
    context.document.getElementById('productModal').classList.remove = () => { opened = true; };
    context.showCategoryProducts('soportes');
    const list = elements.get('categoryProductsList');
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].tag, 'button');
    assert.equal(list.children[0].type, 'button');
    list.children[0].click();
    assert.equal(opened, true);
    assert.equal(elements.get('prodId').value, 'ACC-1');
    assert.equal(elements.get('prodTitle').value, 'Soporte');
    assert.equal(elements.get('prodStock').value, 0);
    assert.equal(elements.get('prodPrice').value, 6500);
    assert.equal(elements.get('productModalTitle').textContent, 'Editar Producto');
});

test('vendedor ve productos sin acceso a la ficha de edición', () => {
    const { context, elements } = createApp('seller');
    let opened = false;
    context.document.getElementById('productModal').classList.remove = () => { opened = true; };
    context.showToast = () => {};
    context.showCategoryProducts('soportes');
    const item = elements.get('categoryProductsList').children[0];
    assert.equal(item.tag, 'div');
    assert.equal(item.click, undefined);
    context.editProduct('ACC-1');
    assert.equal(opened, false);
});

test('guardar desde la ficha actualiza la lista y cuenta de la categoría abierta', async () => {
    const { context, elements } = createApp('admin');
    context.showCategoryProducts('soportes');
    elements.get('categoryProductsList').children[0].click();
    elements.get('prodCategory').value = 'audio';
    context.callSecureFunction = async () => {};
    context.saveLocalState = async () => true;
    for (const name of ['renderDashboard', 'renderAccTable', 'updateAccessorySubcategoryFilter',
        'renderCategoriesPage', 'showProductFeedback']) context[name] = () => {};
    context.document.getElementById('productForm').reset = () => {};
    await context.saveProduct({ preventDefault() {} });
    assert.equal(elements.get('categoryProductsTitle').textContent, 'Soportes (0)');
    assert.equal(elements.get('categoryProductsList').children[0].textContent, 'No hay productos en esta categoría.');
    context.showCategoryProducts('audio');
    assert.equal(elements.get('categoryProductsTitle').textContent, 'Audio (2)');
    assert.equal(elements.get('categoryProductsList').children.length, 2);
});

test('eliminar producto lo quita del inventario local sin alterar ventas guardadas', async () => {
    const { context } = createApp('admin');
    let deletion;
    const storage = new Map();
    context.requireAdmin = () => true;
    context.confirmProductDeletion = async () => true;
    context.callSecureFunction = async (name, data) => { deletion = { name, data }; return { id: data.id }; };
    context.localStorage = { setItem: (key, value) => storage.set(key, value) };
    context.showToast = () => {};
    for (const name of ['renderDashboard', 'renderAccTable', 'renderPOSCategories',
        'renderPOSItemsGrid', 'renderCategoriesPage']) context[name] = () => {};
    vm.runInContext(`SALES = [{ id: 'sale-1', items: [{ id: 'ACC-1', title: 'Soporte', price: 6500 }] }]`, context);

    await context.deleteProduct('ACC-1');

    assert.equal(deletion.name, 'deleteInventoryItem');
    assert.equal(deletion.data.id, 'ACC-1');
    assert.equal(vm.runInContext(`PRODUCTS.some(item => item.id === 'ACC-1')`, context), false);
    assert.equal(vm.runInContext(`SALES[0].items[0].title`, context), 'Soporte');
    assert.equal(vm.runInContext(`SALES[0].items[0].price`, context), 6500);
    assert.equal(JSON.parse(storage.get('bestore_internal_products')).some(item => item.id === 'ACC-1'), false);
});

test('una categoría abierta se actualiza al eliminar un producto', async () => {
    const { context, elements } = createApp('admin');
    context.confirmProductDeletion = async () => true;
    context.callSecureFunction = async (_, data) => ({ id: data.id });
    context.localStorage = { setItem() {} };
    context.showToast = () => {};
    for (const name of ['renderDashboard', 'renderAccTable', 'renderPOSCategories',
        'renderPOSItemsGrid', 'renderCategoriesPage']) context[name] = () => {};
    context.showCategoryProducts('soportes');
    await context.deleteProduct('ACC-1');
    assert.equal(elements.get('categoryProductsTitle').textContent, 'Soportes (0)');
    assert.equal(elements.get('categoryProductsList').children[0].textContent, 'No hay productos en esta categoría.');
});

test('un error interno no elimina el producto y explica que no se pudo confirmar', async () => {
    const { context } = createApp('admin');
    const messages = [];
    context.confirmProductDeletion = async () => true;
    context.callSecureFunction = async () => { throw Object.assign(new Error('INTERNAL'), { code: 'functions/internal' }); };
    context.showToast = message => messages.push(message);
    await context.deleteProduct('ACC-1');
    assert.equal(vm.runInContext(`PRODUCTS.some(item => item.id === 'ACC-1')`, context), true);
    assert.match(messages[0], /No se pudo confirmar la eliminación/);
});

test('si falla el almacenamiento local, muestra el resultado confirmado y actualiza la pantalla', async () => {
    const { context } = createApp('admin');
    const messages = [];
    let rendered = 0;
    context.confirmProductDeletion = async () => true;
    context.callSecureFunction = async (_, data) => ({ id: data.id });
    context.localStorage = { setItem() { throw new Error('sin espacio'); } };
    context.showToast = message => messages.push(message);
    context.renderAccTable = () => { rendered++; };
    for (const name of ['renderDashboard', 'renderPOSCategories', 'renderPOSItemsGrid', 'renderCategoriesPage']) context[name] = () => {};
    await context.deleteProduct('ACC-1');
    assert.equal(vm.runInContext(`PRODUCTS.some(item => item.id === 'ACC-1')`, context), false);
    assert.equal(rendered, 1);
    assert.match(messages[0], /eliminado en Firebase.*almacenamiento/);
});

test('no envía dos eliminaciones simultáneas', async () => {
    const { context } = createApp('admin');
    let finish;
    let calls = 0;
    context.confirmProductDeletion = async () => true;
    context.callSecureFunction = async (_, data) => {
        calls++;
        await new Promise(resolve => { finish = resolve; });
        return { id: data.id };
    };
    context.localStorage = { setItem() {} };
    context.showToast = () => {};
    for (const name of ['renderDashboard', 'renderAccTable', 'renderPOSCategories', 'renderPOSItemsGrid', 'renderCategoriesPage']) context[name] = () => {};
    const first = context.deleteProduct('ACC-1');
    await Promise.resolve();
    await context.deleteProduct('ACC-2');
    assert.equal(calls, 1);
    finish();
    await first;
});
