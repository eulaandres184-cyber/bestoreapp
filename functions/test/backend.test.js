'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const domain = require('../domain');

function fixture(options = {}) {
    const data = new Map([
        ['users/admin', { active: true, role: 'admin' }],
        ['users/seller', { active: true, role: 'seller', nick: 'Vendedor' }],
        ['secure_inventory/A', { active: true, name: 'Cable', type: 'acc', stock: 1, priceCents: 100000 }],
        ['secure_registers/cash', { open: true, sessionId: 'session', balanceCents: 0 }],
        ['secure_register_sessions/session', { open: true, balanceCents: 0 }]
    ]);
    const claims = new Map();
    const passwords = new Map();
    let serial = Promise.resolve();
    let nextId = 0;
    const doc = path => ({
        path,
        id: path.split('/').pop(),
        get: async () => ({ exists: data.has(path), data: () => structuredClone(data.get(path)) }),
        update: async value => {
            if (options.failAuditUpdate && path.startsWith('secure_password_changes/')) throw new Error('Audit unavailable');
            if (!data.has(path)) throw new Error('Missing document');
            data.set(path, { ...data.get(path), ...value });
        }
    });
    const auth = {
        getUser: async uid => ({ uid, disabled: false, customClaims: claims.get(uid) || {} }),
        setCustomUserClaims: async (uid, value) => claims.set(uid, value),
        revokeRefreshTokens: async () => {},
        updateUser: async (uid, values) => { passwords.set(uid, values.password); }
    };
    const db = {
        doc,
        collection: name => ({
            collectionName: name,
            doc: id => doc(`${name}/${id || `auto${++nextId}`}`),
            get: async () => ({
                docs: [...data.entries()]
                    .filter(([key]) => key.startsWith(`${name}/`))
                    .map(([key, value]) => ({
                        id: key.slice(name.length + 1),
                        data: () => structuredClone(value)
                    }))
            })
        }),
        runTransaction(fn) {
            const execution = serial.then(async () => {
                const writes = [];
                const tx = {
                    get: async ref => ref.collectionName
                        ? { docs: [...data.entries()].filter(([key]) => key.startsWith(`${ref.collectionName}/`))
                            .map(([key, value]) => ({ id: key.slice(ref.collectionName.length + 1), data: () => structuredClone(value) })) }
                        : ({ exists: data.has(ref.path), data: () => structuredClone(data.get(ref.path)) }),
                    create: (ref, value) => writes.push(['create', ref, value]),
                    set: (ref, value) => writes.push(['set', ref, value]),
                    update: (ref, value) => writes.push(['update', ref, value]),
                    delete: ref => writes.push(['delete', ref])
                };
                const result = await fn(tx);
                for (const [action, ref, value] of writes) {
                    if (action === 'create' && data.has(ref.path)) throw new Error('Already exists');
                    if (action === 'update' && !data.has(ref.path)) throw new Error('Missing document');
                    if (action === 'delete') data.delete(ref.path);
                    else data.set(ref.path, action === 'update' ? { ...data.get(ref.path), ...value } : value);
                }
                return result;
            });
            serial = execution.catch(() => {});
            return execution;
        }
    };
    class HttpsError extends Error {
        constructor(code, message) { super(message); this.code = code; }
    }
    const context = {
        exports: {},
        console,
        require(name) {
            if (name === 'firebase-admin/app') return { initializeApp() {} };
            if (name === 'firebase-admin/auth') return { getAuth: () => auth };
            if (name === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'timestamp' } };
            if (name === 'firebase-functions/v2/https') return { onCall: (_, fn) => fn, HttpsError };
            if (name === './domain') return domain;
            if (name === './migration') return require('../migration');
            if (name === './sales-summary') return require('../sales-summary');
            return require(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'), context);
    const request = (uid, role, payload) => ({ auth: { uid, token: { bestoreRole: role } }, data: payload });
    return { data, api: context.exports, request, claims, passwords, auth };
}

const operationId = 'c0ffcccc-2222-4333-8444-555555555555';
const payload = { operationId, items: [{ id: 'A', quantity: 1 }], payment: { cashCents: 100000, transferCents: 0, cardBaseCents: 0 } };

test('solo BeStore puede modificar la clave de otro usuario y se registra sin guardar la clave', async () => {
    const { data, api, request, passwords } = fixture();
    const uid = '67V2bdleU2bZaazTtoZUvafJTsL2';
    data.set(`users/${uid}`, { active: true, role: 'admin' });
    await assert.rejects(api.setUserPassword(request('admin', 'admin', { uid: 'seller', password: 'clave123' })), error => error.code === 'permission-denied');
    await assert.rejects(api.setUserPassword(request(uid, 'admin', { uid, password: 'clave123' })), error => error.code === 'invalid-argument');
    await assert.rejects(api.setUserPassword(request(uid, 'admin', { uid: 'seller', password: 'corta' })), error => error.code === 'invalid-argument');
    await api.setUserPassword(request(uid, 'admin', { uid: 'seller', password: 'clave123' }));
    assert.equal(passwords.get('seller'), 'clave123');
    await api.setUserPassword(request(uid, 'admin', { uid: 'admin', password: 'clave456' }));
    assert.equal(passwords.get('admin'), 'clave456');
    const audit = [...data.entries()].find(([key]) => key.startsWith('secure_password_changes/'))[1];
    assert.equal(audit.status, 'applied');
    assert.equal(JSON.stringify(audit).includes('clave123'), false);
    await assert.rejects(api.setUserRole(request('admin', 'admin', { uid, role: 'seller' })), error => error.code === 'permission-denied');
});

test('el cambio de clave informa los errores de Firebase sin revelar la clave', async () => {
    const { data, api, request, auth } = fixture();
    const uid = '67V2bdleU2bZaazTtoZUvafJTsL2';
    data.set(`users/${uid}`, { active: true, role: 'admin' });
    auth.updateUser = async () => { throw Object.assign(new Error('rejected'), { code: 'auth/invalid-password' }); };
    await assert.rejects(api.setUserPassword(request(uid, 'admin', { uid: 'seller', password: 'clave123' })),
        error => error.code === 'failed-precondition' && /Firebase rechazó la clave/.test(error.message));
    const audit = [...data.entries()].find(([key]) => key.startsWith('secure_password_changes/'))[1];
    assert.equal(audit.status, 'pending');
    assert.equal(JSON.stringify(audit).includes('clave123'), false);
});

test('si falla la revocación indica que la clave ya cambió y no asegura cierre de sesión', async () => {
    const { data, api, request, auth, passwords } = fixture();
    const uid = '67V2bdleU2bZaazTtoZUvafJTsL2';
    data.set(`users/${uid}`, { active: true, role: 'admin' });
    auth.revokeRefreshTokens = async () => { throw Object.assign(new Error('failure'), { code: 'auth/internal-error' }); };
    await assert.rejects(api.setUserPassword(request(uid, 'admin', { uid: 'admin', password: 'clave123' })),
        error => error.code === 'internal' && /clave nueva ya fue aplicada/.test(error.message) && /sesiones anteriores/.test(error.message));
    assert.equal(passwords.get('admin'), 'clave123');
    const audit = [...data.entries()].find(([key]) => key.startsWith('secure_password_changes/'))[1];
    assert.equal(audit.status, 'pending');
});

test('si falla la auditoría final informa que la clave y revocación sí se aplicaron', async () => {
    const { data, api, request, passwords } = fixture({ failAuditUpdate: true });
    const uid = '67V2bdleU2bZaazTtoZUvafJTsL2';
    data.set(`users/${uid}`, { active: true, role: 'admin' });
    await assert.rejects(api.setUserPassword(request(uid, 'admin', { uid: 'seller', password: 'clave123' })),
        error => error.code === 'internal' && /clave nueva ya fue aplicada/.test(error.message) && /auditoría/.test(error.message));
    assert.equal(passwords.get('seller'), 'clave123');
});

test('la devolución está exportada al iniciar el backend', () => {
    const { api } = fixture();
    assert.equal(typeof api.recordReturn, 'function');
});

test('la corrección administrativa actualiza stock, caja e historial una sola vez', async () => {
    const { data, api, request } = fixture();
    const recorded = await api.recordSale(request('seller', 'seller', payload));
    data.set('app_state/main', {
        products: [{ id: 'A', stock: 0, status: 'Anulado' }], phones: [],
        sales: [{ id: recorded.ticketId, backendTicketId: recorded.ticketId, items: [{ id: 'A', type: 'acc' }], status: 'Confirmada' }]
    });
    const edit = {
        ticketId: recorded.ticketId, operationId: 'c0ffcccc-2222-4333-8444-555555555556', revision: 0,
        reason: 'Corrección de precio', items: [{ id: 'A', quantity: 1, priceCents: 50000 }],
        payment: { cashCents: 50000, transferCents: 0, cardBaseCents: 0 }
    };
    await assert.rejects(api.editSale(request('seller', 'seller', edit)), error => error.code === 'permission-denied');
    const result = await api.editSale(request('admin', 'admin', edit));
    assert.equal(result.totalCents, 50000);
    assert.equal(data.get('secure_inventory/A').priceCents, 100000);
    assert.equal(data.get('secure_registers/cash').balanceCents, 50000);
    assert.equal(data.get('app_state/main').sales[0].total, 500);
    assert.equal(data.get('app_state/main').salesRevision, 1);
    const after = structuredClone([...data.entries()]);
    await api.editSale(request('admin', 'admin', edit));
    assert.deepEqual(structuredClone([...data.entries()]), after);
    await assert.rejects(api.editSale(request('admin', 'admin', { ...edit, operationId: 'c0ffcccc-2222-4333-8444-555555555557' })), error => error.code === 'failed-precondition');
    await assert.rejects(api.recordSale(request('seller', 'seller', payload)), error => error.code === 'failed-precondition');
});

test('eliminar un producto no borra el detalle vendido y permite corregir su precio histórico', async () => {
    const { data, api, request } = fixture();
    const recorded = await api.recordSale(request('seller', 'seller', payload));
    await api.saveInventoryItem(request('admin', 'admin', {
        id: 'A', name: 'Cable', type: 'acc', active: false, stock: 0, priceCents: 150000
    }));
    assert.equal(data.get(`secure_sales/${recorded.ticketId}`).items[0].unitPriceCents, 100000);
    const historySale = {
        id: recorded.ticketId,
        backendTicketId: recorded.ticketId,
        status: 'Confirmada',
        items: recorded.items.map(item => ({
            id: item.id, type: item.type, quantity: item.quantity,
            title: item.name, price: item.unitPriceCents / 100
        })),
        total: recorded.totalCents / 100
    };
    data.set('app_state/main', {
        products: [{ id: 'A', stock: 0, status: 'Anulado' }], phones: [],
        sales: [historySale]
    });
    const originalHistory = structuredClone(historySale);

    await api.deleteInventoryItem(request('admin', 'admin', { id: 'A' }));

    assert.equal(data.has('secure_inventory/A'), false);
    assert.deepEqual(data.get('app_state/main').products, []);
    assert.deepEqual(data.get('app_state/main').sales[0], originalHistory);
    assert.equal(data.get(`secure_sales/${recorded.ticketId}`).items[0].unitPriceCents, 100000);
    const audit = [...data.entries()].find(([key, value]) =>
        key.startsWith('secure_inventory_audit/') && value.after === null)?.[1];
    assert.ok(audit);

    const edit = {
        ticketId: recorded.ticketId, operationId: 'c0ffcccc-2222-4333-8444-555555555561', revision: 0,
        reason: 'Se ingresó otro precio en la venta', items: [{ id: 'A', quantity: 1, priceCents: 50000 }],
        payment: { cashCents: 50000, transferCents: 0, cardBaseCents: 0 }
    };
    await api.editSale(request('admin', 'admin', edit));
    assert.equal(data.has('secure_inventory/A'), false);
    assert.equal(data.get(`secure_sales/${recorded.ticketId}`).items[0].unitPriceCents, 50000);
    assert.equal(data.get('app_state/main').sales[0].items[0].price, 500);
});

test('la corrección rechaza devoluciones, saldo insuficiente y stock insuficiente sin escribir', async () => {
    const { data, api, request } = fixture();
    const recorded = await api.recordSale(request('seller', 'seller', payload));
    data.set('app_state/main', {
        products: [{ id: 'A', stock: 0 }], phones: [],
        sales: [{ id: recorded.ticketId, backendTicketId: recorded.ticketId, items: [{ id: 'A', type: 'acc' }] }]
    });
    const edit = {
        ticketId: recorded.ticketId, operationId: 'c0ffcccc-2222-4333-8444-555555555556', revision: 0,
        reason: 'Corrección', items: [{ id: 'A', quantity: 1, priceCents: 50000 }],
        payment: { cashCents: 50000, transferCents: 0, cardBaseCents: 0 }
    };
    data.set('secure_registers/cash', { open: true, sessionId: 'session', balanceCents: 0 });
    let before = structuredClone([...data.entries()]);
    await assert.rejects(api.editSale(request('admin', 'admin', edit)), error => error.code === 'failed-precondition');
    assert.deepEqual(structuredClone([...data.entries()]), before);
    data.set('secure_registers/cash', { open: true, sessionId: 'session', balanceCents: 100000 });
    before = structuredClone([...data.entries()]);
    await assert.rejects(api.editSale(request('admin', 'admin', { ...edit, items: [{ id: 'A', quantity: 2, priceCents: 50000 }], payment: payload.payment })), error => error.code === 'failed-precondition');
    assert.deepEqual(structuredClone([...data.entries()]), before);
    data.set(`secure_sales/${recorded.ticketId}`, { ...data.get(`secure_sales/${recorded.ticketId}`), returnedQuantities: { A: 1 } });
    before = structuredClone([...data.entries()]);
    await assert.rejects(api.editSale(request('admin', 'admin', edit)), error => error.code === 'failed-precondition');
    assert.deepEqual(structuredClone([...data.entries()]), before);
});

test('solo un administrador puede consultar la vista previa y no modifica datos', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { products: [], phones: [], sales: [] });
    await assert.rejects(api.previewLegacyMigration(request('seller', 'seller', {})), error => error.code === 'permission-denied');
    const before = structuredClone([...data.entries()]);
    const result = await api.previewLegacyMigration(request('admin', 'admin', {}));
    assert.equal(result.inventory.length, 0);
    assert.deepEqual([...data.entries()], before);
});

