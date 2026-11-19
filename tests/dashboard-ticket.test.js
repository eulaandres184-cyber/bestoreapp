const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const tradeInRates = require('../public/js/iphone-trade-in-rates.json');

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
    assert.ok(html.indexOf('id="dashSalesToday"') < html.indexOf('id="dashPhoneAvailableNames"'));
    assert.ok(html.indexOf('id="dashSalesTotal"') > html.indexOf('id="dashPhoneAvailableNames"'));
    assert.match(html, /id="dashboardQuickProductButton"[^>]*onclick="openProductModal\(\)"/);
    assert.match(html, /id="dashboardNewPhoneButton"[^>]*>[\s\S]*?Ingresar nuevo celular/);
    assert.match(html, /onclick="switchTab\('canje-calculator'\)" class="custom-card[^"]*"[^>]*>[\s\S]*?Cotizar Canje/);
    assert.doesNotMatch(html, /Acciones Rápidas del Sistema/);
    assert.doesNotMatch(html, /id="dashPhoneValue"|id="dashPhonesCount"|id="dashPhonesSub"|id="dashLowStockCount"/);
    assert.doesNotMatch(html, /id="dashTotalValue"/);
    assert.equal((html.match(/id="dashSalesToday"/g) || []).length, 1);
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    assert.doesNotMatch(header, /Nueva Venta|Cargar Producto/);
});

test('el dashboard presenta acceso destacado a venta y tarjetas de cajas seguras', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /class="dashboard-new-sale custom-card[^"]*"[^>]*>/);
    assert.match(html, /id="openAllRegistersButton"[\s\S]*?id="closeAllRegistersButton"[\s\S]*?id="allRegistersActionStatus"/);
    assert.match(html, /custom-card bg-emerald-50\/50[^>]*>[\s\S]*?id="cashRegisterStatus"/);
    assert.match(html, /custom-card bg-blue-50\/50[^>]*>[\s\S]*?id="transferRegisterStatus"/);
    assert.match(html, /custom-card bg-purple-50\/50[^>]*>[\s\S]*?id="cardRegisterStatus"/);
    assert.match(html, /id="cashRegisterSummary"/);
    assert.doesNotMatch(html, /<details class="mt-2">[\s\S]*?id="openAllRegistersButton"/);
    assert.match(html, /order-2 lg:col-span-5 custom-card p-4/);
    assert.match(html, /order-3 lg:col-span-5 custom-card p-5[\s\S]*?Productos con Stock Crítico/);
    assert.match(html, /order-1 lg:col-span-7 lg:row-span-2 custom-card/);
    assert.match(html, /id="view-dashboard"[\s\S]*?Cotizar Canje[\s\S]*?Consultar tabla actualizada de iPhone/);
});

test('el resumen de celulares muestra los dos equipos disponibles de mayor valor', () => {
    const { context, elements } = createApp();
    context.renderCashRegister = () => {};
    context.renderDashboardRecentSales = () => {};
    vm.runInContext(`PHONES = [
        { brand: 'Apple', model: 'iPhone 14 Pro', storage: '128 GB', status: 'En Stock', price: 600 },
        { brand: 'Samsung', model: 'A27', storage: '256 GB', status: 'En Stock', price: 400 },
        { brand: 'Apple', model: 'iPhone 12', storage: '64 GB', status: 'En Stock', price: 200 },
        { brand: 'Apple', model: 'Vendido', storage: '128 GB', status: 'Vendido', price: 900 }
    ]; PRODUCTS = []`, context);

    context.renderDashboard();

    assert.equal(elements.get('dashPhoneAvailableNames').textContent, 'iPhone 14 Pro 128 GB\nSamsung A27 256 GB');
});

test('la cotización de canje coincide con la lista actualizada', () => {
    const rates = new Map(tradeInRates.rates.map(rate => [
        `${rate.model}|${rate.storageGb}`, [rate.over90Usd, rate.under90Usd]
    ]));
    const expected = [
        ['iPhone 11',64,100,80], ['iPhone 11',128,130,100],
        ['iPhone 11 Pro',64,150,120], ['iPhone 11 Pro',256,170,140],
        ['iPhone 11 Pro Max',64,180,150], ['iPhone 11 Pro Max',256,200,170],
        ['iPhone 12',64,150,120], ['iPhone 12',128,180,150],
        ['iPhone 12 Pro',128,220,190], ['iPhone 12 Pro',256,240,210],
        ['iPhone 12 Pro Max',128,240,210], ['iPhone 12 Pro Max',256,260,230],
        ['iPhone 13',128,250,220], ['iPhone 13',256,280,240],
        ['iPhone 13 Pro',128,320,290], ['iPhone 13 Pro',256,360,320],
        ['iPhone 13 Pro Max',128,360,320], ['iPhone 13 Pro Max',256,380,340],
        ['iPhone 14',128,300,270], ['iPhone 14',256,320,290],
        ['iPhone 14 Pro',128,370,330], ['iPhone 14 Pro',256,400,370],
        ['iPhone 14 Pro Max',128,450,420], ['iPhone 14 Pro Max',256,480,450],
        ['iPhone 15',128,420,390], ['iPhone 15',256,440,410],
        ['iPhone 15 Pro',128,500,470], ['iPhone 15 Pro',256,530,500],
        ['iPhone 15 Pro Max',256,580,530],
        ['iPhone 16',128,550,520], ['iPhone 16',256,580,550],
        ['iPhone 16 Pro',128,650,600], ['iPhone 16 Pro',256,680,620],
        ['iPhone 16 Pro Max',256,750,700], ['iPhone 17',256,750,700],
        ['iPhone 17 Pro',256,900,850], ['iPhone 17 Pro',512,950,900],
        ['iPhone 17 Pro Max',256,1050,1000], ['iPhone 17 Pro Max',512,1150,1100]
    ];
    assert.equal(tradeInRates.batteryThresholdPercent, 90);
    assert.equal(rates.size, expected.length);
    for (const [model, storage, over90, under90] of expected) {
        assert.deepEqual(rates.get(`${model}|${storage}`), [over90, under90], `${model} ${storage} GB`);
    }
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

test('el comprobante anterior consulta el creador real y no el usuario de la sesión', async () => {
    const { context, elements } = createApp();
    const id = '01234567-1234-4234-8234-012345678901';
    let resolveSeller;
    context.callSecureFunction = (name, payload) => {
        assert.equal(name, 'getSaleSeller');
        assert.equal(payload.ticketId, id);
        return new Promise(resolve => { resolveSeller = resolve; });
    };
    vm.runInContext(`currentUserProfile = { nick: 'Otro usuario' }; SALES = [{
        id: '${id}', backendTicketId: '${id}', ticketNumber: 23, total: 1200, subtotal: 1200,
        customerName: '', customerPhone: '-', sellerName: 'No registrado',
        items: [{quantity: 1, title: 'Cable', price: 1200}],
        paymentMethod: 'Efectivo', date: '17/11/26', status: 'Confirmada'
    }]`, context);
    elements.set('receiptModal', { classList: { add() {}, remove() {}, contains() { return false; } } });
    context.reprintReceipt(id);
    assert.match(elements.get('receiptCustomerInfo').innerHTML, /Vendedor:<\/strong> No registrado/);
    resolveSeller({ sellerName: 'Ana <V>' });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(elements.get('receiptCustomerInfo').innerHTML, /Vendedor:<\/strong> Ana &lt;V&gt;/);
    assert.equal(vm.runInContext('SALES[0].sellerName', context), 'No registrado');
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
