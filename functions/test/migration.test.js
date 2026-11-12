'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrationSourceHash, planMigration, previewMigration } = require('../migration');
const { migrate, parseArguments } = require('../migrate-legacy');

class MigrationFirestore {
    constructor(entries = []) {
        this.documents = new Map(entries);
    }

    doc(path) {
        return { path, get: async () => this.snapshot({ path }) };
    }

    collection(name) {
        return { doc: id => this.doc(`${name}/${id}`) };
    }

    snapshot(ref) {
        return {
            ref,
            exists: this.documents.has(ref.path),
            data: () => this.documents.get(ref.path)
        };
    }

    async getAll(...refs) {
        return refs.map(ref => this.snapshot(ref));
    }

    batch() {
        const writes = [];
        return {
            create: (ref, data) => writes.push([ref, data]),
            commit: async () => this.commit(writes)
        };
    }

    async runTransaction(callback) {
        const writes = [];
        const result = await callback({
            get: async ref => this.snapshot(ref),
            create: (ref, data) => writes.push([ref, data])
        });
        this.commit(writes);
        return result;
    }

    commit(writes) {
        for (const [ref] of writes) {
            if (this.documents.has(ref.path)) throw new Error(`Already exists: ${ref.path}`);
        }
        for (const [ref, data] of writes) this.documents.set(ref.path, data);
    }
}

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

test('prepara solo registros limpios, conserva tickets como archivo y no muta el origen', () => {
    const state = {
        products: [
            { id: 'ACC-1', title: 'Cable', stock: 2, price: 250.5, status: 'Activo' },
            { id: 'ACC-2', title: 'Funda', stock: -1, price: 100, status: 'Activo' }
        ],
        phones: [{
            id: 'PH-1', brand: 'Apple', model: '15', storage: '128GB',
            condition: 'Nuevo', status: 'En Stock', currency: 'ARS', price: 1000
        }],
        sales: [
            {
                id: 'TK-1', status: 'Confirmada',
                items: [{ id: 'ACC-1', quantity: 1, price: 250.5 }],
                subtotal: 250.5, total: 250.5, paymentMethod: 'Efectivo'
            },
            {
                id: 'TK-2', status: 'Confirmada', items: [],
                subtotal: 0, total: 0, paymentMethod: 'Transferencia'
            }
        ]
    };
    const original = structuredClone(state);
    const plan = planMigration(state);

    assert.deepEqual(state, original);
    assert.deepEqual(plan.inventory.map(item => item.id), ['ACC-1', 'PH-1']);
    assert.equal(plan.inventory[0].data.priceCents, 25050);
    assert.equal(plan.inventory[1].data.type, 'phone');
    assert.equal(plan.skippedInventory, 1);
    assert.deepEqual(plan.legacySales.map(sale => sale.legacyTicketId), ['TK-1']);
    assert.equal(plan.legacySales[0].data.total, 250.5);
    assert.equal(plan.skippedSales, 1);
    assert.match(plan.legacySales[0].id, /^[a-f0-9]{64}$/);
    assert.equal(plan.legacySales[0].id, planMigration(state).legacySales[0].id);
    assert.match(migrationSourceHash(state), /^[a-f0-9]{64}$/);
});

test('exige proyecto y confirmación de congelamiento para habilitar escrituras', () => {
    assert.throws(() => parseArguments([]), /--project/);
    assert.throws(() => parseArguments(['--project', 'demo', '--apply']), /--confirm-legacy-freeze/);
    assert.throws(() => parseArguments([
        '--project', 'demo', '--apply', '--confirm-legacy-freeze', 'otro'
    ]), /--confirm-legacy-freeze/);
    assert.deepEqual(parseArguments([
        '--project', 'demo', '--apply', '--confirm-legacy-freeze', 'demo'
    ]), { apply: true, project: 'demo', confirmedFrozenProject: 'demo' });
});

test('migra artículos y archiva tickets limpiamente, sin alterar el origen, e idempotentemente', async () => {
    const state = {
        products: [
            { id: 'ACC-1', title: 'Cable', stock: 2, price: 250.5, status: 'Activo' },
            { id: 'ACC-2', title: 'Funda', stock: -1, price: 100, status: 'Activo' }
        ],
        phones: [],
        sales: [
            {
                id: 'TK-1', status: 'Confirmada',
                items: [{ id: 'ACC-1', quantity: 1, price: 250.5 }],
                subtotal: 250.5, total: 250.5, paymentMethod: 'Efectivo'
            },
            {
                id: 'TK-2', status: 'Confirmada', items: [],
                subtotal: 0, total: 0, paymentMethod: 'Transferencia'
            }
        ]
    };
    const original = structuredClone(state);
    const plan = planMigration(state);
    const db = new MigrationFirestore([['app_state/main', state]]);

    const result = await migrate(db, 'demo', state, plan);
    const sourceHash = migrationSourceHash(state);
    const archivedSalePath = `secure_legacy_sales/${plan.legacySales[0].id}`;

    assert.equal(result.inventoryCreated, 1);
    assert.equal(result.legacySalesArchived, 1);
    assert.equal(result.inventorySkipped, 1);
    assert.equal(result.salesSkipped, 1);
    assert.equal(db.documents.get('secure_inventory/ACC-1').priceCents, 25050);
    assert.equal(db.documents.get('secure_inventory/ACC-1').migrationSourceHash, sourceHash);
    assert.equal(db.documents.get(archivedSalePath).legacyTicketId, 'TK-1');
    assert.equal(db.documents.get('secure_migrations/legacy_app_state_main').sourceHash, sourceHash);
    assert.deepEqual(db.documents.get('app_state/main'), original);

    const retry = await migrate(db, 'demo', state, plan);
    assert.equal(retry.alreadyMigrated, true);
    assert.equal(db.documents.size, 5);
});

test('detiene la migración si un artículo seguro existente difiere', async () => {
    const state = {
        products: [{ id: 'ACC-1', title: 'Cable', stock: 1, price: 100, status: 'Activo' }],
        phones: [],
        sales: []
    };
    const db = new MigrationFirestore([
        ['app_state/main', state],
        ['secure_inventory/ACC-1', { id: 'ACC-1', name: 'Otro artículo', type: 'acc', active: true, stock: 1, priceCents: 10000 }]
    ]);

    await assert.rejects(migrate(db, 'demo', state, planMigration(state)), /Conflicto en secure_inventory/);
    assert.equal(db.documents.has('secure_migrations/legacy_app_state_main'), false);
    assert.equal(db.documents.get('secure_inventory/ACC-1').name, 'Otro artículo');
});
