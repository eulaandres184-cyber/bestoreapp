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
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
    return result;
}

async function main() {
    const projectId = process.env.GCLOUD_PROJECT;
    assert.equal(projectId, 'demo-bestore');
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
    assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST);
    const app = initializeApp({ projectId });
    const db = getFirestore(app);
    const auth = getAuth(app);
    const authUrl = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts`;
    const credentials = { email: 'admin@example.test', password: 'emulator-password', returnSecureToken: true };
    const created = await post(`${authUrl}:signUp?key=test`, credentials);
    await db.doc(`users/${created.localId}`).set({ role: 'admin', active: true });
    await auth.setCustomUserClaims(created.localId, { bestoreRole: 'admin' });
    const login = await post(`${authUrl}:signInWithPassword?key=test`, credentials);
    const call = (id) => post(`http://127.0.0.1:5001/${projectId}/us-central1/deleteInventoryItem`,
        { data: { id } }, login.idToken);
    await db.doc('app_state/main').set({
        products: [{ id: 'A', title: 'Cable' }, { id: 'B', title: 'Funda' }],
        sales: [{ id: 'ticket', items: [{ id: 'A', title: 'Cable', price: 100 }] }]
    });
    for (const id of ['A', 'B']) {
        await db.doc(`secure_inventory/${id}`).set({ id, name: id, type: 'acc', active: true, stock: 1, priceCents: 10000 });
    }
    await db.doc('secure_customer_debts/unpaid').set({ itemIds: ['B'], lockedTotalCents: null });
    await assert.rejects(call('B'), /deudas cuyo precio/);
    assert.equal((await db.doc('secure_inventory/B').get()).exists, true);
    assert.equal((await call('A')).result.id, 'A');
    assert.equal((await db.doc('secure_inventory/A').get()).exists, false);
    const state = (await db.doc('app_state/main').get()).data();
    assert.deepEqual(state.products.map(item => item.id), ['B']);
    assert.equal(state.sales[0].items[0].title, 'Cable');
    const audit = await db.collection('secure_inventory_audit').where('itemId', '==', 'A').get();
    assert.equal(audit.size, 1);
    assert.equal(audit.docs[0].data().after, null);
    console.log('Eliminación, auditoría y protección de deuda verificadas.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