test('el resumen de ventas requiere usuario autorizado y no modifica datos', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { sales: [] });
    const before = structuredClone([...data.entries()]);
    await assert.rejects(api.getSalesSummary(request('seller', 'admin', {})), error => error.code === 'permission-denied');
    const summary = await api.getSalesSummary(request('seller', 'seller', {}));
    assert.deepEqual(summary, { todayCount: 0, todayCents: 0, totalCount: 0, netCents: 0 });
    assert.deepEqual([...data.entries()], before);
});

test('la vista previa distingue celulares USD conciliados de precios o inventario discordantes', async () => {
    const { data, api, request } = fixture();
    const phone = id => ({ id, brand: 'Apple', model: '15', storage: '128GB', condition: 'Nuevo', currency: 'USD', priceUsd: 480, price: 763200, status: 'En Stock' });
    data.set('app_state/main', { products: [], phones: [phone('PH-1'), phone('PH-2'), phone('PH-3')], sales: [], dailyDollarRate: 1590 });
    data.set('secure_inventory/PH-1', { name: 'Apple 15 128GB Nuevo', type: 'phone', active: true, stock: 1, priceCents: 76320000 });
    data.set('secure_inventory/PH-2', { name: 'Apple 15 128GB Nuevo', type: 'phone', active: true, stock: 1, priceCents: 70000000 });
    const before = structuredClone([...data.entries()]);
    const preview = await api.previewLegacyMigration(request('admin', 'admin', {}));
    assert.equal(preview.inventoryIssues, 2);
    assert.equal(preview.inventory[0].issues.length, 0);
    assert.match(preview.inventory[1].issues.join(), /USD/);
    assert.match(preview.inventory[2].issues.join(), /USD/);
    assert.deepEqual([...data.entries()], before);
});

