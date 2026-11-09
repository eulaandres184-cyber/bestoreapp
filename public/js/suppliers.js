/* MÓDULO DE PROVEEDORES
   Datos (definidos en app.js): SUPPLIERS, PURCHASES, SUPPLIER_PAYMENTS.
   - Compra: { id, supplierId, date, receipt, type: 'products'|'phones', currency, dollarRate, items[], totalOriginal, totalArs }
   - Pago:   { id, supplierId, purchaseId, date, dateLabel, method, amount (ARS), reference }
   La deuda de un proveedor = compras (ARS) - pagos (ARS). */

const SUPPLIER_PHONE_CONDITIONS = ['Nuevo', 'Usado Excelente', 'Usado Bueno', 'Usado con detalles'];
let openSupplierDetailId = null;

function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function money(value) {
    return `$${Math.round(value || 0).toLocaleString('es-AR')}`;
}

function todayIso() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isoToLabel(iso) {
    return new Date(`${iso}T00:00:00`).toLocaleDateString('es-AR');
}

function supplierCashPaidOn(dateLabel) {
    return SUPPLIER_PAYMENTS
        .filter(payment => payment.method === 'Efectivo' && payment.dateLabel === dateLabel)
        .reduce((sum, payment) => sum + payment.amount, 0);
}

function supplierTotals(supplierId) {
    const bought = PURCHASES.filter(purchase => purchase.supplierId === supplierId).reduce((sum, purchase) => sum + purchase.totalArs, 0);
    const paid = SUPPLIER_PAYMENTS.filter(payment => payment.supplierId === supplierId).reduce((sum, payment) => sum + payment.amount, 0);
    return { bought, paid, debt: bought - paid };
}

function purchaseBalance(purchase) {
    const paid = SUPPLIER_PAYMENTS.filter(payment => payment.purchaseId === purchase.id).reduce((sum, payment) => sum + payment.amount, 0);
    return purchase.totalArs - paid;
}

/* ---------- Proveedores (ABM) ---------- */
function renderSuppliers() {
    const body = document.getElementById('suppliersTableBody');
    if (!body) return;

    const all = SUPPLIERS.map(supplier => ({ supplier, ...supplierTotals(supplier.id) }));
    const totalBought = all.reduce((sum, row) => sum + row.bought, 0);
    const totalPaid = all.reduce((sum, row) => sum + row.paid, 0);
    const byMethod = SUPPLIER_PAYMENTS.reduce((result, payment) => {
        result[payment.method] = (result[payment.method] || 0) + payment.amount;
        return result;
    }, {});
    const methodsText = Object.entries(byMethod).map(([method, amount]) => `${escHtml(method)}: ${money(amount)}`).join(' · ') || 'Sin pagos';
    document.getElementById('supplierSummary').innerHTML = `
        <div class="custom-card p-4"><span class="block text-slate-500">Proveedores</span><strong class="text-lg">${SUPPLIERS.length}</strong></div>
        <div class="custom-card p-4"><span class="block text-slate-500">Total comprado</span><strong class="text-lg">${money(totalBought)}</strong></div>
        <div class="custom-card p-4"><span class="block text-slate-500">Total pagado</span><strong class="text-lg text-emerald-700">${money(totalPaid)}</strong><span class="block text-[10px] text-slate-500 mt-1">${methodsText}</span></div>
        <div class="custom-card p-4"><span class="block text-slate-500">Deuda total</span><strong class="text-lg ${totalBought - totalPaid > 0 ? 'text-amber-700' : 'text-slate-900'}">${money(totalBought - totalPaid)}</strong></div>`;

    body.innerHTML = all.map(({ supplier, bought, paid, debt }) => {
        const whatsapp = (supplier.phone || '').replace(/\D/g, '');
        const phone = whatsapp
            ? `<a href="https://wa.me/${whatsapp}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:underline"><i class="fa-brands fa-whatsapp"></i>${escHtml(supplier.phone)}</a>`
            : '';
        return `<tr class="border-b border-slate-100">
            <td class="p-3"><span class="font-semibold">${escHtml(supplier.name)}</span>${supplier.category ? `<span class="block text-[10px] text-slate-500">${escHtml(supplier.category)}</span>` : ''}${supplier.taxId ? `<span class="block text-[10px] text-slate-400">CUIT ${escHtml(supplier.taxId)}</span>` : ''}</td>
            <td class="p-3">${phone}${supplier.contact ? `<span class="block text-[10px] text-slate-500">${escHtml(supplier.contact)}</span>` : ''}${supplier.bank ? `<span class="block text-[10px] font-mono-num text-slate-500">${escHtml(supplier.bank)}</span>` : ''}</td>
            <td class="p-3 text-right font-mono-num">${money(bought)}</td>
            <td class="p-3 text-right font-mono-num">${money(paid)}</td>
            <td class="p-3 text-right font-mono-num font-bold ${debt > 0 ? 'text-amber-700' : ''}">${money(debt)}</td>
            <td class="p-3 text-center whitespace-nowrap">
                <button onclick="openPurchaseModal('${supplier.id}')" class="p-1.5 rounded-lg bg-sky-100 hover:bg-sky-200 text-sky-700" title="Registrar compra"><i class="fa-solid fa-cart-plus"></i></button>
                <button onclick="openSupplierPaymentModal('${supplier.id}')" class="p-1.5 rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-700" title="Registrar pago"><i class="fa-solid fa-money-bill-transfer"></i></button>
                <button onclick="showSupplierDetail('${supplier.id}')" class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700" title="Ver historial"><i class="fa-solid fa-clock-rotate-left"></i></button>
                <button onclick="editSupplier('${supplier.id}')" class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700" title="Editar"><i class="fa-solid fa-pen"></i></button>
            </td></tr>`;
    }).join('') || '<tr><td colspan="6" class="p-6 text-center text-slate-400">No hay proveedores registrados.</td></tr>';

    if (openSupplierDetailId) showSupplierDetail(openSupplierDetailId);
}

