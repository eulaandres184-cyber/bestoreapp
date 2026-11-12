'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { createHash, randomUUID } = require('node:crypto');
const { DomainError, assert, money, normalizeItems, calculateSale } = require('./domain');
const { previewMigration } = require('./migration');

initializeApp();
const db = getFirestore();
const options = { region: 'us-central1', maxInstances: 10 };
const registers = ['cash', 'transfer', 'card'];

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
    return preview;
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

exports.setUserRole = guarded(async request => {
    const { uid, role } = request.data || {};
    assert(typeof uid === 'string' && uid.length > 0 && uid.length <= 128, 'Usuario inválido.');
    assert(role === 'admin' || role === 'seller', 'Rol inválido.');
    assert(uid !== request.auth.uid || role === 'admin', 'No puedes quitarte el rol de administrador.', 'permission-denied');

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
    return db.runTransaction(async tx => {
        const [profile, item] = await Promise.all([tx.get(profileRef), tx.get(itemRef)]);
        authorize(request, profile, true);
        const updated = { id, name, type: data.type, active: data.active, stock: data.stock, priceCents: data.priceCents };
        tx.set(itemRef, { ...updated, updatedBy: request.auth.uid, updatedAt: FieldValue.serverTimestamp() });
        tx.create(db.collection('secure_inventory_audit').doc(), {
            itemId: id, before: item.exists ? item.data() : null, after: updated,
            createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp()
        });
        return updated;
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

exports.recordSale = guarded(async request => {
    const data = request.data || {};
    const operationId = requestId(data.operationId);
    const items = normalizeItems(data.items);
    const customerName = typeof data.customerName === 'string' ? data.customerName.trim() : '';
    assert(customerName.length <= 120, 'Nombre de cliente demasiado largo.');
    const payment = data.payment;
    const hash = fingerprint({ items, customerName, payment });
    const profileRef = db.doc(`users/${request.auth.uid}`);
    const opRef = db.collection('secure_sale_operations').doc(`${request.auth.uid}_${operationId}`);
    const saleRef = db.collection('secure_sales').doc(randomUUID());
    const stockRefs = items.map(item => db.collection('secure_inventory').doc(item.id));
    const registerRefs = registers.map(medium => db.collection('secure_registers').doc(medium));

    return db.runTransaction(async tx => {
        const [profile, operation, ...snapshots] = await Promise.all([
            tx.get(profileRef), tx.get(opRef), ...stockRefs.map(ref => tx.get(ref)), ...registerRefs.map(ref => tx.get(ref))
        ]);
        authorize(request, profile);
        if (operation.exists) {
            assert(operation.data().fingerprint === hash, 'El identificador ya corresponde a otra operación.', 'already-exists');
            return operation.data().result;
        }
        const stockSnapshots = snapshots.slice(0, stockRefs.length);
        const registerSnapshots = snapshots.slice(stockRefs.length);
        const catalog = Object.fromEntries(stockSnapshots.map((snapshot, index) => [items[index].id, snapshot.exists ? snapshot.data() : null]));
        const sale = calculateSale(items, catalog, payment);
        const movements = [sale.payment.cashCents, sale.payment.transferCents, sale.payment.cardNetCents];
        registerSnapshots.forEach((snapshot, index) => {
            if (movements[index] === 0) return;
            assert(snapshot.exists && snapshot.data().open === true, `La caja ${registers[index]} debe estar abierta.`, 'failed-precondition');
            money(snapshot.data().balanceCents + movements[index], 'Saldo de caja');
        });

        stockSnapshots.forEach((snapshot, index) => {
            tx.update(stockRefs[index], { stock: snapshot.data().stock - items[index].quantity });
        });
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
            ...sale,
            items: sale.items.map((item, index) => ({
                ...item,
                stockAfter: stockSnapshots[index].data().stock - items[index].quantity
            }))
        };
        tx.create(saleRef, { ...result, customerName: customerName || 'Cliente Mostrador', status: 'Confirmada', createdBy: request.auth.uid, createdAt: FieldValue.serverTimestamp() });
        tx.create(opRef, { fingerprint: hash, result, createdAt: FieldValue.serverTimestamp() });
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
        const returned = { ...(sale.returnedQuantities || {}) };
        const previous = { cash: 0, transfer: 0, card: 0, ...(sale.refundedSources || {}) };
        let totalCents = 0;
        const lines = returnItems.map((item, index) => {
            const line = sale.items.find(entry => entry.id === item.id);
            assert(line && Number.isSafeInteger(line.quantity) && Number.isSafeInteger(line.unitPriceCents), 'El artículo no pertenece a la venta o su importe es inválido.', 'failed-precondition');
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
            if (item.restock) tx.update(itemRefs[index], { stock: snapshots[index].data().stock + item.quantity });
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