test('la cotización actualiza solo celulares USD de forma atómica y conserva ventas y stock', async () => {
    const { data, api, request } = fixture();
    const usd = { id: 'PH-1', brand: 'Apple', model: '15', status: 'En Stock', currency: 'USD', priceUsd: 480, price: 763200 };
    const ars = { id: 'PH-2', brand: 'Apple', model: '14', status: 'En Stock', currency: 'ARS', price: 1000 };
    data.set('app_state/main', { phones: [usd, ars], products: [{ id: 'A', currency: 'USD', price: 300 }], sales: [{ total: 763200 }], dailyDollarRate: 1590 });
    data.set('secure_inventory/PH-1', { name: 'Apple 15', type: 'phone', active: true, stock: 1, priceCents: 76320000 });
    data.set('secure_inventory/PH-2', { name: 'Apple 14', type: 'phone', active: true, stock: 1, priceCents: 100000 });
    data.set('secure_sales/old', { items: [{ id: 'PH-1', unitPriceCents: 76320000 }] });
    await assert.rejects(api.updateDollarRate(request('seller', 'seller', { rate: 1700 })), error => error.code === 'permission-denied');
    await api.updateDollarRate(request('admin', 'admin', { rate: 1700 }));
    assert.equal(data.get('secure_inventory/PH-1').priceCents, 81600000);
    assert.equal(data.get('secure_inventory/PH-1').stock, 1);
    assert.equal(data.get('secure_inventory/PH-2').priceCents, 100000);
    assert.equal(data.get('secure_inventory/A').priceCents, 100000);
    assert.equal(data.get('app_state/main').phones[0].price, 816000);
    assert.equal(data.get('app_state/main').sales[0].total, 763200);
    assert.equal(data.get('secure_sales/old').items[0].unitPriceCents, 76320000);
    assert.equal([...data.keys()].filter(key => key.startsWith('secure_inventory_audit/')).length, 1);

    data.get('app_state/main').phones.push({ ...usd, id: 'PH-MISSING' });
    const before = JSON.stringify([...data.entries()]);
    await assert.rejects(api.updateDollarRate(request('admin', 'admin', { rate: 1800 })), error => error.code === 'failed-precondition');
    assert.equal(JSON.stringify([...data.entries()]), before);
});

