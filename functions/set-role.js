'use strict';

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

async function main() {
    const [projectId, uid, role] = process.argv.slice(2);
    if (!projectId || !uid || !['admin', 'seller'].includes(role) || process.argv.length !== 5) {
        throw new Error('Uso: node set-role.js PROJECT_ID UID admin|seller');
    }
    const app = initializeApp({ credential: applicationDefault(), projectId });
    const auth = getAuth(app);
    const db = getFirestore(app);
    const user = await auth.getUser(uid);
    if (user.disabled) throw new Error('La cuenta de Firebase Auth está deshabilitada.');
    const profileRef = db.collection('users').doc(uid);
    const operationRef = db.collection('secure_permission_changes').doc();
    await db.runTransaction(async tx => {
        const profile = await tx.get(profileRef);
        if (!profile.exists || profile.data().active !== true) throw new Error('El perfil no existe o no está activo.');
        tx.update(profileRef, { role, permissionChangeId: operationRef.id });
        tx.create(operationRef, {
            uid, role, previousRole: profile.data().role || null,
            status: 'pending', createdAt: FieldValue.serverTimestamp()
        });
    });
    try {
        await auth.setCustomUserClaims(uid, { ...user.customClaims, bestoreRole: role });
        await auth.revokeRefreshTokens(uid);
        await operationRef.update({ status: 'applied', appliedAt: FieldValue.serverTimestamp() });
    } catch (error) {
        console.error(`El perfil y las claims pueden no coincidir; revisar la operación ${operationRef.id} antes de continuar.`);
        throw error;
    }
    console.log(`Permiso ${role} asignado. El usuario debe volver a iniciar sesión.`);
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
