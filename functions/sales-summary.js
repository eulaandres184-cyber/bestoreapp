'use strict';

const { DomainError } = require('./domain');

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit'
});

function invalid(message) {
    throw new DomainError('failed-precondition', message);
}

function checkedCents(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} inválido.`);
    return value;
}

function addCents(a, b) {
    const result = a + b;
    if (!Number.isSafeInteger(result)) invalid('El total de ventas supera el límite permitido.');
    return result;
}

function legacyDate(value) {
    if (typeof value !== 'string') invalid('Hay una venta anterior sin fecha válida.');
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s|$)/.exec(value);
    if (!match) invalid('Hay una venta anterior sin fecha válida.');
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        invalid('Hay una venta anterior sin fecha válida.');
    }
    return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function summarizeSales(secureSales, legacySales, now = new Date()) {
    const today = dateFormatter.format(now);
    const result = { todayCount: 0, todayCents: 0, totalCount: 0, netCents: 0 };
    const secureIds = new Set(secureSales.map(sale => sale.id));
    const include = (date, totalCents, refundCents) => {
        if (refundCents > totalCents) invalid('Las devoluciones superan el importe de una venta.');
        result.totalCount += 1;
        result.netCents = addCents(result.netCents, totalCents - refundCents);
        if (date === today) {
            result.todayCount += 1;
            result.todayCents = addCents(result.todayCents, totalCents);
        }
    };

    for (const sale of secureSales) {
        if (sale.status !== 'Confirmada') invalid(`Estado inválido en la venta ${sale.id}.`);
        const date = sale.createdAt?.toDate?.();
        if (!(date instanceof Date) || !Number.isFinite(date.getTime())) invalid(`Fecha inválida en la venta ${sale.id}.`);
        const refunded = sale.refundedSources ?? { cash: 0, transfer: 0, card: 0 };
        const refundCents = ['cash', 'transfer', 'card'].reduce(
            (sum, key) => addCents(sum, checkedCents(refunded[key], `Devolución de ${sale.id}`)), 0
        );
        include(dateFormatter.format(date), checkedCents(sale.totalCents, `Total de ${sale.id}`), refundCents);
    }

    const legacyIds = new Set();
    for (const sale of legacySales) {
        if (!sale || typeof sale.id !== 'string' || !sale.id) invalid('Hay una venta anterior sin identificador.');
        if (legacyIds.has(sale.id)) invalid(`Hay ventas anteriores con el identificador duplicado ${sale.id}.`);
        legacyIds.add(sale.id);
        if (sale.backendTicketId) {
            if (!secureIds.has(sale.backendTicketId)) invalid(`No se encontró la venta segura ${sale.backendTicketId}.`);
            continue;
        }
        if (secureIds.has(sale.id)) continue;
        if (sale.status === 'Anulada' || sale.status === 'Pendiente de emisión') continue;
        if (typeof sale.total !== 'number' || !Number.isFinite(sale.total) || sale.total < 0) {
            invalid(`Total inválido en la venta anterior ${sale.id}.`);
        }
        include(legacyDate(sale.date), checkedCents(Math.round(sale.total * 100), `Total de ${sale.id}`), 0);
    }
    return result;
}

module.exports = { summarizeSales };
