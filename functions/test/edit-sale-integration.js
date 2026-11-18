'use strict';

const assert = require('node:assert/strict');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

async function post(url, body, token) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
}

async function main() {
    const project = process.env.GCLOUD_PROJECT;
    assert.equal(project, 'demo-bestore');
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
    const app = initializeApp({ projectId: project });
    const db = getFirestore(app);
    const auth = getAuth(app);
    const authUrl = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts`;
    const credentials = { email: 'edit-admin@example.test', password: 'edit-password', returnSecureToken: true };
    const user = await post(`${authUrl}:signUp?key=test`, credentials);
    await db.doc(`users/${user.localId}`).set({ role: 'admin', active: true, nick: 'Admin' });
    await auth.setCustomUserClaims(user.localId, { bestoreRole: 'admin' });
    const token = (await post(`${authUrl}:signInWithPassword?key=test`, credentials)).idToken;
    const call = async (name, data) => (await post(`http://127.0.0.1:5001/${project}/us-central1/${name}`, { data }, token)).result;

    await db.doc('app_state/main').set({ version: 2, products: [{ id: 'A', stock: 1, status: 'Activo' }], phones: [], sales: [] });
    await call('saveInventoryItem', { id: 'A', name: 'Cable', type: 'acc', active: true, stock: 1, priceCents: 100000 });
    await call('openAllRegisters', { openingCentsByMedium: { cash: 0, transfer: 0, card: 0 } });
    const sale = await call('recordSale', {
        operationId: '01234567-1234-4234-8234-012345678901', items: [{ id: 'A', quantity: 1 }],
        payment: { cashCents: 100000, transferCents: 0, cardBaseCents: 0 }
    });
    await db.doc('app_state/main').update({ sales: [{
        id: sale.ticketId, backendTicketId: sale.ticketId, ticketNumber: sale.ticketNumber,
        sellerName: sale.sellerName, status: 'Confirmada', items: [{ id: 'A', type: 'acc', quantity: 1, price: 1000 }]
    }] });
    const edit = {
        ticketId: sale.ticketId, operationId: '01234567-1234-4234-8234-012345678902', revision: 0,
        reason: 'Corrección de precio y medio', items: [{ id: 'A', quantity: 1, priceCents: 50000 }],
        payment: { cashCents: 0, transferCents: 50000, cardBaseCents: 0 }
    };
    await call('editSale', edit);
    await call('editSale', edit);
    const state = (await db.doc('app_state/main').get()).data();
    assert.equal(state.sales[0].total, 500);
    assert.equal(state.sales[0].sellerName, 'Admin');
    assert.equal(state.salesRevision, 1);
    assert.equal((await db.doc('secure_registers/cash').get()).data().balanceCents, 0);
    assert.equal((await db.doc('secure_registers/transfer').get()).data().balanceCents, 50000);
    assert.equal((await db.collection('secure_sale_edits').get()).size, 1);

    const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${project}/databases/(default)/documents/app_state/main`;
    const legacy = await fetch(`${url}?updateMask.fieldPaths=sales`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: { sales: { arrayValue: {} } } })
    });
    assert.equal(legacy.status, 403, 'un cliente antiguo no puede sobrescribir ventas corregidas');
    const modern = await fetch(`${url}?updateMask.fieldPaths=clientWriteId`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ fields: { clientWriteId: { stringValue: 'test-write' } } })
    });
    assert.equal(modern.status, 200);
    console.log('Integración de corrección y reglas completada.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
