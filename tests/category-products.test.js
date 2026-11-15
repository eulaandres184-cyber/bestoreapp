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