test('el límite de actualización atómica admite 200 celulares y rechaza 201 sin escribir', async () => {
    const { data, api, request } = fixture();
    const phones = Array.from({ length: 201 }, (_, index) => ({
        id: `PH-${index}`, currency: 'USD', priceUsd: 1, price: 1590, status: 'En Stock'
    }));
    data.set('app_state/main', { phones: phones.slice(0, 200), dailyDollarRate: 1590 });
    phones.forEach(phone => data.set(`secure_inventory/${phone.id}`, {
        name: phone.id, type: 'phone', stock: 1, active: true, priceCents: 159000
    }));
    const result = await api.updateDollarRate(request('admin', 'admin', { rate: 1700 }));
    assert.equal(result.updated, 200);
    assert.equal(data.get('secure_inventory/PH-199').priceCents, 170000);
    data.get('app_state/main').phones.push(phones[200]);
    const before = JSON.stringify([...data.entries()]);
    await assert.rejects(api.updateDollarRate(request('admin', 'admin', { rate: 1800 })), error => error.code === 'failed-precondition');
    assert.equal(JSON.stringify([...data.entries()]), before);
});

test('una cotización de celular conserva el precio, es personal y se usa una sola vez', async () => {
    const { data, api, request } = fixture();
    const quoteId = 'c0ffcccc-2222-4333-8444-555555555500';
    const phone = { id: 'PH-1', brand: 'Apple', model: '15', status: 'En Stock', currency: 'USD', priceUsd: 480, price: 763200 };
    data.set('app_state/main', { phones: [phone], products: [], sales: [], dailyDollarRate: 1590 });
    data.set('secure_inventory/PH-1', { name: 'Apple 15', type: 'phone', active: true, stock: 1, priceCents: 76320000 });
    const quoted = await api.quotePhone(request('seller', 'seller', { id: 'PH-1', quoteId }));
    assert.equal(quoted.priceCents, 76320000);
    await api.updateDollarRate(request('admin', 'admin', { rate: 1700 }));
    assert.equal(data.get('secure_inventory/PH-1').priceCents, 81600000);
    const saleRequest = {
        operationId,
        items: [{ id: 'PH-1', quantity: 1, quoteId, priceCents: 1 }],
        payment: { cashCents: 76320000, transferCents: 0, cardBaseCents: 0 }
    };
    await assert.rejects(api.recordSale(request('admin', 'admin', saleRequest)), error => error.code === 'failed-precondition');
    const sale = await api.recordSale(request('seller', 'seller', saleRequest));
    assert.equal(sale.items[0].unitPriceCents, 76320000);
    assert.equal((await api.recordSale(request('seller', 'seller', saleRequest))).ticketId, sale.ticketId);
    assert.equal(data.get(`secure_phone_quotes/${quoteId}`).status, 'used');
    await assert.rejects(api.cancelPhoneQuotes(request('seller', 'seller', { quoteIds: [quoteId] })), error => error.code === 'failed-precondition');
    data.get('secure_inventory/PH-1').stock = 1;
    await assert.rejects(api.recordSale(request('seller', 'seller', {
        ...saleRequest, operationId: 'c0ffcccc-2222-4333-8444-555555555502'
    })), error => error.code === 'failed-precondition');
    assert.equal(data.get(`secure_sales/${sale.ticketId}`).items[0].unitPriceCents, 76320000);
});

