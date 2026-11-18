const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp() {
    const elements = new Map();
    const db = { collection: () => ({ doc: () => ({}) }) };
    const context = {
        tailwind: {}, firebase: { initializeApp() {}, firestore: () => db },
        window: {}, console, localStorage: { setItem() {} },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, {
                    innerHTML: '', textContent: '', classList: { toggle() {}, remove() {}, add() {} }
                });
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    return { context, elements };
}

test('las tarjetas muestran hoy primero y acumulado en lugar del valor de accesorios', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.ok(html.indexOf('id="dashSalesToday"') < html.indexOf('id="dashPhonesCount"'));
    assert.ok(html.indexOf('id="dashSalesTotal"') > html.indexOf('id="dashPhoneValue"'));
    assert.doesNotMatch(html, /id="dashTotalValue"/);
    assert.equal((html.match(/id="dashSalesToday"/g) || []).length, 1);
});

test('el dashboard presenta acceso destacado a venta y cajas plegadas', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /class="dashboard-new-sale custom-card[^"]*"[^>]*>/);
    assert.match(html, /<details class="mt-2">[\s\S]*?id="openAllRegistersButton"[\s\S]*?id="cashRegisterSummary"[\s\S]*?<\/details>/);
    assert.match(html, /order-3 lg:col-span-5 custom-card/);
    assert.match(html, /order-2 lg:col-span-5 custom-card/);
    assert.match(html, /order-1 lg:col-span-7 lg:row-span-2 custom-card/);
});

test('el dashboard presenta el resumen seguro del día y acumulado neto', async () => {
    const { context, elements } = createApp();
    context.callSecureFunction = async name => {
        assert.equal(name, 'getSalesSummary');
        return { todayCount: 2, todayCents: 150050, totalCount: 15, netCents: 1234500 };
    };
    await context.refreshSalesSummary();
    assert.equal(elements.get('dashSalesToday').textContent, '2 oper.');
    assert.equal(elements.get('dashRevenueToday').textContent, '$1.500,5 facturado');
    assert.equal(elements.get('dashSalesTotal').textContent, '15 oper.');
    assert.match(elements.get('dashRevenueTotal').textContent, /^\$12\.345 neto/);
});

test('si falla la consulta no muestra cero ni un total anterior como si fuera válido', async () => {
    const { context, elements } = createApp();
    context.console = { error() {} };
    context.callSecureFunction = async () => { throw new Error('Sin conexión'); };
    await context.refreshSalesSummary();
    assert.equal(elements.get('dashSalesToday').textContent, '—');
    assert.equal(elements.get('dashSalesTotal').textContent, '—');
    assert.match(elements.get('dashRevenueTotal').textContent, /No se pudieron consultar/);
});

test('una respuesta anterior no reemplaza un resumen más reciente', async () => {
    const { context, elements } = createApp();
    let resolveFirst;
    let calls = 0;
    context.callSecureFunction = () => ++calls === 1
        ? new Promise(resolve => { resolveFirst = resolve; })
        : Promise.resolve({ todayCount: 2, todayCents: 200, totalCount: 2, netCents: 200 });
    const first = context.refreshSalesSummary();
    await context.refreshSalesSummary();
    resolveFirst({ todayCount: 1, todayCents: 100, totalCount: 1, netCents: 100 });
    await first;
    assert.equal(elements.get('dashSalesTotal').textContent, '2 oper.');
});

test('el dashboard muestra referencias numéricas de ticket sin alterar el ID interno', () => {
    const { context, elements } = createApp();
    vm.runInContext(`SALES = [
        { id: 'secure-sale-1', ticketNumber: 1, total: 1200, customerName: 'Cliente 1', items: [], date: '17/11/26', status: 'Confirmada' },
        { id: 'secure-sale-2', ticketNumber: 2, total: 2400, customerName: 'Cliente 2', items: [], date: '17/11/26', status: 'Confirmada' }
    ]`, context);

    context.renderDashboardRecentSales();

    const html = elements.get('dashRecentSalesList').innerHTML;
    const ticketNumbers = [...html.matchAll(/<strong class="min-w-0 break-all text-xs text-slate-900">Ticket-BS-(\d+)<\/strong>/g)]
        .map(match => match[1]);
    assert.deepEqual(ticketNumbers, ['0001', '0002']);
    assert.match(html, /onclick="reprintReceipt\('secure-sale-1'\)"/);
    assert.match(html, /onclick="reprintReceipt\('secure-sale-2'\)"/);
});

