'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createHash, randomUUID } = require('node:crypto');
const { DomainError, assert, money, normalizeItems, calculateSale, calculatePayment, returnAlertPeriods } = require('./domain');
const { previewMigration } = require('./migration');
const { summarizeSales } = require('./sales-summary');

initializeApp();
const db = getFirestore();
const options = { region: 'us-central1', maxInstances: 10 };
const registers = ['cash', 'transfer', 'card'];
const superadminUid = '67V2bdleU2bZaazTtoZUvafJTsL2';

function guarded(handler) {
    return onCall(options, async request => {
        try {
            assert(request.auth, 'Inicia sesión para continuar.', 'unauthenticated');
            return await handler(request);
        } catch (error) {
            if (error instanceof DomainError) throw new HttpsError(error.code, error.message);
            console.error('Error en operación de caja:', error);
            throw new HttpsError('internal', 'No se pudo completar la operación. Intenta nuevamente.');
        }
    });
}

function authorize(request, profile, adminOnly = false) {
    const role = request.auth.token.bestoreRole;
    assert(profile.exists && profile.data().active === true && profile.data().role === role, 'Usuario inactivo o sin autorización.', 'permission-denied');
    assert(role === 'admin' || (!adminOnly && role === 'seller'), 'No tienes permiso para esta operación.', 'permission-denied');
}

function requestId(value) {
    assert(typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value), 'Identificador de operación inválido.');
    return value.toLowerCase();
}