test('cancelar una cotización impide utilizarla y no permite cancelar cotizaciones ajenas', async () => {
    const { data, api, request } = fixture();
    const quoteId = 'c0ffcccc-2222-4333-8444-555555555501';
    data.set('secure_inventory/PH-1', { name: 'Celular', type: 'phone', active: true, stock: 1, priceCents: 100000 });
    await api.quotePhone(request('seller', 'seller', { id: 'PH-1', quoteId }));
    await assert.rejects(api.cancelPhoneQuotes(request('admin', 'admin', { quoteIds: [quoteId] })), error => error.code === 'failed-precondition');
    await api.cancelPhoneQuotes(request('seller', 'seller', { quoteIds: [quoteId] }));
    await api.cancelPhoneQuotes(request('seller', 'seller', { quoteIds: [quoteId] }));
    await assert.rejects(api.recordSale(request('seller', 'seller', {
        ...payload, items: [{ id: 'PH-1', quantity: 1, quoteId }]
    })), error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_inventory/PH-1').stock, 1);
});

test('no se guarda un celular USD con una cotización desactualizada', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { dailyDollarRate: 1700, phones: [{ id: 'PH-1', currency: 'USD' }] });
    data.set('secure_inventory/PH-1', { name: 'Celular', type: 'phone', active: true, stock: 1, priceCents: 81600000 });
    const item = { id: 'PH-1', name: 'Celular', type: 'phone', active: true, stock: 1, currency: 'USD', priceUsd: 480, expectedDollarRate: 1590, priceCents: 76320000 };
    await assert.rejects(api.saveInventoryItem(request('admin', 'admin', item)), error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_inventory/PH-1').priceCents, 81600000);
    await api.saveInventoryItem(request('admin', 'admin', { ...item, expectedDollarRate: 1700, priceCents: 81600000 }));
    assert.equal(data.get('secure_inventory/PH-1').priceCents, 81600000);
});

test('el catálogo y el estado de cajas se leen solo con una cuenta autorizada', async () => {
    const { data, api, request } = fixture();
    data.set('secure_registers/cash', { open: true, balanceCents: 15000, openingCents: 5000 });
    await assert.rejects(api.listInventory(request('desconocido', 'seller', {})), error => error.code === 'permission-denied');
    await assert.rejects(api.getRegisterStatus(request('seller', 'admin', {})), error => error.code === 'permission-denied');

    const inventory = await api.listInventory(request('seller', 'seller', {}));
    const registers = await api.getRegisterStatus(request('seller', 'seller', {}));
    assert.deepEqual(inventory.map(item => item.id), ['A']);
    assert.equal(registers.cash.balanceCents, 15000);
    assert.equal(registers.transfer.open, false);
    assert.equal(registers.card.balanceCents, 0);
});

test('el cambio de rol actualiza perfil y claim y no permite auto-degradar al administrador', async () => {
    const { data, api, request, claims } = fixture();
    const result = await api.setUserRole(request('admin', 'admin', { uid: 'seller', role: 'admin' }));
    assert.equal(result.role, 'admin');
    assert.equal(data.get('users/seller').role, 'admin');
    assert.equal(claims.get('seller').bestoreRole, 'admin');
    await assert.rejects(api.setUserRole(request('admin', 'admin', { uid: 'admin', role: 'seller' })), error => error.code === 'permission-denied');
});

test('venta atómica, reintento idempotente y conflicto de datos', async () => {
    const { data, api, request } = fixture();
    const req = request('seller', 'seller', payload);
    const first = await api.recordSale(req);
    const second = await api.recordSale(req);
    assert.equal(first.sellerName, 'Vendedor');
    assert.equal(data.get(`secure_sales/${first.ticketId}`).sellerName, 'Vendedor');
    data.get('users/seller').nick = 'Otro nombre';
    assert.equal((await api.recordSale(req)).sellerName, 'Vendedor');
    assert.equal(first.ticketId, second.ticketId);
    assert.equal(first.items[0].stockAfter, 0);
    assert.equal(data.get('secure_inventory/A').stock, 0);
    assert.equal(data.get('secure_registers/cash').balanceCents, 100000);
    assert.equal([...data.keys()].filter(key => key.startsWith('secure_sales/')).length, 1);
    await assert.rejects(api.recordSale(request('seller', 'seller', { ...payload, customerName: 'Otro' })), error => error.code === 'already-exists');
});

test('los números de ticket son consecutivos, persistentes e idempotentes', async () => {
    const { data, api, request } = fixture();
    data.get('secure_inventory/A').stock = 2;
    const firstRequest = request('seller', 'seller', payload);
    const secondRequest = request('seller', 'seller', { ...payload, operationId: 'c0ffcccc-2222-4333-8444-555555555556' });
    const [first, second] = await Promise.all([api.recordSale(firstRequest), api.recordSale(secondRequest)]);
    assert.deepEqual([first.ticketNumber, second.ticketNumber].sort(), [1, 2]);
    assert.equal((await api.recordSale(firstRequest)).ticketNumber, first.ticketNumber);
    assert.equal(data.get(`secure_sales/${first.ticketId}`).ticketNumber, first.ticketNumber);
    assert.equal(data.get(`secure_sales/${first.ticketId}`).customerName, 'Consumidor Final');
    assert.equal(data.get('secure_counters/sale_tickets').lastTicketNumber, 2);
});

test('asigna números a ventas antiguas sin repetirlos al reintentar', async () => {
    const { data, api, request } = fixture();
    const id = '01234567-1234-4234-8234-012345678901';
    data.set('app_state/main', { sales: [{ id, status: 'Confirmada' }, { id: 'TK-123', status: 'Anulada' }] });
    data.set(`secure_sales/${id}`, { status: 'Confirmada' });
    const req = request('seller', 'seller', { saleIds: ['TK-123', id] });
    const first = await api.assignLegacyTicketNumbers(req);
    const retry = await api.assignLegacyTicketNumbers(req);
    assert.deepEqual(JSON.parse(JSON.stringify(first.numbers)), [
        { saleId: 'TK-123', ticketNumber: 1 }, { saleId: id, ticketNumber: 2 }
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(retry.numbers)), JSON.parse(JSON.stringify(first.numbers)));
    assert.equal(data.get(`secure_sales/${id}`).ticketNumber, 2);
    assert.equal(data.get('secure_counters/sale_tickets').lastTicketNumber, 2);
    const next = await api.recordSale(request('seller', 'seller', payload));
    assert.equal(next.ticketNumber, 3);
});

