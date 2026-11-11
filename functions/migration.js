'use strict';

function cents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100))) return null;
    return Math.round(value * 100);
}

function previewMigration(state) {
    if (!state || !Array.isArray(state.products) || !Array.isArray(state.phones) || !Array.isArray(state.sales)) {
        throw new Error('El estado anterior no contiene las listas de productos, celulares y ventas.');
    }
    const seen = new Set();
    const inventory = [...state.products.map(item => ({ item, type: 'acc' })), ...state.phones.map(item => ({ item, type: 'phone' }))].map(({ item, type }) => {
        const issues = [];
        const id = item?.id;
        if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) issues.push('Identificador inválido');
        else if (seen.has(id)) issues.push('Identificador duplicado');
        else seen.add(id);
        const name = type === 'acc' ? item?.title : [item?.brand, item?.model, item?.storage, item?.condition].filter(Boolean).join(' ');
        if (typeof name !== 'string' || !name.trim() || name.length > 200) issues.push('Nombre inválido');
        const priceCents = cents(item?.price);
        if (priceCents === null) issues.push('Precio inválido');
        if (type === 'phone' && item?.currency === 'USD') issues.push('Precio en USD requiere conciliación con la cotización vigente');
        const stock = type === 'acc' ? item?.stock : item?.status === 'En Stock' ? 1 : 0;
        if (!Number.isSafeInteger(stock) || stock < 0 || stock > 1000000) issues.push('Stock inválido');
        if (type === 'phone' && item?.status === 'Reservado') issues.push('Celular reservado requiere conciliación');
        if (type === 'phone' && !['En Stock', 'Reservado', 'Vendido'].includes(item?.status)) issues.push('Estado de celular desconocido');
        if (type === 'acc' && item?.status && !['Activo', 'Anulado'].includes(item.status)) issues.push('Estado de producto desconocido');
        return { id: id || null, type, name: name || null, stock, priceCents, active: type === 'acc' ? item?.status !== 'Anulado' : item?.status === 'En Stock', legacyStatus: item?.status || null, issues };
    });
    const saleIds = new Set();
    const sales = state.sales.map(sale => {
        const issues = [];
        if (typeof sale?.id !== 'string' || !sale.id.trim()) issues.push('Ticket sin identificador');
        else if (saleIds.has(sale.id)) issues.push('Número de ticket duplicado');
        else saleIds.add(sale.id);
        if (!Array.isArray(sale?.items) || !sale.items.length || sale.items.some(item =>
            !item || typeof item.id !== 'string' || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || cents(item.price) === null
        )) issues.push('Detalle de artículos incompleto');
        if (cents(sale?.total) === null || cents(sale?.subtotal) === null) issues.push('Importes inválidos');
        if (sale?.status === 'Pendiente de emisión') issues.push('Venta pendiente requiere conciliación');
        if (sale?.paymentMethod === 'Efectivo/Transferencia' || (sale?.paymentMethod === 'Pago mixto' && sale?.paymentVersion !== 2)) {
            issues.push('Medio de pago sin discriminar: requiere confirmación del administrador');
        }
        if (sale?.canjeDeduction > 0) issues.push('Descuento por canje requiere conciliación');
        if (sale?.paymentMethod === 'Cuenta corriente') issues.push('Cuenta corriente requiere conciliación');
        return { id: sale?.id || null, status: sale?.status || null, paymentMethod: sale?.paymentMethod || null, totalCents: cents(sale?.total), issues };
    });
    return { inventory, sales, inventoryIssues: inventory.filter(item => item.issues.length).length, saleIssues: sales.filter(sale => sale.issues.length).length };
}

module.exports = { previewMigration };
