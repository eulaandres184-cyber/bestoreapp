'use strict';

const { createHash } = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { migrationSourceHash, planMigration } = require('./migration');

const sourcePath = 'app_state/main';
const markerPath = 'secure_migrations/legacy_app_state_main';
const maxBatchOperations = 400;

function parseArguments(argv) {
    const options = { apply: false, project: '', confirmedFrozenProject: '' };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--apply') {
            options.apply = true;
        } else if (argument === '--project' && argv[index + 1]) {
            options.project = argv[++index];
        } else if (argument === '--confirm-legacy-freeze' && argv[index + 1]) {
            options.confirmedFrozenProject = argv[++index];
        } else {
            throw new Error(`Argumento desconocido o incompleto: ${argument}`);
        }
    }
    if (!options.project) throw new Error('Indica el proyecto con --project PROJECT_ID.');
    if (options.apply && options.confirmedFrozenProject !== options.project) {
        throw new Error('Para escribir, confirma el congelamiento con --confirm-legacy-freeze PROJECT_ID.');
    }
    return options;
}

function chunk(items, size) {
    const chunks = [];
    for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
    return chunks;
}

function itemMatches(existing, expected) {
    return ['id', 'name', 'type', 'active', 'stock', 'priceCents']
        .every(key => existing[key] === expected[key]);
}

async function loadExisting(db, refs) {
    const existing = new Map();
    for (const refsChunk of chunk(refs, 250)) {
        const snapshots = await db.getAll(...refsChunk);
        for (const snapshot of snapshots) {
            if (snapshot.exists) existing.set(snapshot.ref.path, snapshot.data());
        }
    }
    return existing;
}

async function verifySourceUnchanged(sourceRef, sourceHash) {
    const snapshot = await sourceRef.get();
    if (!snapshot.exists || migrationSourceHash(snapshot.data()) !== sourceHash) {
        throw new Error('app_state/main cambió durante la migración; se detuvieron nuevas escrituras.');
    }
}

async function migrate(db, projectId, state, plan) {
    const sourceHash = migrationSourceHash(state);
    const sourceRef = db.doc(sourcePath);
    const markerRef = db.doc(markerPath);
    const marker = await markerRef.get();
    if (marker.exists) {
        const data = marker.data();
        if (data.status === 'complete' && data.sourceHash === sourceHash) {
            return { alreadyMigrated: true, sourceHash };
        }
        throw new Error('Ya existe una marca de migración distinta o incompleta; requiere revisión manual.');
    }

    const inventoryRefs = plan.inventory.map(item => db.doc(`secure_inventory/${item.id}`));
    const legacySaleRefs = plan.legacySales.map(sale => db.doc(`secure_legacy_sales/${sale.id}`));
    const auditRefs = plan.inventory.map(item => db.doc(
        `secure_inventory_audit/legacy_${createAuditId(sourceHash, item.id)}`
    ));
    const existing = await loadExisting(db, [...inventoryRefs, ...legacySaleRefs, ...auditRefs]);
    const operations = [];
    let inventoryCreated = 0;
    let inventoryAlreadyPresent = 0;
    let legacySalesArchived = 0;
    let legacySalesAlreadyPresent = 0;

    plan.inventory.forEach((item, index) => {
        const ref = inventoryRefs[index];
        const current = existing.get(ref.path);
        if (current && !itemMatches(current, item.data)) {
            throw new Error(`Conflicto en secure_inventory/${item.id}; no se sobrescribió.`);
        }
        if (!current) {
            inventoryCreated += 1;
            operations.push({ ref, data: {
                ...item.data,
                migratedFrom: sourcePath,
                migrationSourceHash: sourceHash,
                updatedBy: 'legacy-migration',
                updatedAt: FieldValue.serverTimestamp()
            } });
        } else {
            inventoryAlreadyPresent += 1;
        }
        const auditRef = auditRefs[index];
        if (!current || (current.migrationSourceHash === sourceHash && !existing.has(auditRef.path))) {
            operations.push({ ref: auditRef, data: {
                itemId: item.id,
                before: null,
                after: item.data,
                source: sourcePath,
                sourceHash,
                createdBy: 'legacy-migration',
                createdAt: FieldValue.serverTimestamp()
            } });
        }
    });

    plan.legacySales.forEach((sale, index) => {
        const ref = legacySaleRefs[index];
        const current = existing.get(ref.path);
        if (current && (current.legacyTicketId !== sale.legacyTicketId || current.sourceHash !== sourceHash)) {
            throw new Error(`Conflicto en ${ref.path}; no se sobrescribió.`);
        }
        if (!current) {
            legacySalesArchived += 1;
            operations.push({ ref, data: {
                legacyTicketId: sale.legacyTicketId,
                sale: sale.data,
                source: sourcePath,
                sourceHash,
                migratedAt: FieldValue.serverTimestamp()
            } });
        } else {
            legacySalesAlreadyPresent += 1;
        }
    });

    for (const operationsChunk of chunk(operations, maxBatchOperations)) {
        await verifySourceUnchanged(sourceRef, sourceHash);
        const batch = db.batch();
        for (const operation of operationsChunk) batch.create(operation.ref, operation.data);
        await batch.commit();
    }
    await verifySourceUnchanged(sourceRef, sourceHash);

    const summary = {
        status: 'complete',
        projectId,
        source: sourcePath,
        sourceHash,
        inventoryCreated,
        inventoryAlreadyPresent,
        legacySalesArchived,
        legacySalesAlreadyPresent,
        inventorySkipped: plan.skippedInventory,
        salesSkipped: plan.skippedSales,
        completedAt: FieldValue.serverTimestamp()
    };
    await db.runTransaction(async transaction => {
        const [currentSource, currentMarker] = await Promise.all([
            transaction.get(sourceRef),
            transaction.get(markerRef)
        ]);
        if (!currentSource.exists || migrationSourceHash(currentSource.data()) !== sourceHash) {
            throw new Error('app_state/main cambió antes de registrar la finalización.');
        }
        if (currentMarker.exists) {
            if (currentMarker.data().status === 'complete' && currentMarker.data().sourceHash === sourceHash) return;
            throw new Error('La marca de migración cambió antes de registrar la finalización.');
        }
        transaction.create(markerRef, summary);
    });
    return { alreadyMigrated: false, sourceHash, ...summary };
}

function createAuditId(sourceHash, itemId) {
    return createHash('sha256').update(`${sourceHash}:${itemId}`).digest('hex');
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const app = initializeApp({ projectId: options.project });
    try {
        const db = getFirestore(app);
        const source = await db.doc(sourcePath).get();
        if (!source.exists) throw new Error('No existe app_state/main en el proyecto indicado.');
        const state = source.data();
        const plan = planMigration(state);
        const summary = {
            projectId: options.project,
            inventoryEligible: plan.inventory.length,
            inventorySkipped: plan.skippedInventory,
            legacySalesEligible: plan.legacySales.length,
            salesSkipped: plan.skippedSales
        };
        console.log(JSON.stringify(summary));
        if (!options.apply) {
            console.log('Vista previa solamente; no se escribieron datos. Usa --apply y confirma el congelamiento para migrar.');
            return;
        }
        const result = await migrate(db, options.project, state, plan);
        console.log(result.alreadyMigrated
            ? 'La misma versión del origen ya fue migrada.'
            : 'Migración completada; el origen se conservó sin cambios.');
    } finally {
        await app.delete();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`No se completó la migración: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { migrate, parseArguments };