test('recuperar una operación antigua usa el número asignado a su venta', async () => {
    const { data, api, request } = fixture();
    const req = request('seller', 'seller', payload);
    const original = await api.recordSale(req);
    const operation = data.get(`secure_sale_operations/seller_${operationId}`);
    delete operation.result.ticketNumber;
    delete data.get(`secure_sales/${original.ticketId}`).ticketNumber;
    data.delete('secure_counters/sale_tickets');
    data.set('app_state/main', { sales: [{ id: original.ticketId, status: 'Confirmada' }] });
    const assigned = await api.assignLegacyTicketNumbers(request('seller', 'seller', { saleIds: [original.ticketId] }));
    const retried = await api.recordSale(req);
    assert.equal(retried.ticketNumber, assigned.numbers[0].ticketNumber);
    assert.equal(data.get('secure_counters/sale_tickets').lastTicketNumber, 1);
    assert.equal(operation.result.ticketNumber, undefined);
    assert.equal(data.get(`secure_sale_operations/seller_${operationId}`).result.ticketNumber, 1);
});

test('la secuencia de ventas continúa después de 9999', async () => {
    const { data, api, request } = fixture();
    data.set('secure_counters/sale_tickets', { lastTicketNumber: 9998 });
    data.get('secure_inventory/A').stock = 2;
    const first = await api.recordSale(request('seller', 'seller', payload));
    const second = await api.recordSale(request('seller', 'seller', { ...payload, operationId: 'c0ffcccc-2222-4333-8444-555555555556' }));
    assert.equal(first.ticketNumber, 9999);
    assert.equal(second.ticketNumber, 10000);
    assert.equal(data.get('secure_counters/sale_tickets').lastTicketNumber, 10000);
});

test('no numera ventas ajenas al historial compartido', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { sales: [] });
    await assert.rejects(api.assignLegacyTicketNumbers(request('seller', 'seller', { saleIds: ['inexistente'] })),
        error => error.code === 'failed-precondition');
    assert.equal(data.has('secure_counters/sale_tickets'), false);
});