async function saveSupplier(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const id = document.getElementById('supplierId').value;
    const data = {
        name: document.getElementById('supplierName').value.trim(),
        taxId: document.getElementById('supplierTaxId').value.trim(),
        category: document.getElementById('supplierCategory').value.trim(),
        contact: document.getElementById('supplierContact').value.trim(),
        phone: document.getElementById('supplierPhone').value.trim(),
        email: document.getElementById('supplierEmail').value.trim(),
        bank: document.getElementById('supplierBank').value.trim(),
        notes: document.getElementById('supplierNotes').value.trim()
    };
    const index = SUPPLIERS.findIndex(supplier => supplier.id === id);
    if (index > -1) SUPPLIERS[index] = { ...SUPPLIERS[index], ...data };
    else SUPPLIERS.push({ id: `SUP-${Date.now()}`, ...data });
    await saveLocalState();
    cancelSupplierEdit();
    renderSuppliers();
    showToast(index > -1 ? 'Proveedor actualizado.' : 'Proveedor registrado.');
}

function editSupplier(id) {
    const supplier = SUPPLIERS.find(item => item.id === id);
    if (!supplier) return;
    document.getElementById('supplierId').value = supplier.id;
    document.getElementById('supplierName').value = supplier.name;
    document.getElementById('supplierTaxId').value = supplier.taxId || '';
    document.getElementById('supplierCategory').value = supplier.category || '';
    document.getElementById('supplierContact').value = supplier.contact || '';
    document.getElementById('supplierPhone').value = supplier.phone || '';
    document.getElementById('supplierEmail').value = supplier.email || '';
    document.getElementById('supplierBank').value = supplier.bank || '';
    document.getElementById('supplierNotes').value = supplier.notes || '';
    document.getElementById('supplierFormTitle').textContent = 'Editar proveedor';
    document.getElementById('supplierSubmitButton').textContent = 'Guardar cambios';
    document.getElementById('cancelSupplierEditButton').classList.remove('hidden');
    document.getElementById('supplierName').focus();
}