test('el comprobante y el PDF conservan el número del dashboard y el cliente por defecto', () => {
    const { context, elements } = createApp();
    const lines = [];
    let filename;
    context.window.jspdf = { jsPDF: class {
        setFont() {}
        setFontSize() {}
        splitTextToSize(text) { return [text]; }
        text(text) { lines.push(text); }
        addPage() {}
        save(name) { filename = name; }
    } };
    vm.runInContext(`SALES = [{
        id: '01234567-1234-4234-8234-012345678901', ticketNumber: 23, total: 1200, subtotal: 1200,
        customerName: '', customerPhone: '-', sellerName: 'Ana <V>', items: [{quantity: 1, title: 'Cable', price: 1200}],
        paymentMethod: 'Efectivo', date: '17/11/26', status: 'Confirmada'
    }]`, context);
    context.renderDashboardRecentSales();
    context.reprintReceipt('01234567-1234-4234-8234-012345678901');
    context.downloadReceiptPdf();
    assert.match(elements.get('dashRecentSalesList').innerHTML, /Ticket-BS-0023/);
    assert.match(elements.get('receiptDate').textContent, /Ticket-BS-0023/);
    assert.match(elements.get('receiptCustomerInfo').innerHTML, /Cliente:<\/strong> Consumidor Final/);
    assert.match(elements.get('receiptCustomerInfo').innerHTML, /Vendedor:<\/strong> Ana &lt;V&gt;/);
    assert.ok(lines.includes('Ticket-BS-0023'));
    assert.ok(lines.includes('Cliente: Consumidor Final'));
    assert.ok(lines.includes('Vendedor: Ana <V>'));
    assert.ok(lines.includes('1x Cable - $1.200'));
    assert.ok(lines.includes('TOTAL: $1.200'));
    assert.equal(filename, 'Ticket-BS-0023.pdf');
});

test('el formato conserva cuatro dígitos y crece a partir de 10000', () => {
    const { context } = createApp();
    const filenames = [];
    context.window.jspdf = { jsPDF: class {
        setFont() {}
        setFontSize() {}
        splitTextToSize(text) { return [text]; }
        text() {}
        addPage() {}
        save(name) { filenames.push(name); }
    } };
    vm.runInContext(`lastCreatedSale = {
        status:'Confirmada', date:'17/11/26', paymentMethod:'Efectivo',
        customerName:'', items:[], subtotal:0, total:0
    }`, context);
    for (const [number, expected] of [[1, '0001'], [9, '0009'], [10, '0010'], [9999, '9999'], [10000, '10000']]) {
        assert.equal(context.getTicketNumber({ ticketNumber: number }), expected);
        vm.runInContext(`lastCreatedSale.ticketNumber = ${number}`, context);
        context.downloadReceiptPdf();
        assert.equal(filenames.pop(), `Ticket-BS-${expected}.pdf`);
    }
});

test('las ventas anteriores reciben sus números del backend en orden de antigüedad', async () => {
    const { context } = createApp();
    const calls = [];
    context.callSecureFunction = async (name, payload) => {
        calls.push({ name, ids: Array.from(payload.saleIds) });
        return { numbers: payload.saleIds.map((id, index) => ({ saleId: id, ticketNumber: index + 1 })) };
    };
    vm.runInContext(`SALES = [
        {id:'pendiente', status:'Pendiente de emisión'},
        {id:'nueva', status:'Confirmada'},
        {id:'antigua', status:'Confirmada'}
    ]`, context);
    await context.assignMissingTicketNumbers();
    assert.deepEqual(calls, [{ name: 'assignLegacyTicketNumbers', ids: ['antigua', 'nueva'] }]);
    assert.equal(vm.runInContext('getTicketLabel(SALES[1])', context), 'Ticket-BS-0002');
    assert.equal(vm.runInContext('getTicketLabel(SALES[2])', context), 'Ticket-BS-0001');
    assert.equal(vm.runInContext('getTicketLabel(SALES[0])', context), 'Venta pendiente');
});

test('si falta la biblioteca PDF muestra un error en lugar de simular la descarga', () => {
    const { context } = createApp();
    const messages = [];
    context.console = { error() {} };
    context.showToast = message => messages.push(message);
    vm.runInContext("lastCreatedSale = { id: 'TK-12345', ticketNumber: 1, status: 'Confirmada' }", context);
    context.downloadReceiptPdf();
    assert.match(messages[0], /No se pudo guardar el PDF/);
});

test('no guarda un PDF con un número histórico sin asignar', () => {
    const { context } = createApp();
    const messages = [];
    context.showToast = message => messages.push(message);
    vm.runInContext("lastCreatedSale = { id: 'TK-12345', status: 'Confirmada' }", context);
    context.downloadReceiptPdf();
    assert.match(messages[0], /aún no tiene número/);
});