test('un contador inválido impide registrar la venta', async () => {
    const { data, api, request } = fixture();
    data.set('secure_counters/sale_tickets', { lastTicketNumber: -1 });
    await assert.rejects(api.recordSale(request('seller', 'seller', payload)), error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_inventory/A').stock, 1);
    assert.equal([...data.keys()].filter(key => key.startsWith('secure_sales/')).length, 0);
});

test('dos ventas simultáneas no venden la misma unidad', async () => {
    const { data, api, request } = fixture();
    const requests = [payload, { ...payload, operationId: 'c0ffcccc-2222-4333-8444-555555555556' }];
    const results = await Promise.allSettled(requests.map(value => api.recordSale(request('seller', 'seller', value))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(data.get('secure_inventory/A').stock, 0);
    assert.equal(data.get('secure_registers/cash').balanceCents, 100000);
});

test('rechaza roles falsos, usuarios inactivos y cajas cerradas sin modificar stock', async () => {
    const { data, api, request } = fixture();
    await assert.rejects(api.recordSale(request('seller', 'admin', payload)), error => error.code === 'permission-denied');
    data.get('users/seller').active = false;
    await assert.rejects(api.recordSale(request('seller', 'seller', payload)), error => error.code === 'permission-denied');
    data.get('users/seller').active = true;
    data.get('secure_registers/cash').open = false;
    await assert.rejects(api.recordSale(request('seller', 'seller', payload)), error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_inventory/A').stock, 1);
});

test('solo un administrador abre y cierra las tres cajas de forma conjunta', async () => {
    const { data, api, request } = fixture();
    for (const medium of ['cash', 'transfer', 'card']) {
        const register = data.get(`secure_registers/${medium}`) || {};
        data.set(`secure_registers/${medium}`, { ...register, open: false });
    }

    const openingCentsByMedium = { cash: 500, transfer: 200, card: 100 };
    await assert.rejects(
        api.openAllRegisters(request('seller', 'seller', { openingCentsByMedium })),
        error => error.code === 'permission-denied'
    );
    const opened = await api.openAllRegisters(request('admin', 'admin', { openingCentsByMedium }));
    for (const medium of ['cash', 'transfer', 'card']) {
        const register = data.get(`secure_registers/${medium}`);
        assert.equal(register.open, true);
        assert.equal(register.balanceCents, openingCentsByMedium[medium]);
        assert.equal(register.sessionId, opened.sessionIds[medium]);
        assert.equal(data.get(`secure_register_sessions/${register.sessionId}`).open, true);
    }

    const countedCentsByMedium = { cash: 550, transfer: 180, card: 100 };
    await assert.rejects(
        api.closeAllRegisters(request('seller', 'seller', { countedCentsByMedium })),
        error => error.code === 'permission-denied'
    );
    const closed = await api.closeAllRegisters(request('admin', 'admin', { countedCentsByMedium }));
    assert.equal(JSON.stringify(closed.differences), JSON.stringify({ cash: 50, transfer: -20, card: 0 }));
    for (const medium of ['cash', 'transfer', 'card']) {
        const register = data.get(`secure_registers/${medium}`);
        assert.equal(register.open, false);
        assert.equal(register.countedCents, countedCentsByMedium[medium]);
        assert.equal(data.get(`secure_register_sessions/${register.sessionId}`).open, false);
    }
});

test('pago extra en efectivo descuenta caja y sesión y no se duplica al reintentar', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { suppliers: [{ id: 'SUP-1', name: 'Proveedor Uno' }] });
    data.set('secure_registers/cash', { open: true, sessionId: 'cash-payment-session', balanceCents: 5000 });
    data.set('secure_register_sessions/cash-payment-session', {
        open: true, medium: 'cash', balanceCents: 5000
    });
    const payment = {
        operationId: 'c0ffcccc-2222-4333-8444-555555555560',
        supplierId: 'SUP-1', payeeName: '', amountCents: 1500, medium: 'cash', note: 'Flete'
    };

    await assert.rejects(api.recordSupplierPayment(request('seller', 'seller', payment)),
        error => error.code === 'permission-denied');
    const result = await api.recordSupplierPayment(request('admin', 'admin', payment));
    const retry = await api.recordSupplierPayment(request('admin', 'admin', payment));
    assert.equal(result.paymentId, retry.paymentId);
    assert.equal(result.amountCents, retry.amountCents);
    assert.equal(result.payeeName, 'Proveedor Uno');
    assert.equal(data.get('secure_registers/cash').balanceCents, 3500);
    assert.equal(data.get('secure_register_sessions/cash-payment-session').balanceCents, 3500);
    assert.equal([...data.keys()].filter(key => key.startsWith('secure_supplier_payments/')).length, 1);
    const movement = [...data.entries()].find(([key]) => key.startsWith('secure_cash_movements/'))[1];
    assert.equal(movement.amountCents, -1500);
    assert.equal(movement.supplierPaymentId, result.paymentId);
    await assert.rejects(api.recordSupplierPayment(request('admin', 'admin', {
        ...payment, amountCents: 2000
    })), error => error.code === 'already-exists');
    assert.equal(data.get('secure_registers/cash').balanceCents, 3500);
});

test('pago extra por transferencia admite destinatario libre e historial solo para administradores', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { suppliers: [] });
    data.set('secure_registers/transfer', { open: true, sessionId: 'transfer-payment-session', balanceCents: 4000 });
    data.set('secure_register_sessions/transfer-payment-session', {
        open: true, medium: 'transfer', balanceCents: 4000
    });
    const payment = {
        operationId: 'c0ffcccc-2222-4333-8444-555555555561',
        supplierId: null, payeeName: 'Técnico', amountCents: 2500, medium: 'transfer', note: ''
    };

    const result = await api.recordSupplierPayment(request('admin', 'admin', payment));
    assert.equal(result.payeeName, 'Técnico');
    assert.equal(data.get('secure_registers/transfer').balanceCents, 1500);
    assert.equal(data.get('secure_register_sessions/transfer-payment-session').balanceCents, 1500);
    const history = await api.listSupplierPayments(request('admin', 'admin'));
    assert.equal(history.length, 1);
    assert.equal(history[0].payeeName, 'Técnico');
    assert.equal(history[0].medium, 'transfer');
    await assert.rejects(api.listSupplierPayments(request('seller', 'seller')), error => error.code === 'permission-denied');
});