function cancelSupplierEdit() {
    document.getElementById('supplierId').closest('form').reset();
    document.getElementById('supplierId').value = '';
    document.getElementById('supplierFormTitle').textContent = 'Proveedores';
    document.getElementById('supplierSubmitButton').textContent = 'Registrar proveedor';
    document.getElementById('cancelSupplierEditButton').classList.add('hidden');
}

/* ---------- Historial / detalle ---------- */
function showSupplierDetail(id) {
    const supplier = SUPPLIERS.find(item => item.id === id);
    const panel = document.getElementById('supplierDetail');
    if (!supplier) {
        openSupplierDetailId = null;
        panel.classList.add('hidden');
        return;
    }
    openSupplierDetailId = id;
    const movements = [
        ...PURCHASES.filter(purchase => purchase.supplierId === id).map(purchase => ({ kind: 'purchase', date: purchase.date, purchase })),
        ...SUPPLIER_PAYMENTS.filter(payment => payment.supplierId === id).map(payment => ({ kind: 'payment', date: payment.date, payment }))
    ].sort((a, b) => a.date.localeCompare(b.date));

    const rows = movements.map(movement => {
        if (movement.kind === 'purchase') {
            const purchase = movement.purchase;
            const detail = purchase.items.map(item => purchase.type === 'phones'
                ? `${escHtml(item.brand)} ${escHtml(item.model)} ${escHtml(item.storage)} (${escHtml(item.condition)}, IMEI ${escHtml(item.imei)})`
                : `${item.qty} x ${escHtml(item.description)}`).join('<br>');
            const usd = purchase.currency === 'USD' ? `<span class="block text-[10px] text-slate-500">USD ${purchase.totalOriginal.toLocaleString('es-AR')} a $${purchase.dollarRate}</span>` : '';
            return `<tr class="border-b border-slate-100"><td class="p-2.5">${isoToLabel(purchase.date)}</td><td class="p-2.5"><span class="font-semibold">Compra ${purchase.type === 'phones' ? 'de celulares' : 'de productos'}</span>${purchase.receipt ? `<span class="block text-[10px] text-slate-500">${escHtml(purchase.receipt)}</span>` : ''}<span class="block text-[10px] text-slate-500">${detail}</span></td><td class="p-2.5 text-right font-mono-num">${money(purchase.totalArs)}${usd}<span class="block text-[10px] ${purchaseBalance(purchase) > 0 ? 'text-amber-700' : 'text-emerald-700'}">${purchaseBalance(purchase) > 0 ? `Pendiente ${money(purchaseBalance(purchase))}` : 'Pagada'}</span></td><td class="p-2.5"></td></tr>`;
        }
        const payment = movement.payment;
        return `<tr class="border-b border-slate-100 bg-emerald-50/40"><td class="p-2.5">${payment.dateLabel}</td><td class="p-2.5"><span class="font-semibold text-emerald-700">Pago · ${escHtml(payment.method)}</span>${payment.reference ? `<span class="block text-[10px] text-slate-500">${escHtml(payment.reference)}</span>` : ''}</td><td class="p-2.5 text-right font-mono-num text-emerald-700">-${money(payment.amount)}</td><td class="p-2.5 text-center"><button onclick="deleteSupplierPayment('${payment.id}')" class="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600" title="Eliminar pago"><i class="fa-solid fa-trash"></i></button></td></tr>`;
    }).join('') || '<tr><td colspan="4" class="p-4 text-center text-slate-400">Sin movimientos.</td></tr>';

    const totals = supplierTotals(id);
    panel.classList.remove('hidden');
    panel.innerHTML = `
        <div class="flex items-center justify-between mb-3">
            <h3 class="font-extrabold text-slate-900">Historial · ${escHtml(supplier.name)} <span class="text-xs font-semibold ${totals.debt > 0 ? 'text-amber-700' : 'text-slate-500'}">Deuda ${money(totals.debt)}</span></h3>
            <button onclick="showSupplierDetail(null)" class="text-slate-400 hover:text-slate-700"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="overflow-x-auto"><table class="min-w-[36rem] w-full text-left text-xs"><thead><tr class="bg-slate-50 border-b border-slate-200"><th class="p-2.5">Fecha</th><th class="p-2.5">Movimiento</th><th class="p-2.5 text-right">Importe</th><th class="p-2.5"></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function deleteSupplierPayment(paymentId) {
    if (!requireAdmin()) return;
    if (!window.confirm('¿Eliminar este pago? La deuda del proveedor volverá a aumentar.')) return;
    SUPPLIER_PAYMENTS = SUPPLIER_PAYMENTS.filter(payment => payment.id !== paymentId);
    await saveLocalState();
    renderSuppliers();
    renderCashRegister();
    showToast('Pago eliminado.');
}

/* ---------- Compras ---------- */
function openPurchaseModal(supplierId) {
    if (!requireAdmin()) return;
    const select = document.getElementById('purchaseSupplier');
    select.innerHTML = SUPPLIERS.map(supplier => `<option value="${supplier.id}">${escHtml(supplier.name)}</option>`).join('');
    if (supplierId) select.value = supplierId;
    document.getElementById('purchaseDate').value = todayIso();
    ['purchaseReceipt', 'purchaseNotes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('purchaseType').value = 'products';
    document.getElementById('purchaseCurrency').value = 'ARS';
    document.getElementById('purchasePaidNow').value = 0;
    document.getElementById('purchasePayMethod').value = 'Transferencia';
    renderPurchaseLines();
    document.getElementById('purchaseModal').classList.remove('hidden');
}

function closePurchaseModal() {
    document.getElementById('purchaseModal').classList.add('hidden');
}

function renderPurchaseLines() {
    document.getElementById('purchaseLines').innerHTML = '';
    addPurchaseLine();
}

function addPurchaseLine() {
    const type = document.getElementById('purchaseType').value;
    const field = 'bg-slate-50 border border-slate-200 rounded-xl p-2 text-xs min-w-0';
    const remove = '<button type="button" onclick="this.closest(\'.purchase-line\').remove(); updatePurchaseTotal()" class="text-red-500 hover:text-red-700 px-2" title="Quitar línea"><i class="fa-solid fa-trash"></i></button>';
    let html;
    if (type === 'phones') {
        html = `<div class="purchase-line grid grid-cols-2 md:grid-cols-6 gap-2 items-center border border-slate-100 rounded-xl p-2">
            <input data-f="brand" required placeholder="Marca *" class="${field}">
            <input data-f="model" required placeholder="Modelo *" class="${field}">
            <select data-f="condition" class="${field}">${SUPPLIER_PHONE_CONDITIONS.map(c => `<option>${c}</option>`).join('')}</select>
            <input data-f="storage" placeholder="Almacenamiento" class="${field}">
            <input data-f="color" placeholder="Color" class="${field}">
            <input data-f="imei" required placeholder="IMEI *" class="${field}">
            <input data-f="battery" type="number" min="1" max="100" placeholder="Batería %" class="${field}">
            <input data-f="cost" type="number" min="0" step="any" required placeholder="Costo *" oninput="updatePurchaseTotal()" class="${field}">
            <input data-f="salePrice" type="number" min="0" step="any" required placeholder="Precio venta ARS *" class="${field} col-span-2">
            <span></span><span></span>${remove}</div>`;
    } else {
        const options = PRODUCTS.map(product => `<option value="${product.id}">${escHtml(product.title)} (stock ${product.stock})</option>`).join('');
        html = `<div class="purchase-line grid grid-cols-2 md:grid-cols-6 gap-2 items-center border border-slate-100 rounded-xl p-2">
            <select data-f="productId" class="${field} md:col-span-2"><option value="">Producto nuevo / sin vincular a stock</option>${options}</select>
            <input data-f="description" placeholder="Descripción (si no está vinculado)" class="${field} md:col-span-2">
            <input data-f="qty" type="number" min="1" value="1" required oninput="updatePurchaseTotal()" class="${field}" title="Cantidad">
            <div class="flex gap-1"><input data-f="cost" type="number" min="0" step="any" required placeholder="Costo unit." oninput="updatePurchaseTotal()" class="${field} flex-1">${remove}</div></div>`;
    }
    document.getElementById('purchaseLines').insertAdjacentHTML('beforeend', html);
    updatePurchaseTotal();
}

function readPurchaseLines() {
    return [...document.querySelectorAll('#purchaseLines .purchase-line')].map(line => {
        const values = {};
        line.querySelectorAll('[data-f]').forEach(input => values[input.dataset.f] = input.value.trim());
        return values;
    });
}

function purchaseRateFactor() {
    return document.getElementById('purchaseCurrency').value === 'USD' ? dailyDollarRate : 1;
}

function updatePurchaseTotal() {
    const type = document.getElementById('purchaseType').value;
    const total = readPurchaseLines().reduce((sum, line) => sum + (parseFloat(line.cost) || 0) * (type === 'phones' ? 1 : (parseInt(line.qty) || 0)), 0);
    const currency = document.getElementById('purchaseCurrency').value;
    document.getElementById('purchaseTotalLabel').textContent = currency === 'USD'
        ? `USD ${total.toLocaleString('es-AR')} ≈ ${money(total * dailyDollarRate)}`
        : money(total);
}

async function savePurchase(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const supplierId = document.getElementById('purchaseSupplier').value;
    if (!supplierId) {
        showToast('Registra primero un proveedor.');
        return;
    }
    const type = document.getElementById('purchaseType').value;
    const currency = document.getElementById('purchaseCurrency').value;
    if (currency === 'USD' && dailyDollarRate <= 0) {
        showToast('Carga primero la cotización del dólar para comprar en USD.');
        return;
    }
    const rate = purchaseRateFactor();
    const lines = readPurchaseLines();
    if (!lines.length) {
        showToast('Agrega al menos una línea a la compra.');
        return;
    }

    const items = [];
    const knownImeis = new Set(PHONES.map(phone => String(phone.imei).trim()));
    for (const line of lines) {
        const cost = parseFloat(line.cost);
        if (!Number.isFinite(cost) || cost < 0) {
            showToast('Revisa los costos ingresados.');
            return;
        }
        if (type === 'phones') {
            const salePrice = parseFloat(line.salePrice);
            if (!line.imei || knownImeis.has(line.imei) || !Number.isFinite(salePrice)) {
                showToast(line.imei && knownImeis.has(line.imei) ? `El IMEI ${line.imei} ya está registrado o repetido.` : 'Completa IMEI y precio de venta de cada celular.');
                return;
            }
            knownImeis.add(line.imei);
            items.push({ brand: line.brand, model: line.model, condition: line.condition, storage: line.storage, color: line.color, imei: line.imei, battery: parseInt(line.battery) || 100, cost, salePrice, phoneId: `PH-${Date.now().toString().slice(-6)}-${items.length}` });
        } else {
            const product = PRODUCTS.find(item => item.id === line.productId);
            const qty = parseInt(line.qty);
            const description = product ? product.title : line.description;
            if (!description || !qty || qty < 1) {
                showToast('Cada línea necesita producto o descripción y una cantidad válida.');
                return;
            }
            items.push({ productId: product ? product.id : null, description, qty, unitCost: cost });
        }
    }

    const totalOriginal = items.reduce((sum, item) => sum + (type === 'phones' ? item.cost : item.unitCost * item.qty), 0);
    const date = document.getElementById('purchaseDate').value;
    const purchase = {
        id: `COM-${Date.now()}`,
        supplierId,
        date,
        receipt: document.getElementById('purchaseReceipt').value.trim(),
        notes: document.getElementById('purchaseNotes').value.trim(),
        type,
        currency,
        dollarRate: currency === 'USD' ? rate : null,
        items,
        totalOriginal,
        totalArs: Math.round(totalOriginal * rate)
    };

    const paidNow = parseFloat(document.getElementById('purchasePaidNow').value) || 0;
    if (paidNow < 0 || paidNow > purchase.totalArs) {
        showToast('El pago inicial no puede superar el total de la compra.');
        return;
    }

    // Ingreso a stock
    items.forEach(item => {
        if (type === 'phones') {
            PHONES.push({ id: item.phoneId, brand: item.brand, model: item.model, condition: item.condition, battery: item.battery, storage: item.storage, color: item.color, imei: item.imei, price: item.salePrice, priceUsd: null, currency: 'ARS', status: 'En Stock', issues: [], cost: Math.round(item.cost * rate), supplierId });
        } else if (item.productId) {
            const product = PRODUCTS.find(entry => entry.id === item.productId);
            product.stock += item.qty;
            product.cost = Math.round(item.unitCost * rate);
            if (product.status === 'Anulado') product.status = 'Activo';
        }
    });
    PURCHASES.push(purchase);
    if (paidNow > 0) {
        SUPPLIER_PAYMENTS.push(buildSupplierPayment(supplierId, purchase.id, paidNow, document.getElementById('purchasePayMethod').value, date, 'Pago inicial'));
    }

    try {
        await saveLocalState({ throwOnRemoteError: true });
    } catch (error) {
        showToast(getProductSaveErrorMessage(error));
        return;
    }
    closePurchaseModal();
    renderSuppliers();
    renderDashboard();
    renderAccTable();
    renderPhonesTable();
    renderCashRegister();
    showToast('Compra registrada y stock actualizado.');
}

/* ---------- Pagos ---------- */
function buildSupplierPayment(supplierId, purchaseId, amount, method, date, reference) {
    return {
        id: `PAG-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        supplierId,
        purchaseId: purchaseId || '',
        date,
        dateLabel: isoToLabel(date),
        method,
        amount,
        reference: reference || ''
    };
}

