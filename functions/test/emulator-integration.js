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

async function uploadProductImage(projectId, uid, token) {
    const url = `http://127.0.0.1:9199/v0/b/${projectId}.firebasestorage.app/o?uploadType=media&name=${encodeURIComponent(`product-images/${uid}/test.png`)}`;
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` },
        body: Buffer.from('test-image')
    });
}

async function main() {
    const projectId = process.env.GCLOUD_PROJECT;
    assert.equal(projectId, 'demo-bestore');
    assert.ok(process.env.FIRESTORE_EMULATOR_HOST);
    assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST);
    const app = initializeApp({ projectId });
    const auth = getAuth(app);
    const db = getFirestore(app);
    const authUrl = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts`;
    const email = 'admin@example.test';
    const password = 'emulator-password';
    const created = await post(`${authUrl}:signUp?key=test`, { email, password, returnSecureToken: true });
    await db.doc(`users/${created.localId}`).set({ role: 'admin', active: true });
    await auth.setCustomUserClaims(created.localId, { bestoreRole: 'admin' });
    const login = await post(`${authUrl}:signInWithPassword?key=test`, { email, password, returnSecureToken: true });
    const adminImage = await uploadProductImage(projectId, created.localId, login.idToken);
    assert.equal(adminImage.status, 200, 'un administrador activo debe poder subir imágenes en su ruta');

    const callable = async (name, data) => {
        const result = await post(`http://127.0.0.1:5001/${projectId}/us-central1/${name}`, { data }, login.idToken);
        return result.result;
    };

    const seller = await post(`${authUrl}:signUp?key=test`, {
        email: 'seller@example.test',
        password,
        returnSecureToken: true
    });
    await db.doc(`users/${seller.localId}`).set({ role: 'seller', active: true });
    await auth.setCustomUserClaims(seller.localId, { bestoreRole: 'seller' });
    const sellerLogin = await post(`${authUrl}:signInWithPassword?key=test`, {
        email: 'seller@example.test',
        password,
        returnSecureToken: true
    });
    const sellerImage = await uploadProductImage(projectId, seller.localId, sellerLogin.idToken);
    assert.equal(sellerImage.status, 403, 'un vendedor no debe poder subir imágenes administrativas');
    const anotherUserImage = await uploadProductImage(projectId, seller.localId, login.idToken);
    assert.equal(anotherUserImage.status, 403, 'un administrador no debe escribir en la ruta de otro usuario');

    await db.doc(`users/${created.localId}`).update({ active: false });
    const inactiveAdminImage = await uploadProductImage(projectId, created.localId, login.idToken);
    assert.equal(inactiveAdminImage.status, 403, 'un administrador inactivo no debe poder subir imágenes');
    await db.doc(`users/${created.localId}`).update({ active: true });

    await callable('setUserRole', { uid: seller.localId, role: 'admin' });
    assert.equal((await db.doc(`users/${seller.localId}`).get()).data().role, 'admin');
    assert.equal((await auth.getUser(seller.localId)).customClaims.bestoreRole, 'admin');
    const promotedLogin = await post(`${authUrl}:signInWithPassword?key=test`, {
        email: 'seller@example.test',
        password,
        returnSecureToken: true
    });
    const promotedImage = await uploadProductImage(projectId, seller.localId, promotedLogin.idToken);
    assert.equal(promotedImage.status, 200, 'un segundo administrador activo debe tener los mismos permisos de imagen');

    await db.doc('app_state/main').set({
        version: 2,
        products: [{ id: 'ACC-1', title: 'Cable', stock: 1, price: 1000, status: 'Activo' }],
        phones: [],
        sales: [{ id: 'TK-ANT', items: [{ id: 'ACC-1', quantity: 1, price: 1000 }], subtotal: 1000, total: 1000, paymentMethod: 'Efectivo/Transferencia' }]
    });
    const preview = await callable('previewLegacyMigration', {});
    assert.equal(preview.inventory.length, 1);
    assert.equal(preview.sales.length, 1);
    assert.equal(preview.saleIssues, 1);
    assert.equal((await db.doc('app_state/main').get()).data().sales.length, 1);

    await callable('saveInventoryItem', { id: 'ACC-1', name: 'Cable', type: 'acc', active: true, stock: 1, priceCents: 100000 });
    assert.equal((await callable('listInventory', {}))[0].id, 'ACC-1');
    assert.equal((await callable('getRegisterStatus', {})).cash.open, false);
    await callable('openAllRegisters', { openingCentsByMedium: { cash: 0, transfer: 0, card: 0 } });
    assert.ok(Object.values(await callable('getRegisterStatus', {})).every(register => register.open));
    const request = {
        operationId: '01234567-1234-4234-8234-012345678901',
        items: [{ id: 'ACC-1', quantity: 1 }],
        payment: { cashCents: 100000, transferCents: 0, cardBaseCents: 0 }
    };
    const sale = await callable('recordSale', request);
    assert.equal((await callable('recordSale', request)).ticketId, sale.ticketId);
    assert.equal((await db.doc('secure_inventory/ACC-1').get()).data().stock, 0);
    await callable('recordReturn', {
        operationId: '01234567-1234-4234-8234-012345678902',
        ticketId: sale.ticketId,
        items: [{ id: 'ACC-1', quantity: 1, restock: true }],
        reason: 'Cambio',
        source: { cash: 100000, transfer: 0, cardToCash: 0, cardToTransfer: 0 }
    });
    assert.equal((await db.doc('secure_inventory/ACC-1').get()).data().stock, 1);
    assert.equal((await db.doc('secure_registers/cash').get()).data().balanceCents, 0);
    const closeResult = await callable('closeAllRegisters', {
        countedCentsByMedium: { cash: 0, transfer: 0, card: 0 }
    });
    assert.deepEqual(closeResult.differences, { cash: 0, transfer: 0, card: 0 });
    assert.ok(Object.values(await callable('getRegisterStatus', {})).every(register => !register.open));
    console.log('Emuladores: permisos, Storage, inventario, apertura/cierre conjunto de cajas, vista previa, venta idempotente y devolución verificadas.');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