test('pago extra falla de forma atómica si la caja está cerrada, no tiene saldo o la sesión no coincide', async () => {
    const { data, api, request } = fixture();
    data.set('app_state/main', { suppliers: [] });
    const payment = {
        operationId: 'c0ffcccc-2222-4333-8444-555555555562',
        payeeName: 'Destinatario', amountCents: 100, medium: 'cash', note: ''
    };

    data.get('secure_registers/cash').open = false;
    await assert.rejects(api.recordSupplierPayment(request('admin', 'admin', payment)),
        error => error.code === 'failed-precondition');
    data.get('secure_registers/cash').open = true;
    await assert.rejects(api.recordSupplierPayment(request('admin', 'admin', payment)),
        error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_registers/cash').balanceCents, 0);

    data.get('secure_registers/cash').balanceCents = 500;
    data.get('secure_register_sessions/session').medium = 'transfer';
    await assert.rejects(api.recordSupplierPayment(request('admin', 'admin', payment)),
        error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_registers/cash').balanceCents, 500);
    assert.equal(data.get('secure_register_sessions/session').balanceCents, 0);
    assert.equal([...data.keys()].filter(key => key.startsWith('secure_supplier_payments/')).length, 0);
    assert.equal([...data.keys()].filter(key => key.startsWith('secure_cash_movements/')).length, 0);
});

test('no abre por partes y permite cerrar juntas las cajas que aún estén abiertas', async () => {
    const { data, api, request } = fixture();
    const openingPayload = { openingCentsByMedium: { cash: 0, transfer: 0, card: 0 } };
    await assert.rejects(
        api.openAllRegisters(request('admin', 'admin', openingPayload)),
        error => error.code === 'failed-precondition'
    );
    assert.equal(data.get('secure_registers/cash').open, true);
    assert.equal(data.has('secure_registers/transfer'), false);
    assert.equal(data.has('secure_registers/card'), false);

    data.set('secure_registers/transfer', { open: true, sessionId: 'transfer-session', balanceCents: 10 });
    data.set('secure_register_sessions/transfer-session', { open: true, balanceCents: 10 });
    const closed = await api.closeAllRegisters(request('admin', 'admin', {
        countedCentsByMedium: { cash: 0, transfer: 10 }
    }));
    assert.equal(JSON.stringify(closed.closedMedia), JSON.stringify(['cash', 'transfer']));
    assert.equal(data.get('secure_registers/cash').open, false);
    assert.equal(data.get('secure_registers/transfer').open, false);
    assert.equal(data.has('secure_registers/card'), false);
});

test('no cierra ninguna caja si una sesión abierta no está disponible', async () => {
    const { data, api, request } = fixture();
    data.set('secure_registers/transfer', { open: true, sessionId: 'missing-session', balanceCents: 10 });
    await assert.rejects(
        api.closeAllRegisters(request('admin', 'admin', {
            countedCentsByMedium: { cash: 0, transfer: 10 }
        })),
        error => error.code === 'failed-precondition'
    );
    assert.equal(data.get('secure_registers/cash').open, true);
    assert.equal(data.get('secure_registers/transfer').open, true);
    assert.equal(data.get('secure_registers/cash').balanceCents, 0);
});

test('devolución repone opcionalmente, debita caja y es idempotente', async () => {
    const { data, api, request } = fixture();
    const sale = await api.recordSale(request('seller', 'seller', payload));
    const returnPayload = {
        operationId: 'c0ffcccc-2222-4333-8444-555555555557',
        ticketId: sale.ticketId,
        items: [{ id: 'A', quantity: 1, restock: true }],
        reason: 'Cambio', source: { cash: 100000, transfer: 0, cardToCash: 0, cardToTransfer: 0 }
    };
    await assert.rejects(api.recordReturn(request('seller', 'seller', returnPayload)), error => error.code === 'permission-denied');
    data.get('secure_inventory/A').active = false;
    const result = await api.recordReturn(request('admin', 'admin', returnPayload));
    const retry = await api.recordReturn(request('admin', 'admin', returnPayload));
    assert.equal(result.returnId, retry.returnId);
    assert.equal(data.get('secure_inventory/A').stock, 1);
    assert.equal(data.get('secure_inventory/A').active, true);
    assert.equal(data.get('secure_registers/cash').balanceCents, 0);
    await assert.rejects(api.recordReturn(request('admin', 'admin', { ...returnPayload, operationId: 'c0ffcccc-2222-4333-8444-555555555558' })), error => error.code === 'failed-precondition');
});

test('tarjeta reintegrada en transferencia, sin reponer producto averiado', async () => {
    const { data, api, request } = fixture();
    data.set('secure_registers/card', { open: true, sessionId: 'card-session', balanceCents: 0 });
    data.set('secure_register_sessions/card-session', { open: true, balanceCents: 0 });
    data.set('secure_registers/transfer', { open: true, sessionId: 'transfer-session', balanceCents: 200000 });
    data.set('secure_register_sessions/transfer-session', { open: true, balanceCents: 200000 });
    const cardSale = { ...payload, payment: { cashCents: 0, transferCents: 0, cardBaseCents: 100000, cardPlan: 'phone-pampa-4' } };
    const sale = await api.recordSale(request('seller', 'seller', cardSale));
    const returnPayload = {
        operationId: 'c0ffcccc-2222-4333-8444-555555555559', ticketId: sale.ticketId,
        items: [{ id: 'A', quantity: 1, restock: false }], reason: 'Falla',
        source: { cash: 0, transfer: 0, cardToCash: 0, cardToTransfer: 100000 }
    };
    data.get('secure_inventory/A').active = false;
    await api.recordReturn(request('admin', 'admin', returnPayload));
    assert.equal(data.get('secure_inventory/A').stock, 0);
    assert.equal(data.get('secure_inventory/A').active, false);
    assert.equal(data.get('secure_registers/transfer').balanceCents, 100000);
    assert.ok(data.get('secure_registers/card').balanceCents > 0);
});

test('devoluciones parciales mixtas no exceden lo pagado en cada medio', async () => {
    const { data, api, request } = fixture();
    data.get('secure_inventory/A').stock = 2;
    data.set('secure_registers/transfer', { open: true, sessionId: 'transfer-session', balanceCents: 0 });
    data.set('secure_register_sessions/transfer-session', { open: true, balanceCents: 0 });
    const sale = await api.recordSale(request('seller', 'seller', {
        ...payload, items: [{ id: 'A', quantity: 2 }],
        payment: { cashCents: 100000, transferCents: 100000, cardBaseCents: 0 }
    }));
    const partial = {
        operationId: 'c0ffcccc-2222-4333-8444-555555555560', ticketId: sale.ticketId,
        items: [{ id: 'A', quantity: 1, restock: false }], reason: 'Falla',
        source: { cash: 100000, transfer: 0, cardToCash: 0, cardToTransfer: 0 }
    };
    await api.recordReturn(request('admin', 'admin', partial));
    const second = { ...partial, operationId: 'c0ffcccc-2222-4333-8444-555555555561' };
    await assert.rejects(api.recordReturn(request('admin', 'admin', second)), error => error.code === 'failed-precondition');
    data.get('secure_registers/transfer').open = false;
    second.source = { cash: 0, transfer: 100000, cardToCash: 0, cardToTransfer: 0 };
    await assert.rejects(api.recordReturn(request('admin', 'admin', second)), error => error.code === 'failed-precondition');
    assert.equal(data.get('secure_sales/' + sale.ticketId).returnedQuantities.A, 1);
    data.get('secure_registers/transfer').open = true;
    await api.recordReturn(request('admin', 'admin', second));
    assert.equal(data.get('secure_registers/transfer').balanceCents, 0);
    assert.equal(data.get('secure_sales/' + sale.ticketId).returnedQuantities.A, 2);
});