function openSupplierPaymentModal(supplierId) {
    if (!requireAdmin()) return;
    const supplier = SUPPLIERS.find(item => item.id === supplierId);
    if (!supplier) return;
    document.getElementById('paymentSupplierId').value = supplierId;
    document.getElementById('supplierPaymentTitle').textContent = `Pago a ${supplier.name}`;
    document.getElementById('paymentSupplierDebt').textContent = `Deuda actual: ${money(supplierTotals(supplierId).debt)}${supplier.bank ? ` · Transferir a: ${supplier.bank}` : ''}`;
    const pending = PURCHASES.filter(purchase => purchase.supplierId === supplierId && purchaseBalance(purchase) > 0);
    document.getElementById('paymentPurchase').innerHTML = '<option value="">Cuenta corriente general</option>' + pending.map(purchase => `<option value="${purchase.id}">${isoToLabel(purchase.date)} · ${escHtml(purchase.receipt || purchase.id)} · pendiente ${money(purchaseBalance(purchase))}</option>`).join('');
    document.getElementById('paymentAmount').value = '';
    document.getElementById('paymentMethod').value = 'Transferencia';
    document.getElementById('paymentDate').value = todayIso();
    document.getElementById('paymentReference').value = '';
    document.getElementById('supplierPaymentModal').classList.remove('hidden');
}

function closeSupplierPaymentModal() {
    document.getElementById('supplierPaymentModal').classList.add('hidden');
}

async function saveSupplierPayment(event) {
    event.preventDefault();
    if (!requireAdmin()) return;
    const supplierId = document.getElementById('paymentSupplierId').value;
    const amount = parseFloat(document.getElementById('paymentAmount').value);
    const purchaseId = document.getElementById('paymentPurchase').value;
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast('Ingresa un importe válido.');
        return;
    }
    const limit = purchaseId ? purchaseBalance(PURCHASES.find(purchase => purchase.id === purchaseId)) : supplierTotals(supplierId).debt;
    if (amount > limit && !window.confirm(`El pago supera la deuda (${money(limit)}). ¿Registrarlo igualmente como saldo a favor?`)) return;
    SUPPLIER_PAYMENTS.push(buildSupplierPayment(supplierId, purchaseId, amount, document.getElementById('paymentMethod').value, document.getElementById('paymentDate').value, document.getElementById('paymentReference').value.trim()));
    await saveLocalState();
    closeSupplierPaymentModal();
    renderSuppliers();
    renderCashRegister();
    showToast('Pago registrado.');
}