function fingerprint(data) {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

exports.previewLegacyMigration = guarded(async request => {
    const profile = await db.doc(`users/${request.auth.uid}`).get();
    authorize(request, profile, true);
    const snapshot = await db.doc('app_state/main').get();
    assert(snapshot.exists, 'No existe el estado anterior.', 'failed-precondition');
    let preview;
    try {
        preview = previewMigration(snapshot.data());
    } catch (error) {
        throw new DomainError('failed-precondition', error.message);
    }
    const state = snapshot.data();
    const usdPhones = (state.phones || []).filter(phone => phone.currency === 'USD');
    const refs = usdPhones.map(phone => typeof phone.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(phone.id)
        ? db.doc(`secure_inventory/${phone.id}`) : null);
    const secure = await Promise.all(refs.map(ref => ref ? ref.get() : null));
    usdPhones.forEach((phone, index) => {
        const entry = preview.inventory.find(item => item.type === 'phone' && item.id === phone.id);
        const record = secure[index];
        const rate = state.dailyDollarRate;
        const calculated = Math.round(phone.priceUsd * rate) * 100;
        if (entry && record?.exists && typeof phone.priceUsd === 'number' && phone.priceUsd >= 0 &&
            typeof rate === 'number' && Number.isFinite(rate) && rate > 0 &&
            Number.isSafeInteger(calculated) && record.data().type === 'phone' && record.data().name === entry.name &&
            record.data().priceCents === calculated &&
            record.data().stock === entry.stock && record.data().active === entry.active) {
            entry.issues = entry.issues.filter(issue => issue !== 'Precio en USD requiere conciliación con la cotización vigente');
        }
    });
    preview.inventoryIssues = preview.inventory.filter(item => item.issues.length).length;
    return preview;
});

exports.updateDollarRate = guarded(async request => {
    const rate = request.data?.rate;
    assert(typeof rate === 'number' && Number.isFinite(rate) && rate > 0, 'Cotización inválida.');
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const stateRef = db.doc('app_state/main');
    return db.runTransaction(async tx => {
        const [profile, snapshot] = await Promise.all([tx.get(profileRef), tx.get(stateRef)]);
        authorize(request, profile, true);
        assert(snapshot.exists && Array.isArray(snapshot.data().phones), 'No se encontró el inventario anterior.', 'failed-precondition');
        const state = snapshot.data();
        const phones = state.phones.filter(phone => phone.currency === 'USD');
        assert(phones.length <= 200, 'Hay demasiados celulares en USD para actualizar la cotización de forma atómica.', 'failed-precondition');
        const seen = new Set();
        const refs = phones.map(phone => {
            const [{ id }] = normalizeItems([{ id: phone.id, quantity: 1 }]);
            assert(!seen.has(id), `Identificador duplicado: ${id}.`, 'failed-precondition');
            seen.add(id);
            assert(typeof phone.priceUsd === 'number' && Number.isFinite(phone.priceUsd) && phone.priceUsd >= 0,
                `Precio USD inválido para ${id}.`, 'failed-precondition');
            money(Math.round(phone.priceUsd * rate) * 100, `Precio de ${id}`);
            return db.doc(`secure_inventory/${id}`);
        });
        const snapshots = await Promise.all(refs.map(ref => tx.get(ref)));
        snapshots.forEach((item, index) => {
            assert(item.exists && item.data().type === 'phone', `El celular ${phones[index].id} no está conciliado en el inventario seguro.`, 'failed-precondition');
        });
        const updatedPhones = state.phones.map(phone => phone.currency === 'USD'
            ? { ...phone, price: Math.round(phone.priceUsd * rate) } : phone);
        phones.forEach((phone, index) => {
            const priceCents = Math.round(phone.priceUsd * rate) * 100;
            tx.update(refs[index], { priceCents, updatedBy: request.auth.uid, updatedAt: FieldValue.serverTimestamp() });
            tx.create(db.collection('secure_inventory_audit').doc(), {
                itemId: phone.id, before: snapshots[index].data(),
                after: { ...snapshots[index].data(), priceCents },
                createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
            });
        });
        tx.update(stateRef, { dailyDollarRate: rate, phones: updatedPhones, updatedAt: FieldValue.serverTimestamp() });
        return { rate, updated: phones.length, phones: updatedPhones };
    });
});

exports.quotePhone = guarded(async request => {
    const quoteId = requestId(request.data?.quoteId);
    const [{ id }] = normalizeItems([{ id: request.data?.id, quantity: 1 }]);
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const itemRef = db.doc(`secure_inventory/${id}`);
    const quoteRef = db.doc(`secure_phone_quotes/${quoteId}`);
    return db.runTransaction(async tx => {
        const [profile, item, quote] = await Promise.all([tx.get(profileRef), tx.get(itemRef), tx.get(quoteRef)]);
        authorize(request, profile);
        if (quote.exists) {
            const saved = quote.data();
            assert(saved.createdBy === request.auth.uid && saved.itemId === id && saved.status === 'open',
                'La cotización ya no está disponible.', 'failed-precondition');
            return { quoteId, priceCents: saved.priceCents };
        }
        assert(item.exists && item.data().type === 'phone' && item.data().active === true && item.data().stock === 1,
            'El celular no está disponible en el inventario seguro.', 'failed-precondition');
        const priceCents = money(item.data().priceCents, 'Precio');
        tx.create(quoteRef, { itemId: id, priceCents, status: 'open', createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp() });
        return { quoteId, priceCents };
    });
});

exports.cancelPhoneQuotes = guarded(async request => {
    const ids = request.data?.quoteIds;
    assert(Array.isArray(ids) && ids.length <= 100, 'Cotizaciones inválidas.');
    const quoteIds = ids.map(requestId);
    assert(new Set(quoteIds).size === quoteIds.length, 'Cotizaciones duplicadas.');
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const refs = quoteIds.map(id => db.doc(`secure_phone_quotes/${id}`));
    return db.runTransaction(async tx => {
        const [profile, ...quotes] = await Promise.all([tx.get(profileRef), ...refs.map(ref => tx.get(ref))]);
        authorize(request, profile);
        quotes.forEach(quote => {
            assert(quote.exists && quote.data().createdBy === request.auth.uid &&
                ['open', 'cancelled'].includes(quote.data().status), 'La cotización no puede cancelarse.', 'failed-precondition');
        });
        quotes.forEach((quote, index) => {
            if (quote.data().status === 'open') tx.update(refs[index], { status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() });
        });
        return { cancelled: quoteIds.length };
    });
});

exports.listInventory = guarded(async request => {
    const profile = await db.doc(`users/${request.auth.uid}`).get();
    authorize(request, profile);
    const snapshot = await db.collection('secure_inventory').get();
    return snapshot.docs.map(item => {
        const data = item.data();
        assert(typeof data.name === 'string' && data.name.length > 0 && data.name.length <= 200, `Nombre inválido para ${item.id}.`, 'failed-precondition');
        assert(data.type === 'acc' || data.type === 'phone', `Tipo inválido para ${item.id}.`, 'failed-precondition');
        assert(typeof data.active === 'boolean', `Estado inválido para ${item.id}.`, 'failed-precondition');
        assert(Number.isSafeInteger(data.stock) && data.stock >= 0 && data.stock <= 1000000, `Stock inválido para ${item.id}.`, 'failed-precondition');
        assert(data.type !== 'phone' || data.stock <= 1, `Stock inválido para ${item.id}.`, 'failed-precondition');
        money(data.priceCents, `Precio de ${item.id}`);
        return { ...data, id: item.id };
    });
});

exports.getSalesSummary = guarded(async request => {
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const stateRef = db.doc('app_state/main');
    const salesRef = db.collection('secure_sales');
    return db.runTransaction(async tx => {
        const [profile, state, sales, exchanges] = await Promise.all([
            tx.get(profileRef), tx.get(stateRef), tx.get(salesRef), tx.get(db.collection('secure_return_exchanges'))
        ]);
        authorize(request, profile);
        assert(state.exists && Array.isArray(state.data().sales),
            'No se encontró el historial de ventas anterior.', 'failed-precondition');
        return summarizeSales(sales.docs.map(doc => ({ ...doc.data(), id: doc.id })), state.data().sales,
            new Date(), exchanges.docs.map(doc => ({ ...doc.data(), id: doc.id })));
    });
});

exports.setUserRole = guarded(async request => {
    const { uid, role } = request.data || {};
    assert(typeof uid === 'string' && uid.length > 0 && uid.length <= 128, 'Usuario inválido.');
    assert(role === 'admin' || role === 'seller', 'Rol inválido.');
    assert(uid !== request.auth.uid || role === 'admin', 'No puedes quitarte el rol de administrador.', 'permission-denied');
    assert(uid !== superadminUid || (request.auth.uid === superadminUid && role === 'admin'),
        'No se pueden modificar los permisos del superadministrador.', 'permission-denied');

    const profileRef = db.doc(`users/${request.auth.uid}`);
    const targetRef = db.doc(`users/${uid}`);
    const operationRef = db.collection('secure_permission_changes').doc();
    const auth = getAuth();
    const actorProfile = await profileRef.get();
    authorize(request, actorProfile, true);
    let targetAuth;
    try {
        targetAuth = await auth.getUser(uid);
    } catch (error) {
        if (error.code === 'auth/user-not-found') throw new DomainError('not-found', 'No existe la cuenta indicada.');
        throw error;
    }
    assert(!targetAuth.disabled, 'La cuenta está deshabilitada.', 'failed-precondition');

    await db.runTransaction(async tx => {
        const [actorProfile, targetProfile] = await Promise.all([tx.get(profileRef), tx.get(targetRef)]);
        authorize(request, actorProfile, true);
        assert(targetProfile.exists && targetProfile.data().active === true, 'El perfil no existe o está inactivo.', 'failed-precondition');
        tx.create(operationRef, {
            uid,
            role,
            previousRole: targetProfile.data().role || null,
            status: 'pending',
            changedBy: request.auth.uid,
            createdAt: FieldValue.serverTimestamp()
        });
        tx.update(targetRef, { role, permissionChangeId: operationRef.id });
    });

    try {
        await auth.setCustomUserClaims(uid, { ...targetAuth.customClaims, bestoreRole: role });
        await auth.revokeRefreshTokens(uid);
        await operationRef.update({ status: 'applied', appliedAt: FieldValue.serverTimestamp() });
    } catch (error) {
        console.error(`No se pudo completar el cambio de permisos; revisar la operación ${operationRef.id}:`, error);
        throw new DomainError('internal', `No se pudo completar el cambio de permisos. Revisa la operación ${operationRef.id} antes de reintentar.`);
    }
    return { uid, role, operationId: operationRef.id };
});

exports.setUserPassword = guarded(async request => {
    const { uid, password } = request.data || {};
    assert(request.auth.uid === superadminUid, 'Solo BeStore puede modificar claves.', 'permission-denied');
    assert(typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && uid !== superadminUid,
        'Selecciona otro usuario válido.');
    assert(typeof password === 'string' && password.length >= 6 && password.length <= 128,
        'La clave debe tener entre 6 y 128 caracteres.');
    const actorRef = db.doc(`users/${request.auth.uid}`);
    const targetRef = db.doc(`users/${uid}`);
    const auditRef = db.collection('secure_password_changes').doc();
    await db.runTransaction(async tx => {
        const [actor, target] = await Promise.all([tx.get(actorRef), tx.get(targetRef)]);
        authorize(request, actor, true);
        assert(target.exists, 'El usuario no existe.', 'not-found');
        tx.create(auditRef, { uid, changedBy: request.auth.uid, status: 'pending', createdAt: FieldValue.serverTimestamp() });
    });
    const auth = getAuth();
    try {
        await auth.updateUser(uid, { password });
    } catch (error) {
        console.error(`Falló la actualización de clave de la operación ${auditRef.id}:`, error.code || 'error-interno');
        const messages = {
            'auth/user-not-found': 'No existe la cuenta de autenticación del usuario seleccionado.',
            'auth/invalid-password': 'Firebase rechazó la clave. Verifica los requisitos de contraseña del proyecto.',
            'auth/password-does-not-meet-requirements': 'La clave no cumple los requisitos de contraseña configurados en Firebase.'
        };
        const knownMessage = messages[error.code];
        throw new DomainError(knownMessage ? 'failed-precondition' : 'internal', knownMessage ||
            `No se pudo confirmar si Firebase cambió la clave. Comprueba el acceso con la nueva clave antes de reintentar. Operación: ${auditRef.id}.`);
    }
    try {
        await auth.revokeRefreshTokens(uid);
    } catch (error) {
        console.error(`La clave se cambió, pero falló la revocación en la operación ${auditRef.id}:`, error.code || 'error-interno');
        throw new DomainError('internal', `La clave nueva ya fue aplicada, pero no se pudo confirmar el cierre de las sesiones anteriores. No repitas el cambio; consulta la operación ${auditRef.id}.`);
    }
    try {
        await auditRef.update({ status: 'applied', appliedAt: FieldValue.serverTimestamp() });
    } catch (error) {
        console.error(`La clave se cambió, pero falló la auditoría en la operación ${auditRef.id}:`, error.code || 'error-interno');
        throw new DomainError('internal', `La clave nueva ya fue aplicada y las sesiones fueron revocadas, pero no se pudo finalizar la auditoría. No repitas el cambio; consulta la operación ${auditRef.id}.`);
    }
    return { uid, operationId: auditRef.id };
});

exports.saveInventoryItem = guarded(async request => {
    const data = request.data || {};
    const [{ id }] = normalizeItems([{ id: data.id, quantity: 1 }]);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    assert(name.length > 0 && name.length <= 200, 'Nombre de artículo inválido.');
    assert(typeof data.active === 'boolean', 'Estado de artículo inválido.');
    assert(data.type === 'acc' || data.type === 'phone', 'Tipo de artículo inválido.');
    assert(Number.isSafeInteger(data.stock) && data.stock >= 0 && data.stock <= 1000000, 'Stock inválido.');
    assert(data.type !== 'phone' || data.stock <= 1, 'Un celular individual no puede tener más de una unidad.');
    money(data.priceCents, 'Precio');
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const itemRef = db.collection('secure_inventory').doc(id);
    const stateRef = db.doc('app_state/main');
    return db.runTransaction(async tx => {
        const [profile, item, state] = await Promise.all([tx.get(profileRef), tx.get(itemRef), tx.get(stateRef)]);
        authorize(request, profile, true);
        if (data.type === 'phone') {
            const previous = state.exists && Array.isArray(state.data().phones)
                ? state.data().phones.find(phone => phone.id === id) : null;
            if (data.currency === 'USD' || previous?.currency === 'USD') {
                assert(data.currency === 'USD' || data.currency === 'ARS', 'Indica la moneda del celular.');
                assert(state.exists && typeof state.data().dailyDollarRate === 'number' &&
                    state.data().dailyDollarRate > 0 && data.expectedDollarRate === state.data().dailyDollarRate,
                'La cotización cambió. Actualiza la aplicación antes de modificar el celular.', 'failed-precondition');
            }
            if (data.currency === 'USD') {
                assert(typeof data.priceUsd === 'number' && Number.isFinite(data.priceUsd) && data.priceUsd >= 0,
                    'Precio USD inválido.');
                assert(data.priceCents === Math.round(data.priceUsd * state.data().dailyDollarRate) * 100,
                    'El precio no coincide con la cotización vigente.', 'failed-precondition');
            }
        }
        const updated = { id, name, type: data.type, active: data.active, stock: data.stock, priceCents: data.priceCents };
        tx.set(itemRef, { ...updated, updatedBy: request.auth.uid, updatedAt: FieldValue.serverTimestamp() });
        tx.create(db.collection('secure_inventory_audit').doc(), {
            itemId: id, before: item.exists ? item.data() : null, after: updated,
            createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
        });
        return updated;
    });
});

exports.deleteInventoryItem = guarded(async request => {
    const [{ id }] = normalizeItems([{ id: request.data?.id, quantity: 1 }]);
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const itemRef = db.doc(`secure_inventory/${id}`);
    const stateRef = db.doc('app_state/main');
    const auditRef = db.collection('secure_inventory_audit').doc();
    return db.runTransaction(async tx => {
        const [profile, item, state, debts] = await Promise.all([
            tx.get(profileRef), tx.get(itemRef), tx.get(stateRef),
            tx.get(db.collection('secure_customer_debts').where('itemIds', 'array-contains', id))
        ]);
        authorize(request, profile, true);
        assert(!debts.docs.some(debt => debt.data().lockedTotalCents === null),
            'No se puede eliminar un producto con deudas cuyo precio todavía se actualiza.', 'failed-precondition');
        assert(item.exists && item.data().type === 'acc', 'No se encontró el producto en el inventario.', 'not-found');
        assert(state.exists && Array.isArray(state.data().products), 'El inventario del historial no es válido.', 'failed-precondition');
        const products = state.data().products.filter(product => product.id !== id);
        assert(products.length < state.data().products.length, 'No se encontró el producto en el inventario.', 'not-found');
        tx.delete(itemRef);
        tx.update(stateRef, { products, updatedAt: FieldValue.serverTimestamp() });
        tx.create(auditRef, {
            itemId: id, before: item.data(), after: null,
            createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
        });
        return { id };
    });
});

function debtTotal(debt, inventory) {
    if (debt.lockedTotalCents !== null) return money(debt.lockedTotalCents, 'Total de deuda');
    return debt.items.reduce((total, item, index) => {
        assert(inventory[index].exists, `No se encontró el precio actual de ${item.name}.`, 'failed-precondition');
        const price = money(inventory[index].data().priceCents, `Precio de ${item.name}`);
        return money(total + money(price * item.quantity, 'Importe de deuda'), 'Total de deuda');
    }, 0);
}

exports.listCustomerDebts = guarded(async request => {
    const profile = await db.doc(`users/${request.auth.uid}`).get();
    authorize(request, profile);
    const snapshot = await db.collection('secure_customer_debts').get();
    return Promise.all(snapshot.docs.map(async doc => {
        const debt = doc.data();
        const inventory = debt.lockedTotalCents === null
            ? await Promise.all(debt.items.map(item => db.doc(`secure_inventory/${item.id}`).get())) : [];
        const totalCents = debtTotal(debt, inventory);
        const paidCents = money(debt.paidCents, 'Pagos');
        assert(paidCents <= totalCents, 'El saldo de la deuda es inválido.', 'failed-precondition');
        return { ticketId: doc.id, ticketNumber: debt.ticketNumber, customerName: debt.customerName,
            items: debt.items, totalCents, paidCents, balanceCents: totalCents - paidCents,
            locked: debt.lockedTotalCents !== null, payments: debt.payments,
            createdAt: debt.createdAt?.toDate?.().toISOString() || null };
    }));
});

exports.recordCustomerDebtPayment = guarded(async request => {
    const data = request.data || {};
    const ticketId = requestId(data.ticketId);
    const operationId = requestId(data.operationId);
    const expectedTotalCents = money(data.expectedTotalCents, 'Total esperado');
    const payment = calculatePayment(data.payment);
    const baseCents = money(payment.cashCents + payment.transferCents + payment.cardBaseCents, 'Pago');
    assert(baseCents > 0, 'El pago debe ser mayor que cero.');
    const hash = fingerprint({ ticketId, expectedTotalCents, payment: data.payment });
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const debtRef = db.doc(`secure_customer_debts/${ticketId}`);
    const opRef = db.doc(`secure_customer_debt_operations/${request.auth.uid}_${operationId}`);
    const registerRefs = registers.map(medium => db.doc(`secure_registers/${medium}`));
    return db.runTransaction(async tx => {
        const [profile, debtSnapshot, operation, ...registerSnapshots] = await Promise.all([
            tx.get(profileRef), tx.get(debtRef), tx.get(opRef), ...registerRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra operación.', 'already-exists');
            return operation.data().result;
        }
        assert(debtSnapshot.exists, 'No se encontró la deuda.', 'not-found');
        const debt = debtSnapshot.data();
        const inventory = debt.lockedTotalCents === null
            ? await Promise.all(debt.items.map(item => tx.get(db.doc(`secure_inventory/${item.id}`)))) : [];
        const totalCents = debtTotal(debt, inventory);
        assert(totalCents === expectedTotalCents, 'El precio de la deuda cambió. Actualiza la lista antes de cobrar.', 'failed-precondition');
        const paidCents = money(debt.paidCents, 'Pagos');
        assert(baseCents <= totalCents - paidCents, 'El pago supera el saldo pendiente.', 'failed-precondition');
        const amounts = [payment.cashCents, payment.transferCents, payment.cardNetCents];
        const sessions = await Promise.all(registerSnapshots.map((snapshot, index) => {
            if (!amounts[index]) return null;
            assert(snapshot.exists && snapshot.data().open === true && typeof snapshot.data().sessionId === 'string',
                `La caja ${registers[index]} debe estar abierta.`, 'failed-precondition');
            money(snapshot.data().balanceCents + amounts[index], 'Saldo de caja');
            return tx.get(db.doc(`secure_register_sessions/${snapshot.data().sessionId}`));
        }));
        sessions.forEach((session, index) => {
            if (amounts[index]) assert(session?.exists && session.data().open === true &&
                session.data().balanceCents === registerSnapshots[index].data().balanceCents,
            `La sesión de caja ${registers[index]} no está disponible.`, 'failed-precondition');
        });
        registerSnapshots.forEach((snapshot, index) => {
            if (!amounts[index]) return;
            const register = snapshot.data();
            const balanceCents = register.balanceCents + amounts[index];
            tx.update(registerRefs[index], { balanceCents });
            tx.update(db.doc(`secure_register_sessions/${register.sessionId}`), { balanceCents });
            tx.create(db.collection('secure_cash_movements').doc(), {
                medium: registers[index], amountCents: amounts[index], sessionId: register.sessionId,
                saleId: ticketId, debtPaymentOperationId: operationId,
                createdAt: FieldValue.serverTimestamp(), createdBy: request.auth.uid
            });
        });
        const entry = { payment, baseCents, date: new Date().toISOString(), createdBy: request.auth.uid };
        tx.update(debtRef, { lockedTotalCents: totalCents, paidCents: paidCents + baseCents, payments: [...debt.payments, entry] });
        const result = { ticketId, totalCents, paidCents: paidCents + baseCents, balanceCents: totalCents - paidCents - baseCents, payment };
        tx.create(opRef, { fingerprint: hash, result, createdAt: FieldValue.serverTimestamp() });
        return result;
    });
});

exports.openAllRegisters = guarded(async request => {
    const openingCents = request.data?.openingCentsByMedium;
    assert(openingCents && typeof openingCents === 'object', 'Indica el saldo inicial de las tres cajas.');
    registers.forEach(medium => money(openingCents[medium], `Saldo inicial de ${medium}`));
    const registerRefs = registers.map(medium => db.doc(`secure_registers/${medium}`));
    const profileRef = db.doc(`users/${request.auth.uid}`);
    return db.runTransaction(async tx => {
        const [profile, ...snapshots] = await Promise.all([
            tx.get(profileRef), ...registerRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile, true);
        assert(snapshots.every(snapshot => !snapshot.exists || snapshot.data().open !== true),
            'Las tres cajas deben estar cerradas para abrirlas juntas.', 'failed-precondition');
        const sessionIds = {};
        registers.forEach((medium, index) => {
            const sessionId = randomUUID();
            sessionIds[medium] = sessionId;
            const sessionRef = db.doc(`secure_register_sessions/${sessionId}`);
            const session = {
                medium,
                openingCents: openingCents[medium],
                balanceCents: openingCents[medium],
                open: true,
                openedBy: request.auth.uid,
                openedAt: FieldValue.serverTimestamp()
            };
            tx.create(sessionRef, session);
            tx.set(registerRefs[index], { ...session, sessionId });
        });
        return { sessionIds };
    });
});

exports.getRegisterStatus = guarded(async request => {
    const profile = await db.doc(`users/${request.auth.uid}`).get();
    authorize(request, profile);
    const snapshots = await Promise.all(registers.map(medium => db.doc(`secure_registers/${medium}`).get()));
    return Object.fromEntries(registers.map((medium, index) => {
        const snapshot = snapshots[index];
        if (!snapshot.exists) return [medium, { open: false, balanceCents: 0, openingCents: 0 }];
        const data = snapshot.data();
        assert(typeof data.open === 'boolean', `Estado inválido para la caja ${medium}.`, 'failed-precondition');
        money(data.balanceCents, `Saldo de caja ${medium}`);
        money(data.openingCents, `Saldo inicial de caja ${medium}`);
        return [medium, {
            open: snapshot.data().open === true,
            balanceCents: data.balanceCents,
            openingCents: data.openingCents
        }];
    }));
});

exports.recordSupplierPayment = guarded(async request => {
    const operationId = requestId(request.data?.operationId);
    const amountCents = request.data?.amountCents;
    money(amountCents, 'El pago');
    assert(amountCents > 0, 'El importe del pago debe ser mayor que cero.');
    const medium = request.data?.medium;
    assert(medium === 'cash' || medium === 'transfer', 'La forma de pago debe ser efectivo o transferencia.');
    const supplierId = request.data?.supplierId || null;
    const payeeName = typeof request.data?.payeeName === 'string' ? request.data.payeeName.trim() : '';
    assert(request.data?.note == null || typeof request.data.note === 'string', 'El concepto debe ser texto.');
    const note = typeof request.data?.note === 'string' ? request.data.note.trim() : '';
    assert(!supplierId || (typeof supplierId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(supplierId)), 'Proveedor inválido.');
    assert(supplierId || (payeeName.length > 0 && payeeName.length <= 120), 'Indica el nombre del destinatario.');
    assert(note.length <= 300, 'El concepto no puede superar los 300 caracteres.');

    const input = { supplierId, payeeName: supplierId ? null : payeeName, amountCents, medium, note };
    const hash = fingerprint(input);
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const stateRef = db.doc('app_state/main');
    const registerRef = db.doc(`secure_registers/${medium}`);
    const operationRef = db.doc(`secure_supplier_payment_operations/${request.auth.uid}_${operationId}`);
    const paymentRef = db.collection('secure_supplier_payments').doc();
    const movementRef = db.collection('secure_cash_movements').doc();

    return db.runTransaction(async tx => {
        const [profile, state, register, operation] = await Promise.all([
            tx.get(profileRef), tx.get(stateRef), tx.get(registerRef), tx.get(operationRef)
        ]);
        authorize(request, profile, true);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador de operación ya fue usado con otros datos.', 'already-exists');
            return operation.data().result;
        }

        assert(state.exists, 'No se encontró el estado de proveedores.', 'failed-precondition');
        let recipient = payeeName;
        if (supplierId) {
            const suppliers = state.data().suppliers || [];
            assert(Array.isArray(suppliers), 'La lista de proveedores no es válida.', 'failed-precondition');
            const supplier = suppliers.find(item => item && item.id === supplierId);
            assert(supplier && typeof supplier.name === 'string' && supplier.name.trim(), 'El proveedor seleccionado ya no existe.', 'failed-precondition');
            recipient = supplier.name.trim();
        }
        assert(recipient.length > 0 && recipient.length <= 120, 'El nombre del destinatario no es válido.', 'failed-precondition');
        assert(register.exists && register.data().open === true, `La caja de ${medium === 'cash' ? 'efectivo' : 'transferencia'} debe estar abierta.`, 'failed-precondition');
        const registerData = register.data();
        money(registerData.balanceCents, 'El saldo de caja');
        assert(registerData.balanceCents >= amountCents, 'El saldo de la caja es insuficiente.', 'failed-precondition');
        assert(typeof registerData.sessionId === 'string' && registerData.sessionId.length > 0, 'La caja no tiene una sesión válida.', 'failed-precondition');

        const sessionRef = db.doc(`secure_register_sessions/${registerData.sessionId}`);
        const session = await tx.get(sessionRef);
        assert(session.exists && session.data().open === true && session.data().medium === medium,
            'La sesión de caja no está abierta o no coincide con la forma de pago.', 'failed-precondition');
        money(session.data().balanceCents, 'El saldo de la sesión');
        assert(session.data().balanceCents === registerData.balanceCents,
            'El saldo de la caja y su sesión no coinciden.', 'failed-precondition');

        const result = {
            paymentId: paymentRef.id, payeeName: recipient, supplierId,
            amountCents, medium, note
        };
        const timestamp = FieldValue.serverTimestamp();
        tx.update(registerRef, { balanceCents: registerData.balanceCents - amountCents, updatedAt: timestamp });
        tx.update(sessionRef, { balanceCents: session.data().balanceCents - amountCents, updatedAt: timestamp });
        tx.create(paymentRef, {
            ...result, createdBy: request.auth.uid, createdAt: timestamp
        });
        tx.create(movementRef, {
            medium, amountCents: -amountCents, sessionId: registerData.sessionId,
            supplierPaymentId: paymentRef.id, payeeName: recipient, note,
            createdBy: request.auth.uid, createdAt: timestamp
        });
        tx.create(operationRef, { fingerprint: hash, result, createdAt: timestamp });
        return result;
    });
});

exports.listSupplierPayments = guarded(async request => {
    const profile = await db.doc(`users/${request.auth.uid}`).get();
    authorize(request, profile, true);
    const snapshot = await db.collection('secure_supplier_payments').get();
    return snapshot.docs.map(document => {
        const payment = document.data();
        const createdAt = payment.createdAt && typeof payment.createdAt.toDate === 'function'
            ? payment.createdAt.toDate().toISOString()
            : null;
        return {
            id: document.id, payeeName: payment.payeeName, amountCents: payment.amountCents,
            medium: payment.medium, note: payment.note || '', createdAt
        };
    }).sort((first, second) => (second.createdAt || '').localeCompare(first.createdAt || ''));
});

exports.closeAllRegisters = guarded(async request => {
    const countedCentsByMedium = request.data?.countedCentsByMedium;
    assert(countedCentsByMedium && typeof countedCentsByMedium === 'object',
        'Indica el saldo contado de las cajas abiertas.');
    Object.entries(countedCentsByMedium).forEach(([medium, amount]) => {
        assert(registers.includes(medium), 'Caja inválida.');
        money(amount, `Saldo contado de ${medium}`);
    });
    const registerRefs = registers.map(medium => db.doc(`secure_registers/${medium}`));
    const profileRef = db.doc(`users/${request.auth.uid}`);
    return db.runTransaction(async tx => {
        const [profile, ...snapshots] = await Promise.all([
            tx.get(profileRef), ...registerRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile, true);
        const openIndexes = snapshots
            .map((snapshot, index) => snapshot.exists && snapshot.data().open === true ? index : -1)
            .filter(index => index !== -1);
        assert(openIndexes.length > 0, 'No hay cajas abiertas para cerrar.', 'failed-precondition');
        const sessionRefs = openIndexes.map(index => {
            const sessionId = snapshots[index].data().sessionId;
            assert(typeof sessionId === 'string' && sessionId.length > 0,
                `La caja ${registers[index]} no tiene una sesión válida.`, 'failed-precondition');
            assert(Object.hasOwn(countedCentsByMedium, registers[index]),
                `Indica el saldo contado de ${registers[index]}.`);
            return db.doc(`secure_register_sessions/${sessionId}`);
        });
        const sessionSnapshots = await Promise.all(sessionRefs.map(ref => tx.get(ref)));
        assert(sessionSnapshots.every(snapshot => snapshot.exists),
            'Falta una sesión de caja; no se cerró ninguna caja.', 'failed-precondition');
        const differences = {};
        openIndexes.forEach((index, sessionIndex) => {
            const medium = registers[index];
            const current = snapshots[index].data();
            const countedCents = countedCentsByMedium[medium];
            const close = {
                open: false,
                countedCents,
                differenceCents: countedCents - current.balanceCents,
                closedBy: request.auth.uid,
                closedAt: FieldValue.serverTimestamp()
            };
            differences[medium] = close.differenceCents;
            tx.update(registerRefs[index], close);
            tx.update(sessionRefs[sessionIndex], close);
        });
        return { differences, closedMedia: openIndexes.map(index => registers[index]) };
    });
});

exports.assignLegacyTicketNumbers = guarded(async request => {
    const ids = request.data?.saleIds;
    assert(Array.isArray(ids) && ids.length > 0 && ids.length <= 50 &&
        ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200) &&
        new Set(ids).size === ids.length, 'Identificadores de ventas inválidos.');
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const stateRef = db.doc('app_state/main');
    const counterRef = db.doc('secure_counters/sale_tickets');
    const assignmentRefs = ids.map(id => db.doc(`secure_ticket_numbers/${createHash('sha256').update(id).digest('hex')}`));
    const saleRefs = ids.map(id => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
        ? db.doc(`secure_sales/${id}`) : null);

    return db.runTransaction(async tx => {
        const [profile, state, counter, ...snapshots] = await Promise.all([
            tx.get(profileRef), tx.get(stateRef), tx.get(counterRef),
            ...assignmentRefs.map(ref => tx.get(ref)),
            ...saleRefs.map(ref => ref ? tx.get(ref) : Promise.resolve(null))
        ]);
        authorize(request, profile);
        assert(state.exists && Array.isArray(state.data().sales), 'No se encontró el historial de ventas.', 'failed-precondition');
        const history = state.data().sales;
        const lastTicketNumber = counter.exists ? counter.data().lastTicketNumber : 0;
        assert(Number.isSafeInteger(lastTicketNumber) && lastTicketNumber >= 0,
            'El contador de tickets no es válido.', 'failed-precondition');
        assert(history.every(sale => sale && (sale.ticketNumber === undefined ||
            (Number.isSafeInteger(sale.ticketNumber) && sale.ticketNumber > 0 && sale.ticketNumber <= lastTicketNumber))),
        'El historial contiene números que no coinciden con el contador; solicita una revisión.', 'failed-precondition');
        const existingNumbers = history.filter(sale => sale.ticketNumber !== undefined).map(sale => sale.ticketNumber);
        assert(new Set(existingNumbers).size === existingNumbers.length,
            'El historial contiene números de ticket duplicados; solicita una revisión.', 'failed-precondition');
        let nextNumber = lastTicketNumber;
        const numbers = ids.map((id, index) => {
            const matches = history.filter(sale => sale.id === id);
            assert(matches.length === 1 && matches[0].status !== 'Pendiente de emisión',
                'Una venta no está disponible en el historial compartido.', 'failed-precondition');
            const assignment = snapshots[index];
            const secureSale = snapshots[ids.length + index];
            const candidates = [
                matches[0].ticketNumber,
                assignment.exists ? assignment.data().ticketNumber : undefined,
                secureSale?.exists ? secureSale.data().ticketNumber : undefined
            ].filter(value => value !== undefined);
            assert(candidates.every(value => Number.isSafeInteger(value) && value > 0 && value <= lastTicketNumber) &&
                new Set(candidates).size <= 1, 'El número de una venta requiere revisión.', 'failed-precondition');
            if (assignment.exists) assert(assignment.data().saleId === id, 'La asignación del ticket requiere revisión.', 'failed-precondition');
            if (!candidates.length) {
                assert(nextNumber < Number.MAX_SAFE_INTEGER, 'Se agotó el contador de tickets.', 'failed-precondition');
                nextNumber += 1;
            }
            const ticketNumber = candidates.length ? candidates[0] : nextNumber;
            if (!assignment.exists) tx.create(assignmentRefs[index], { saleId: id, ticketNumber });
            if (secureSale?.exists && secureSale.data().ticketNumber === undefined) {
                tx.update(saleRefs[index], { ticketNumber });
            }
            return { saleId: id, ticketNumber };
        });
        if (nextNumber !== lastTicketNumber) tx.set(counterRef, { lastTicketNumber: nextNumber });
        return { numbers };
    });
});

exports.recordSale = guarded(async request => {
    const data = request.data || {};
    const operationId = requestId(data.operationId);
    const items = normalizeItems(data.items);
    const customerName = typeof data.customerName === 'string' ? data.customerName.trim() : '';
    assert(customerName.length <= 120, 'Nombre de cliente demasiado largo.');
    const account = data.account === true;
    if (account) assert(customerName && customerName.toLowerCase() !== 'consumidor final', 'Indica el nombre del cliente para la cuenta corriente.');
    const payment = data.payment;
    const quoteIds = (data.items || []).map(item => item.quoteId == null ? null : requestId(item.quoteId));
    assert(new Set(quoteIds.filter(Boolean)).size === quoteIds.filter(Boolean).length, 'Cotizaciones duplicadas.');
    const hash = fingerprint({ items, customerName, payment, ...(account ? { account } : {}), ...(quoteIds.some(Boolean) ? { quoteIds } : {}) });
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const opRef = db.collection('secure_sale_operations').doc(`${request.auth.uid}_${operationId}`);
    const saleRef = db.collection('secure_sales').doc(randomUUID());
    const ticketCounterRef = db.doc('secure_counters/sale_tickets');
    const stockRefs = items.map(item => db.collection('secure_inventory').doc(item.id));
    const quoteRefs = quoteIds.filter(Boolean).map(id => db.doc(`secure_phone_quotes/${id}`));
    const registerRefs = registers.map(medium => db.collection('secure_registers').doc(medium));

    return db.runTransaction(async tx => {
        const [profile, operation, counter, ...snapshots] = await Promise.all([
            tx.get(profileRef), tx.get(opRef), tx.get(ticketCounterRef), ...stockRefs.map(ref => tx.get(ref)),
            ...registerRefs.map(ref => tx.get(ref)), ...quoteRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra operación.', 'already-exists');
            const result = operation.data().result;
            const existingSaleRef = db.doc(`secure_sales/${result.ticketId}`);
            const existingSale = await tx.get(existingSaleRef);
            assert(existingSale.exists, 'No se encontró la venta confirmada.', 'failed-precondition');
            assert(!existingSale.data().revision,
                'La venta fue corregida. Vuelve a iniciar sesión para consultar el comprobante actualizado.', 'failed-precondition');
            if (result.ticketNumber !== undefined) {
                return result;
            }
            const lastNumber = counter.exists ? counter.data().lastTicketNumber : 0;
            assert(Number.isSafeInteger(lastNumber) && lastNumber >= 0 && lastNumber < Number.MAX_SAFE_INTEGER,
                'El contador de tickets no es válido.', 'failed-precondition');
            let ticketNumber = existingSale.data().ticketNumber;
            if (ticketNumber === undefined) {
                ticketNumber = lastNumber + 1;
                tx.set(ticketCounterRef, { lastTicketNumber: ticketNumber });
                tx.update(existingSaleRef, { ticketNumber });
            } else {
                assert(Number.isSafeInteger(ticketNumber) && ticketNumber > 0 && ticketNumber <= lastNumber,
                    'El número de la venta requiere revisión.', 'failed-precondition');
            }
            const numberedResult = { ...result, ticketNumber };
            tx.update(opRef, { result: numberedResult });
            return numberedResult;
        }
        const lastTicketNumber = counter.exists ? counter.data().lastTicketNumber : 0;
        assert(Number.isSafeInteger(lastTicketNumber) && lastTicketNumber >= 0 && lastTicketNumber < Number.MAX_SAFE_INTEGER,
            'El contador de tickets no es válido.', 'failed-precondition');
        const ticketNumber = lastTicketNumber + 1;
        const stockSnapshots = snapshots.slice(0, stockRefs.length);
        const registerSnapshots = snapshots.slice(stockRefs.length, stockRefs.length + registerRefs.length);
        const quoteSnapshots = snapshots.slice(stockRefs.length + registerRefs.length);
        const catalog = Object.fromEntries(stockSnapshots.map((snapshot, index) => [items[index].id, snapshot.exists ? snapshot.data() : null]));
        let quoteIndex = 0;
        quoteIds.forEach((quoteId, index) => {
            if (!quoteId) return;
            const quote = quoteSnapshots[quoteIndex++];
            assert(quote.exists && quote.data().createdBy === request.auth.uid &&
                quote.data().status === 'open' && quote.data().itemId === items[index].id &&
                items[index].quantity === 1 && catalog[items[index].id]?.type === 'phone',
            'La cotización del celular no está disponible.', 'failed-precondition');
            catalog[items[index].id] = { ...catalog[items[index].id], priceCents: money(quote.data().priceCents, 'Precio cotizado') };
        });
        const sale = calculateSale(items, catalog, payment, account);
        const movements = [sale.payment.cashCents, sale.payment.transferCents, sale.payment.cardNetCents];
        registerSnapshots.forEach((snapshot, index) => {
            if (movements[index] === 0) return;
            assert(snapshot.exists && snapshot.data().open === true, `La caja ${registers[index]} debe estar abierta.`, 'failed-precondition');
            money(snapshot.data().balanceCents + movements[index], 'Saldo de caja');
        });
        if (account) {
            const sessions = await Promise.all(registerSnapshots.map((snapshot, index) => {
                if (!movements[index]) return null;
                assert(typeof snapshot.data().sessionId === 'string', `La sesión de caja ${registers[index]} no está disponible.`, 'failed-precondition');
                return tx.get(db.doc(`secure_register_sessions/${snapshot.data().sessionId}`));
            }));
            sessions.forEach((session, index) => {
                if (movements[index]) assert(session?.exists && session.data().open === true &&
                    session.data().balanceCents === registerSnapshots[index].data().balanceCents,
                `La sesión de caja ${registers[index]} no está disponible.`, 'failed-precondition');
            });
        }

        stockSnapshots.forEach((snapshot, index) => {
            tx.update(stockRefs[index], { stock: snapshot.data().stock - items[index].quantity });
        });
        quoteRefs.forEach(ref => tx.update(ref, { status: 'used', saleId: saleRef.id, usedAt: FieldValue.serverTimestamp() }));
        registerSnapshots.forEach((snapshot, index) => {
            const amount = movements[index];
            if (!amount) return;
            const register = snapshot.data();
            const movement = { medium: registers[index], amountCents: amount, sessionId: register.sessionId, saleId: saleRef.id, createdAt: FieldValue.serverTimestamp(), createdBy: request.auth.uid };
            tx.update(registerRefs[index], { balanceCents: register.balanceCents + amount });
            tx.update(db.doc(`secure_register_sessions/${register.sessionId}`), { balanceCents: register.balanceCents + amount });
            tx.create(db.collection('secure_cash_movements').doc(), movement);
        });
        const result = {
            ticketId: saleRef.id,
            ticketNumber,
            sellerName: typeof profile.data().nick === 'string' && profile.data().nick.trim()
                ? profile.data().nick.trim() : 'No registrado',
            ...sale,
            items: sale.items.map((item, index) => ({
                ...item,
                type: stockSnapshots[index].data().type,
                stockAfter: stockSnapshots[index].data().stock - items[index].quantity
            }))
        };
        tx.set(ticketCounterRef, { lastTicketNumber: ticketNumber });
        tx.create(saleRef, { ...result, account, customerName: customerName || 'Consumidor Final', status: 'Confirmada', createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp() });
        if (account) {
            const paidCents = sale.payment.cashCents + sale.payment.transferCents + sale.payment.cardBaseCents;
            tx.create(db.doc(`secure_customer_debts/${saleRef.id}`), {
                ticketId: saleRef.id, ticketNumber, customerName, items: sale.items,
                itemIds: sale.items.map(item => item.id), paidCents,
                lockedTotalCents: paidCents ? sale.subtotalCents : null,
                payments: paidCents ? [{ payment: sale.payment, baseCents: paidCents, date: new Date().toISOString(), createdBy: request.auth.uid }] : [],
                createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
            });
        }
        tx.create(opRef, { fingerprint: hash, result, createdAt: FieldValue.serverTimestamp() });
        return result;
    });
});

exports.getSaleSeller = guarded(async request => {
    const ticketId = requestId(request.data?.ticketId);
    const [profile, sale] = await Promise.all([
        db.doc(`users/${request.auth.uid}`).get(), db.doc(`secure_sales/${ticketId}`).get()
    ]);
    authorize(request, profile);
    assert(sale.exists && sale.data().status === 'Confirmada', 'La venta no existe.', 'not-found');
    const data = sale.data();
    const savedName = typeof data.sellerName === 'string' ? data.sellerName.trim() : '';
    if (savedName && savedName !== 'No registrado') return { sellerName: savedName };
    assert(typeof data.createdBy === 'string' && data.createdBy.length > 0 &&
        data.createdBy.length <= 128 && !data.createdBy.includes('/'),
    'La venta no tiene un vendedor identificable.', 'failed-precondition');
    const seller = await db.doc(`users/${data.createdBy}`).get();
    const sellerName = seller.exists && typeof seller.data().nick === 'string' ? seller.data().nick.trim() : '';
    assert(sellerName && sellerName.length <= 120, 'No se encontró el perfil del vendedor de esta venta.', 'failed-precondition');
    return { sellerName };
});

exports.getEditableSale = guarded(async request => {
    const ticketId = requestId(request.data?.ticketId);
    const [profile, sale] = await Promise.all([
        db.doc(`users/${request.auth.uid}`).get(), db.doc(`secure_sales/${ticketId}`).get()
    ]);
    authorize(request, profile, true);
    assert(sale.exists && sale.data().status === 'Confirmada', 'La venta no existe.', 'not-found');
    const data = sale.data();
    assert(!data.account, 'Las ventas en cuenta corriente no admiten correcciones desde este módulo.', 'failed-precondition');
    assert(!Object.values(data.returnedQuantities || {}).some(value => value > 0),
        'No se puede editar una venta con devoluciones.', 'failed-precondition');
    return { ticketId, revision: data.revision || 0, items: data.items, payment: data.payment };
});

exports.editSale = guarded(async request => {
    const data = request.data || {};
    const ticketId = requestId(data.ticketId);
    const operationId = requestId(data.operationId);
    assert(Number.isSafeInteger(data.revision) && data.revision >= 0, 'Revisión inválida.');
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    assert(reason.length > 0 && reason.length <= 500, 'Indica el motivo de la corrección.');
    const items = normalizeItems(data.items).map((item, index) => ({
        ...item, priceCents: money(data.items[index].priceCents, 'Precio')
    }));
    const hash = fingerprint({ ticketId, revision: data.revision, reason, items, payment: data.payment });
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const saleRef = db.doc(`secure_sales/${ticketId}`);
    const stateRef = db.doc('app_state/main');
    const operationRef = db.doc(`secure_sale_edits/${request.auth.uid}_${operationId}`);
    return db.runTransaction(async tx => {
        const [profile, saleSnapshot, stateSnapshot, operation] = await Promise.all([
            tx.get(profileRef), tx.get(saleRef), tx.get(stateRef), tx.get(operationRef)
        ]);
        authorize(request, profile, true);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra corrección.', 'already-exists');
            return operation.data().result;
        }
        assert(saleSnapshot.exists && saleSnapshot.data().status === 'Confirmada', 'La venta no existe.', 'not-found');
        const sale = saleSnapshot.data();
        assert(!sale.account, 'Las ventas en cuenta corriente no admiten correcciones desde este módulo.', 'failed-precondition');
        assert((sale.revision || 0) === data.revision, 'La venta cambió. Vuelve a cargarla antes de guardar.', 'failed-precondition');
        assert(!Object.values(sale.returnedQuantities || {}).some(value => value > 0),
            'No se puede editar una venta con devoluciones.', 'failed-precondition');
        assert(Array.isArray(sale.items) && sale.payment && stateSnapshot.exists && Array.isArray(stateSnapshot.data().sales),
            'La venta o su historial no son válidos.', 'failed-precondition');
        const matching = stateSnapshot.data().sales.filter(entry => entry.backendTicketId === ticketId || entry.id === ticketId);
        assert(matching.length === 1, 'No se encontró una única venta en el historial.', 'failed-precondition');
        const oldItems = normalizeItems(sale.items);
        const oldSaleItems = new Map(sale.items.map(item => [item.id, item]));
        const legacy = matching[0];
        const allIds = [...new Set([...oldItems.map(item => item.id), ...items.map(item => item.id)])];
        const refs = allIds.map(id => db.doc(`secure_inventory/${id}`));
        const registerRefs = registers.map(medium => db.doc(`secure_registers/${medium}`));
        const [inventory, cash] = await Promise.all([
            Promise.all(refs.map(ref => tx.get(ref))),
            Promise.all(registerRefs.map(ref => tx.get(ref)))
        ]);
        const oldQuantities = Object.fromEntries(oldItems.map(item => [item.id, item.quantity]));
        const newQuantities = Object.fromEntries(items.map(item => [item.id, item.quantity]));
        const catalog = {};
        inventory.forEach((snapshot, index) => {
            const id = allIds[index];
            if (!snapshot.exists) {
                const oldItem = oldSaleItems.get(id);
                const requested = items.find(entry => entry.id === id);
                if (!oldItem || !requested) {
                    assert(oldItem, `No existe el artículo ${id}.`, 'failed-precondition');
                    return;
                }
                const previousLegacyItem = legacy.items?.find(entry => entry.id === id);
                const name = oldItem.name || previousLegacyItem?.title;
                const type = oldItem.type || previousLegacyItem?.type;
                assert(typeof name === 'string' && name.length > 0 && ['acc', 'phone'].includes(type),
                    `No se puede corregir el artículo eliminado ${id} sin su detalle histórico.`, 'failed-precondition');
                catalog[id] = {
                    id, name, type, active: true, stock: requested.quantity,
                    priceCents: requested.priceCents
                };
                return;
            }
            const item = snapshot.data();
            assert(Number.isSafeInteger(item.stock) && item.stock >= 0 && ['phone', 'acc'].includes(item.type),
                `Stock inválido para ${id}.`, 'failed-precondition');
            const available = item.stock + (oldQuantities[id] || 0);
            const remaining = available - (newQuantities[id] || 0);
            assert(Number.isSafeInteger(remaining) && remaining >= 0 && remaining <= (item.type === 'phone' ? 1 : 1000000),
                `Stock insuficiente o inválido para ${id}.`, 'failed-precondition');
            const requested = items.find(entry => entry.id === id);
            if (requested) {
                assert(item.active === true || oldQuantities[id], `El artículo ${id} no está activo.`, 'failed-precondition');
                catalog[id] = { ...item, active: true, stock: available, priceCents: requested.priceCents };
            }
        });
        const corrected = calculateSale(items, catalog, data.payment);
        const originalAmounts = [sale.payment.cashCents, sale.payment.transferCents, sale.payment.cardNetCents]
            .map(value => money(value, 'Pago original'));
        const newAmounts = [corrected.payment.cashCents, corrected.payment.transferCents, corrected.payment.cardNetCents];
        const changes = newAmounts.map((value, index) => value - originalAmounts[index]);
        const sessions = await Promise.all(cash.map((snapshot, index) => {
            if (!changes[index]) return null;
            assert(snapshot.exists && snapshot.data().open === true && typeof snapshot.data().sessionId === 'string',
                `La caja ${registers[index]} debe estar abierta.`, 'failed-precondition');
            assert(Number.isSafeInteger(snapshot.data().balanceCents + changes[index]) && snapshot.data().balanceCents + changes[index] >= 0,
                `Saldo insuficiente en caja ${registers[index]}.`, 'failed-precondition');
            return tx.get(db.doc(`secure_register_sessions/${snapshot.data().sessionId}`));
        }));
        sessions.forEach((snapshot, index) => {
            if (changes[index]) assert(snapshot?.exists && snapshot.data().open === true &&
                snapshot.data().balanceCents === cash[index].data().balanceCents,
                `La sesión de caja ${registers[index]} no está disponible.`, 'failed-precondition');
        });
        const state = stateSnapshot.data();
        assert(Array.isArray(state.products) && Array.isArray(state.phones),
            'El inventario del historial no es válido.', 'failed-precondition');
        const updatedStock = Object.fromEntries(inventory.flatMap((snapshot, index) => snapshot.exists
            ? [[allIds[index], snapshot.data().stock + (oldQuantities[allIds[index]] || 0) - (newQuantities[allIds[index]] || 0)]] : []));
        const activeItems = Object.fromEntries(inventory.flatMap((snapshot, index) => snapshot.exists
            ? [[allIds[index], snapshot.data().active === true]] : []));
        const products = state.products.map(product => Object.hasOwn(updatedStock, product.id)
            ? { ...product, stock: updatedStock[product.id], status: activeItems[product.id] && updatedStock[product.id] > 0 ? 'Activo' : 'Anulado' }
            : product);
        const phones = state.phones.map(phone => Object.hasOwn(updatedStock, phone.id)
            ? { ...phone, status: activeItems[phone.id] && updatedStock[phone.id] > 0 ? 'En Stock' : 'Vendido' }
            : phone);
        const legacyItems = corrected.items.map(item => ({
            ...legacy.items?.find(entry => entry.id === item.id),
            id: item.id, title: item.name, quantity: item.quantity, price: item.unitPriceCents / 100,
            type: catalog[item.id].type
        }));
        const payment = corrected.payment;
        const media = [payment.cashCents, payment.transferCents, payment.cardBaseCents].filter(value => value > 0).length;
        const paymentMethod = media > 1 ? 'Pago mixto' : payment.cardBaseCents ? 'Tarjeta/Cuotas' : payment.cashCents ? 'Efectivo' : 'Transferencia';
        const updatedLegacy = {
            ...legacy, items: legacyItems, subtotal: corrected.subtotalCents / 100, total: corrected.totalCents / 100,
            surcharge: (corrected.totalCents - corrected.subtotalCents) / 100, paymentMethod, paymentVersion: 2,
            cardPlan: payment.cardPlan, cardCommission: (payment.cardTotalCents - payment.cardNetCents) / 100,
            cardCommissionVat: 0, paymentBreakdown: {
                cash: payment.cashCents / 100, transfer: payment.transferCents / 100, card: payment.cardTotalCents / 100
            }
        };
        const updated = {
            ...corrected,
            items: corrected.items.map(item => ({ ...item, type: catalog[item.id].type })),
            revision: data.revision + 1
        };
        const result = { ticketId, ...updated };
        inventory.forEach((snapshot, index) => {
            if (!snapshot.exists) return;
            const id = allIds[index];
            const stock = snapshot.data().stock + (oldQuantities[id] || 0) - (newQuantities[id] || 0);
            if (stock !== snapshot.data().stock) tx.update(refs[index], { stock });
        });
        cash.forEach((snapshot, index) => {
            if (!changes[index]) return;
            const balanceCents = snapshot.data().balanceCents + changes[index];
            tx.update(registerRefs[index], { balanceCents });
            tx.update(db.doc(`secure_register_sessions/${snapshot.data().sessionId}`), { balanceCents });
            tx.create(db.collection('secure_cash_movements').doc(), {
                medium: registers[index], amountCents: changes[index], sessionId: snapshot.data().sessionId,
                saleId: ticketId, editId: operationRef.id, createdAt: FieldValue.serverTimestamp(), createdBy: request.auth.uid
            });
        });
        tx.update(saleRef, { ...updated, updatedAt: FieldValue.serverTimestamp(), updatedBy: request.auth.uid });
        tx.update(stateRef, {
            sales: state.sales.map(entry => entry.backendTicketId === ticketId || entry.id === ticketId ? updatedLegacy : entry),
            products, phones,
            salesRevision: (stateSnapshot.data().salesRevision || 0) + 1,
            updatedAt: FieldValue.serverTimestamp()
        });
        tx.create(operationRef, {
            fingerprint: hash, result, reason, before: { items: sale.items, payment: sale.payment, totalCents: sale.totalCents },
            after: updated, createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
        });
        return result;
    });
});

exports.recordReturn = guarded(async request => {
    const data = request.data || {};
    const operationId = requestId(data.operationId);
    assert(typeof data.ticketId === 'string' && /^[a-f0-9-]{36}$/i.test(data.ticketId), 'Ticket inválido.');
    const items = normalizeItems(data.items);
    assert(data.items.every(item => typeof item.restock === 'boolean'), 'Indica si cada artículo vuelve al stock.');
    const returnItems = items.map((item, index) => ({ ...item, restock: data.items[index].restock }));
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    assert(reason.length > 0 && reason.length <= 500, 'Indica el motivo de la devolución.');
    const source = data.source || {};
    const allocation = {
        cash: money(source.cash, 'Reembolso de efectivo'),
        transfer: money(source.transfer, 'Reembolso de transferencia'),
        cardToCash: money(source.cardToCash, 'Tarjeta reintegrada en efectivo'),
        cardToTransfer: money(source.cardToTransfer, 'Tarjeta reintegrada en transferencia')
    };
    const hash = fingerprint({ ticketId: data.ticketId, items: returnItems, reason, allocation });
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const saleRef = db.collection('secure_sales').doc(data.ticketId);
    const opRef = db.collection('secure_return_operations').doc(`${request.auth.uid}_${operationId}`);
    const returnRef = db.collection('secure_returns').doc(randomUUID());
    const itemRefs = returnItems.map(item => db.collection('secure_inventory').doc(item.id));
    const registerRefs = ['cash', 'transfer'].map(medium => db.collection('secure_registers').doc(medium));

    return db.runTransaction(async tx => {
        const [profile, operation, saleSnapshot, ...snapshots] = await Promise.all([
            tx.get(profileRef), tx.get(opRef), tx.get(saleRef),
            ...itemRefs.map(ref => tx.get(ref)), ...registerRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile, true);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra operación.', 'already-exists');
            return operation.data().result;
        }
        assert(saleSnapshot.exists && saleSnapshot.data().status === 'Confirmada', 'La venta no existe o no admite devoluciones.', 'failed-precondition');
        const sale = saleSnapshot.data();
        assert(!sale.account, 'Las ventas en cuenta corriente no admiten devoluciones desde este módulo.', 'failed-precondition');
        const returned = { ...(sale.returnedQuantities || {}) };
        const previous = { cash: 0, transfer: 0, card: 0, ...(sale.refundedSources || {}) };
        let totalCents = 0;
        const lines = returnItems.map((item, index) => {
            const line = sale.items.find(entry => entry.id === item.id);
            assert(line && Number.isSafeInteger(line.quantity) && Number.isSafeInteger(line.unitPriceCents), 'El artículo no pertenece a la venta o su importe es inválido.', 'failed-precondition');
            assert(line.type === 'acc', 'Los celulares no admiten devoluciones.', 'failed-precondition');
            const already = returned[item.id] || 0;
            assert(Number.isSafeInteger(already) && already >= 0 && already + item.quantity <= line.quantity, 'La cantidad supera las unidades disponibles para devolución.', 'failed-precondition');
            returned[item.id] = already + item.quantity;
            totalCents = money(totalCents + money(line.unitPriceCents * item.quantity, 'Importe devuelto'), 'Importe devuelto');
            const inventory = snapshots[index];
            if (item.restock) {
                assert(inventory.exists, `No existe el artículo ${item.id} para reponer.`, 'failed-precondition');
                const stock = inventory.data().stock;
                assert(Number.isSafeInteger(stock) && stock >= 0 && stock + item.quantity <= (inventory.data().type === 'phone' ? 1 : 1000000), 'No se puede reponer el stock.', 'failed-precondition');
            }
            return { ...item, name: line.name, unitPriceCents: line.unitPriceCents };
        });

        const cardRefund = money(allocation.cardToCash + allocation.cardToTransfer, 'Reembolso de tarjeta');
        assert(money(allocation.cash + allocation.transfer + cardRefund, 'Reembolso') === totalCents, 'El desglose debe coincidir con el precio base devuelto.');
        assert(previous.cash + allocation.cash <= sale.payment.cashCents &&
            previous.transfer + allocation.transfer <= sale.payment.transferCents &&
            previous.card + cardRefund <= sale.payment.cardBaseCents, 'El reembolso supera el importe pagado por un medio.', 'failed-precondition');
        const payouts = [allocation.cash + allocation.cardToCash, allocation.transfer + allocation.cardToTransfer];
        const registerSnapshots = snapshots.slice(itemRefs.length);
        registerSnapshots.forEach((snapshot, index) => {
            if (!payouts[index]) return;
            assert(snapshot.exists && snapshot.data().open === true, `La caja ${['cash', 'transfer'][index]} debe estar abierta.`, 'failed-precondition');
            assert(Number.isSafeInteger(snapshot.data().balanceCents) && snapshot.data().balanceCents >= payouts[index], 'La caja no tiene saldo suficiente.', 'failed-precondition');
        });
        returnItems.forEach((item, index) => {
            if (item.restock) tx.update(itemRefs[index], { stock: snapshots[index].data().stock + item.quantity, active: true });
        });
        registerSnapshots.forEach((snapshot, index) => {
            if (!payouts[index]) return;
            const register = snapshot.data();
            const balanceCents = register.balanceCents - payouts[index];
            tx.update(registerRefs[index], { balanceCents });
            tx.update(db.doc(`secure_register_sessions/${register.sessionId}`), { balanceCents });
            tx.create(db.collection('secure_cash_movements').doc(), {
                medium: ['cash', 'transfer'][index], amountCents: -payouts[index],
                sessionId: register.sessionId, saleId: saleRef.id, returnId: returnRef.id,
                createdAt: FieldValue.serverTimestamp(), createdBy: request.auth.uid
            });
        });
        tx.update(saleRef, { returnedQuantities: returned, refundedSources: {
            cash: previous.cash + allocation.cash, transfer: previous.transfer + allocation.transfer, card: previous.card + cardRefund
        } });
        const result = { returnId: returnRef.id, ticketId: saleRef.id, items: lines, reason, totalCents, allocation };
        tx.create(returnRef, { ...result, createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp() });
        tx.create(opRef, { fingerprint: hash, result, createdAt: FieldValue.serverTimestamp() });
        return result;
    });
});

exports.getReturnableSale = guarded(async request => {
    const ticketId = requestId(request.data?.ticketId);
    const [profile, snapshot] = await Promise.all([
        db.doc(`users/${request.auth.uid}`).get(), db.doc(`secure_sales/${ticketId}`).get()
    ]);
    authorize(request, profile, true);
    assert(snapshot.exists && snapshot.data().status === 'Confirmada', 'No se encontró la venta.', 'not-found');
    const sale = snapshot.data();
    assert(!sale.account, 'Las ventas en cuenta corriente no admiten devoluciones.', 'failed-precondition');
    assert(Number.isSafeInteger(sale.ticketNumber) && sale.ticketNumber > 0,
        'La venta no tiene un número de ticket asignado. Actualiza la sesión.', 'failed-precondition');
    assert(Array.isArray(sale.items), 'El detalle de venta no es válido.', 'failed-precondition');
    const items = sale.items.filter(item => item.type === 'acc').map(item => ({
        id: item.id, name: item.name, unitPriceCents: item.unitPriceCents,
        available: item.quantity - (sale.returnedQuantities?.[item.id] || 0)
    })).filter(item => item.available > 0);
    return { ticketId, ticketNumber: sale.ticketNumber, customerName: sale.customerName, items };
});

exports.createReturnCredit = guarded(async request => {
    const data = request.data || {};
    const operationId = requestId(data.operationId);
    const ticketId = requestId(data.ticketId);
    const items = normalizeItems(data.items);
    assert(data.items.every(item => typeof item.restock === 'boolean'), 'Indica si cada artículo vuelve al stock.');
    const returns = items.map((item, index) => ({ ...item, restock: data.items[index].restock }));
    const customerName = typeof data.customerName === 'string' ? data.customerName.trim() : '';
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    assert(customerName && customerName.length <= 120 && customerName.toLowerCase() !== 'consumidor final', 'Indica el nombre del cliente.');
    assert(reason && reason.length <= 500, 'Indica el motivo de la devolución.');
    const hash = fingerprint({ ticketId, returns, customerName, reason });
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const saleRef = db.doc(`secure_sales/${ticketId}`);
    const opRef = db.doc(`secure_return_credit_operations/${request.auth.uid}_${operationId}`);
    const creditRef = db.collection('secure_return_credits').doc(randomUUID());
    const refs = returns.map(item => db.doc(`secure_inventory/${item.id}`));
    return db.runTransaction(async tx => {
        const [profile, saleSnapshot, operation, ...inventory] = await Promise.all([
            tx.get(profileRef), tx.get(saleRef), tx.get(opRef), ...refs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile, true);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra operación.', 'already-exists');
            return operation.data().result;
        }
        assert(saleSnapshot.exists && saleSnapshot.data().status === 'Confirmada', 'No se encontró la venta.', 'not-found');
        const sale = saleSnapshot.data();
        assert(!sale.account, 'Las ventas en cuenta corriente no admiten devoluciones.', 'failed-precondition');
        assert(Number.isSafeInteger(sale.ticketNumber) && sale.ticketNumber > 0,
            'La venta no tiene un número de ticket asignado. Actualiza la sesión.', 'failed-precondition');
        const returned = { ...(sale.returnedQuantities || {}) };
        let totalCents = 0;
        const lines = returns.map((item, index) => {
            const line = sale.items.find(entry => entry.id === item.id);
            assert(line && line.type === 'acc', 'Solo se pueden devolver accesorios de la venta.', 'failed-precondition');
            const already = returned[item.id] || 0;
            assert(Number.isSafeInteger(already) && already >= 0 && already + item.quantity <= line.quantity,
                'La cantidad supera las unidades disponibles para devolución.', 'failed-precondition');
            returned[item.id] = already + item.quantity;
            const price = money(line.unitPriceCents, 'Precio devuelto');
            totalCents = money(totalCents + money(price * item.quantity, 'Importe devuelto'), 'Importe devuelto');
            if (item.restock) {
                assert(inventory[index].exists && inventory[index].data().type === 'acc', `No existe ${line.name} para reponer.`, 'failed-precondition');
                const stock = inventory[index].data().stock;
                assert(Number.isSafeInteger(stock) && stock >= 0 && stock + item.quantity <= 1000000, 'No se puede reponer el stock.', 'failed-precondition');
            }
            return { id: item.id, name: line.name, quantity: item.quantity, unitPriceCents: price, restock: item.restock, exchangedQuantity: 0 };
        });
        assert(totalCents > 0, 'El importe de la devolución debe ser mayor que cero.', 'failed-precondition');
        const previous = { cash: 0, transfer: 0, card: 0, ...(sale.refundedSources || {}) };
        let remaining = totalCents;
        const refunded = {};
        for (const [key, paymentKey] of [['cash', 'cashCents'], ['transfer', 'transferCents'], ['card', 'cardBaseCents']]) {
            const available = money(sale.payment[paymentKey], 'Pago original') - money(previous[key], 'Devoluciones anteriores');
            assert(available >= 0, 'Los pagos de la venta requieren revisión.', 'failed-precondition');
            const amount = Math.min(available, remaining);
            refunded[key] = previous[key] + amount;
            remaining -= amount;
        }
        assert(remaining === 0, 'La devolución supera el importe pagado.', 'failed-precondition');
        returns.forEach((item, index) => {
            if (item.restock) tx.update(refs[index], { stock: inventory[index].data().stock + item.quantity, active: true });
        });
        tx.update(saleRef, { returnedQuantities: returned, refundedSources: refunded });
        const result = { creditId: creditRef.id, ticketId, totalCents };
        tx.create(creditRef, {
            ...result, ticketNumber: sale.ticketNumber, customerName, reason, items: lines,
            balanceCents: totalCents, history: [], createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
        });
        tx.create(opRef, { fingerprint: hash, result, createdAt: FieldValue.serverTimestamp() });
        return result;
    });
});

exports.listReturnCredits = guarded(async request => {
    const profile = await db.doc(`users/${request.auth.uid}`).get();
    authorize(request, profile);
    const snapshot = await db.collection('secure_return_credits').get();
    const now = Date.now();
    return snapshot.docs.map(doc => {
        const credit = doc.data();
        const date = credit.createdAt?.toDate?.();
        assert(date && Number.isFinite(date.getTime()), 'La devolución tiene una fecha inválida.', 'failed-precondition');
        return { ...credit, creditId: doc.id, createdAt: date.toISOString(), alertPeriods: returnAlertPeriods(date.getTime(), now) };
    });
});

exports.resolveReturnCredit = guarded(async request => {
    const data = request.data || {};
    const operationId = requestId(data.operationId);
    const creditId = requestId(data.creditId);
    const expectedBalanceCents = money(data.expectedBalanceCents, 'Saldo esperado');
    assert(Array.isArray(data.items), 'Indica los productos del cambio.');
    const items = data.items.length ? normalizeItems(data.items).map((item, index) => ({
        ...item, expectedPriceCents: money(data.items[index].expectedPriceCents, 'Precio esperado')
    })) : [];
    assert(['keep', 'cash', 'transfer'].includes(data.remainder), 'Indica qué hacer con el saldo restante.');
    const payment = calculatePayment(data.payment);
    const paidBase = money(payment.cashCents + payment.transferCents + payment.cardBaseCents, 'Pago');
    const hash = fingerprint({ creditId, expectedBalanceCents, items, remainder: data.remainder, payment: data.payment });
    const creditRef = db.doc(`secure_return_credits/${creditId}`);
    const opRef = db.doc(`secure_return_resolution_operations/${request.auth.uid}_${operationId}`);
    const refs = items.map(item => db.doc(`secure_inventory/${item.id}`));
    const registerRefs = registers.map(medium => db.doc(`secure_registers/${medium}`));
    return db.runTransaction(async tx => {
        const [profile, snapshot, operation, ...all] = await Promise.all([
            tx.get(db.doc(`users/${request.auth.uid}`)), tx.get(creditRef), tx.get(opRef),
            ...refs.map(ref => tx.get(ref)), ...registerRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile, true);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra operación.', 'already-exists');
            return operation.data().result;
        }
        assert(snapshot.exists, 'No se encontró la devolución.', 'not-found');
        const credit = snapshot.data();
        const balance = money(credit.balanceCents, 'Saldo a favor');
        assert(balance > 0 && balance === expectedBalanceCents, 'El saldo cambió. Actualiza la devolución antes de continuar.', 'failed-precondition');
        const original = credit.items.map(item => ({ ...item }));
        const inventory = all.slice(0, refs.length);
        let valueCents = 0;
        const delivered = items.map((item, index) => {
            const product = inventory[index].exists ? inventory[index].data() : null;
            assert(product && product.active === true && Number.isSafeInteger(product.stock) && product.stock >= item.quantity,
                `Stock insuficiente para ${item.id}.`, 'failed-precondition');
            const currentPrice = money(product.priceCents, 'Precio actual');
            assert(currentPrice === item.expectedPriceCents, `El precio de ${product.name} cambió. Actualiza la selección.`, 'failed-precondition');
            const line = original.find(entry => entry.id === item.id);
            if (line) assert(Number.isSafeInteger(line.exchangedQuantity) && line.exchangedQuantity >= 0 &&
                Number.isSafeInteger(line.quantity) && line.exchangedQuantity <= line.quantity,
            'El detalle de la devolución no es válido.', 'failed-precondition');
            const sameQty = line ? Math.min(item.quantity, line.quantity - line.exchangedQuantity) : 0;
            const lineValue = money(sameQty * (line?.unitPriceCents || 0) + (item.quantity - sameQty) * currentPrice, 'Valor del cambio');
            if (line) line.exchangedQuantity += sameQty;
            valueCents = money(valueCents + lineValue, 'Valor del cambio');
            return { id: item.id, name: product.name, quantity: item.quantity, sameQty, currentPriceCents: currentPrice, valueCents: lineValue };
        });
        const due = Math.max(0, valueCents - balance);
        assert(paidBase === due, 'El pago debe cubrir exactamente la diferencia del cambio.', 'failed-precondition');
        const remaining = Math.max(0, balance - valueCents);
        assert(items.length || data.remainder !== 'keep', 'Selecciona productos o devuelve el saldo.', 'failed-precondition');
        const refund = data.remainder === 'keep' ? 0 : remaining;
        assert(items.length > 0 || refund > 0, 'No hay importe para resolver.', 'failed-precondition');
        const balances = [payment.cashCents - (data.remainder === 'cash' ? refund : 0),
            payment.transferCents - (data.remainder === 'transfer' ? refund : 0), payment.cardNetCents];
        const cash = all.slice(refs.length);
        const sessions = await Promise.all(cash.map((register, index) => {
            if (!balances[index]) return null;
            assert(register.exists && register.data().open === true && typeof register.data().sessionId === 'string',
                `La caja ${registers[index]} debe estar abierta.`, 'failed-precondition');
            money(register.data().balanceCents + balances[index], 'Saldo de caja');
            return tx.get(db.doc(`secure_register_sessions/${register.data().sessionId}`));
        }));
        sessions.forEach((session, index) => {
            if (balances[index]) assert(session?.exists && session.data().open === true &&
                session.data().balanceCents === cash[index].data().balanceCents,
            `La sesión de caja ${registers[index]} no está disponible.`, 'failed-precondition');
        });
        inventory.forEach((entry, index) => tx.update(refs[index], { stock: entry.data().stock - items[index].quantity }));
        cash.forEach((entry, index) => {
            if (!balances[index]) return;
            const register = entry.data();
            const balanceCents = register.balanceCents + balances[index];
            tx.update(registerRefs[index], { balanceCents });
            tx.update(db.doc(`secure_register_sessions/${register.sessionId}`), { balanceCents });
            tx.create(db.collection('secure_cash_movements').doc(), {
                medium: registers[index], amountCents: balances[index], sessionId: register.sessionId,
                creditId, createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
            });
        });
        const remainingBalance = remaining - refund;
        const entry = { items: delivered, valueCents, refundCents: refund, refundMedium: refund ? data.remainder : '',
            payment, date: new Date().toISOString(), createdBy: request.auth.uid };
        if (delivered.length) {
            tx.create(db.collection('secure_return_exchanges').doc(), {
                creditId, totalCents: money(valueCents + payment.cardTotalCents - payment.cardBaseCents, 'Total del cambio'),
                items: delivered, payment, createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
            });
        }
        tx.update(creditRef, { balanceCents: remainingBalance, items: original, history: [...credit.history, entry] });
        const result = { creditId, balanceCents: remainingBalance, ...entry };
        tx.create(opRef, { fingerprint: hash, result, createdAt: FieldValue.serverTimestamp() });
        return result;
    });
});
