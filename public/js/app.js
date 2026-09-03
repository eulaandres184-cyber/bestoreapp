tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                bonewhite: {
                    50: '#fffdfa',
                    100: '#f5ebe1',
                    200: '#edddcc',
                    300: '#dfc9b5',
                    border: '#edddcc'
                },
                slate: {
                    50: '#fffdfa',
                    100: '#f5ebe1',
                    200: '#edddcc',
                    300: '#dfc9b5',
                    400: '#9c907f',
                    500: '#647262',
                    600: '#386046',
                    700: '#1e4a32',
                    800: '#0d4b2f',
                    900: '#003223'
                },
                brand: {
                    50: '#fff0e5',
                    100: '#ffe0c7',
                    500: '#ff7c29',
                    600: '#ff6400',
                    700: '#d85300',
                    accent: '#ff6400',
                    emerald: '#8cc850',
                    amber: '#ff6400'
                },
                emerald: {
                    50: '#eff8e7',
                    100: '#ddf0cc',
                    200: '#c5e7a9',
                    300: '#a9d77c',
                    500: '#8cc850',
                    600: '#75ad3d',
                    700: '#5b8e2e',
                    800: '#3f6d23',
                    900: '#003223'
                },
                purple: {
                    50: '#eff8e7',
                    100: '#ddf0cc',
                    500: '#8cc850',
                    600: '#75ad3d',
                    700: '#5b8e2e',
                    800: '#3f6d23'
                },
                amber: {
                    50: '#fff0e5',
                    100: '#ffe0c7',
                    200: '#ffc18f',
                    300: '#ffa45d',
                    500: '#ff7c29',
                    600: '#ff6400',
                    700: '#d85300',
                    800: '#a94000',
                    900: '#003223'
                },
                indigo: {
                    50: '#eff8e7',
                    500: '#8cc850',
                    600: '#75ad3d',
                    700: '#5b8e2e',
                    800: '#3f6d23'
                },
                slatecard: '#ffffff'
            },
            fontFamily: {
                sans: ['Plus Jakarta Sans', 'Inter', 'sans-serif']
            }
        }
    }
};

const firebaseConfig = {
    apiKey: 'AIzaSyCAgEZ7fMqmUEJqGFgr28ps-HzNXElFvag',
    authDomain: 'be-store-app.firebaseapp.com',
    projectId: 'be-store-app',
    storageBucket: 'be-store-app.firebasestorage.app',
    messagingSenderId: '686258928047',
    appId: '1:686258928047:web:a4e40edee6e68f7716975a',
    measurementId: 'G-PNCHZX98YC'
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const appStateRef = db.collection('app_state').doc('main');
let currentUserProfile = null;
let CATEGORIES = [
    { id: 'fundas', name: 'Fundas & Covers' },
    { id: 'proteccion', name: 'Vidrios Templados' },
    { id: 'cargadores', name: 'Cargadores & Cables' },
    { id: 'audio', name: 'Audio & Auriculares' }
];
const CARD_PLANS = {
    'mp-single': { label: 'Mercado Pago - 1 pago', rate: 0.0649 },
    'mp-3': { label: 'Mercado Pago - 3 cuotas', rate: 0.1249 },
    'pampa-4': { label: 'Banco Pampa - 4 cuotas', rate: 0 },
    'pampa-20': { label: 'Banco Pampa - 20 cuotas', rate: 0.20 }
};
const MERCADO_PAGO_VAT_RATE = 0.21;
const DATA_VERSION = 2;
let CASE_SUBCATEGORIES = [
    { id: 'transparente', name: 'Transparente' },
    { id: 'rigida', name: 'Rígida' },
    { id: 'silicona', name: 'Silicona' },
    { id: 'dibujos', name: 'Diseños / Dibujos' }
];
const PROTECTION_SUBCATEGORIES = [
    { id: '9d', name: '9D' },
    { id: 'antiespia', name: 'Antiespía' },
    { id: 'matte', name: 'Matte' },
    { id: 'hidrogel-matte', name: 'Hidrogel Matte' },
    { id: 'hidrogel-clear-aaa', name: 'Hidrogel Clear AAA' }
];
let PHONE_ISSUES = [
    { id: 'pantalla-cambiada', name: 'Pantalla cambiada' },
    { id: 'sin-faceid', name: 'Sin Face ID / Touch ID' },
    { id: 'tapa-trasera-rota', name: 'Tapa trasera rota' },
    { id: 'camara-con-detalles', name: 'Cámara con detalles' },
    { id: 'marcas-de-uso', name: 'Marcas de uso visibles' }
];
let IPHONE_TRADE_IN_RATES = [];

/* Empty initial state: inventory is entered manually by an administrator. */
        let PRODUCTS = [];
        let PHONES = [];
        let SALES = [];
        let CLIENTS = [];
        let cashRegister = { date: '', openingCash: 0, open: false };
        let dailyDollarRate = 0;

        let posState = {
            ticket: [],
            paymentMethod: 'transfer', // 'transfer' or 'card'
            selectedCategory: 'ALL',
            phoneConditionFilter: 'ALL'
        };

        let pendingSaleId = null;
        let posOperationInProgress = false;
        let activeTradeInValuation = 0;
        let activeTradeInValuationUsd = 0;
        let lastCreatedSale = null;
        let productFeedbackTimer = null;

        /* INITIALIZATION ON LOAD */
        window.onload = async function() {
            await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
            firebase.auth().onAuthStateChanged(async user => {
                if (user && !currentUserProfile) await finishLogin(user);
            });
            await initializeAuthentication();
        };

        function nickEmail(nick) {
            return `${nick.trim().toLowerCase()}@bestore.local`;
        }

        async function initializeAuthentication() {
            try {
                const users = await db.collection('users').limit(1).get();
                if (users.empty) {
                    document.getElementById('loginForm').classList.add('hidden');
                    document.getElementById('setupAdminForm').classList.remove('hidden');
                }
            } catch (error) {
                showAuthMessage('No se pudo conectar con Firebase.');
            }
        }

        async function setupFirstAdmin(event) {
            event.preventDefault();
            const nick = document.getElementById('setupNick').value.trim();
            const password = document.getElementById('setupPassword').value;
            try {
                const credential = await firebase.auth().createUserWithEmailAndPassword(nickEmail(nick), password);
                await db.collection('users').doc(credential.user.uid).set({ nick, role: 'admin', active: true, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
                await finishLogin(credential.user);
            } catch (error) {
                showAuthMessage(error.message);
            }
        }

        async function loginUser(event) {
            event.preventDefault();
            const nick = document.getElementById('loginNick').value.trim();
            try {
                const credential = await firebase.auth().signInWithEmailAndPassword(nickEmail(nick), document.getElementById('loginPassword').value);
                await finishLogin(credential.user);
            } catch (error) {
                showAuthMessage('Nick o clave incorrectos.');
            }
        }

        async function finishLogin(user) {
            const profile = await db.collection('users').doc(user.uid).get();
            if (!profile.exists) throw new Error('Usuario sin perfil asignado.');
            currentUserProfile = profile.data();
            if (currentUserProfile.active === false) {
                await firebase.auth().signOut();
                currentUserProfile = null;
                showAuthMessage('Este usuario fue desactivado. Consulte a un administrador.');
                return;
            }
            document.getElementById('currentUserName').textContent = `${currentUserProfile.nick} (${currentUserProfile.role === 'admin' ? 'Admin' : 'Vendedor'})`;
            document.getElementById('authScreen').classList.add('hidden');
            await loadLocalState();
            normalizeCommercialData();
            document.getElementById('dailyDollarRate').value = dailyDollarRate || '';
            updatePhonePriceLabel();
            startSystemClock();
            renderDashboard();
            renderAccTable();
            renderPhonesTable();
            renderSalesTable();
            renderPOSCategories();
            renderPOSItemsGrid();
            renderCategorySelects();
            renderCategoriesPage();
            renderClients();
            await loadIphoneTradeInRates();
            updateCanjeModelOptions();
        }

        function showAuthMessage(message) {
            document.getElementById('authMessage').textContent = message;
        }

        function isAdmin() {
            return currentUserProfile?.role === 'admin';
        }

        function requireAdmin() {
            if (!isAdmin()) showToast('Solo un administrador puede realizar esta acción.');
            return isAdmin();
        }

        async function logoutUser() {
            await firebase.auth().signOut();
            currentUserProfile = null;
            document.getElementById('authScreen').classList.remove('hidden');
        }

        function openUserModal() {
            if (!requireAdmin()) return;
            renderUserList();
            document.getElementById('userModal').classList.remove('hidden');
        }

        function closeUserModal() {
            document.getElementById('userModal').classList.add('hidden');
            cancelUserEdit();
        }

        async function renderUserList() {
            if (!requireAdmin()) return;
            const snapshot = await db.collection('users').orderBy('nick').get();
            document.getElementById('userList').innerHTML = snapshot.docs.map(doc => {
                const user = doc.data();
                const isCurrentUser = doc.id === firebase.auth().currentUser?.uid;
                const status = user.active === false ? 'Inactivo' : 'Activo';
                return `<div class="flex items-center justify-between gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs ${user.active === false ? 'opacity-60' : ''}">
                    <div class="min-w-0"><p class="font-bold text-slate-900 truncate">${user.nick} <span class="font-medium text-slate-500">· ${user.role === 'admin' ? 'Admin' : 'Vendedor'}</span></p><p class="text-[10px] ${user.active === false ? 'text-red-600' : 'text-emerald-600'}">${status}${isCurrentUser ? ' · Tu usuario' : ''}</p></div>
                    <div class="flex shrink-0 gap-1"><button onclick="startUserEdit('${doc.id}', '${user.nick}', '${user.role}')" class="p-1.5 text-brand-600 hover:bg-brand-50 rounded-lg" title="Editar usuario"><i class="fa-solid fa-pen"></i></button>${!isCurrentUser && user.active !== false ? `<button onclick="deactivateUser('${doc.id}', '${user.nick}')" class="p-1.5 text-red-600 hover:bg-red-50 rounded-lg" title="Desactivar usuario"><i class="fa-solid fa-user-slash"></i></button>` : user.active === false ? `<button onclick="reactivateUser('${doc.id}', '${user.nick}')" class="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg" title="Reactivar usuario"><i class="fa-solid fa-user-check"></i></button>` : ''}</div>
                </div>`;
            }).join('');
        }

        async function createUser(event) {
            event.preventDefault();
            if (!requireAdmin()) return;
            const nick = document.getElementById('newUserNick').value.trim();
            const password = document.getElementById('newUserPassword').value;
            const role = document.getElementById('newUserRole').value;
            const secondaryApp = firebase.initializeApp(firebaseConfig, `seller-${Date.now()}`);
            try {
                const credential = await secondaryApp.auth().createUserWithEmailAndPassword(nickEmail(nick), password);
                await db.collection('users').doc(credential.user.uid).set({ nick, role, active: true, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
                document.getElementById('newUserNick').value = '';
                document.getElementById('newUserPassword').value = '';
                await secondaryApp.delete();
                await renderUserList();
                showToast('Usuario registrado correctamente.');
            } catch (error) {
                await secondaryApp.delete();
                showToast(error.code === 'auth/email-already-in-use' ? 'Ese nick ya está registrado.' : 'No se pudo registrar el vendedor.');
            }
        }

        function startUserEdit(userId, nick, role) {
            if (!requireAdmin()) return;
            document.getElementById('editingUserId').value = userId;
            document.getElementById('editingUserNick').textContent = nick;
            document.getElementById('editingUserRole').value = role;
            document.getElementById('editUserForm').classList.remove('hidden');
        }

        function cancelUserEdit() {
            document.getElementById('editUserForm').classList.add('hidden');
            document.getElementById('editingUserId').value = '';
        }

        async function updateUser(event) {
            event.preventDefault();
            if (!requireAdmin()) return;
            const userId = document.getElementById('editingUserId').value;
            const role = document.getElementById('editingUserRole').value;
            if (userId === firebase.auth().currentUser?.uid && role !== 'admin') {
                showToast('No podés quitarte el rol de administrador.');
                return;
            }
            await db.collection('users').doc(userId).update({ role, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            cancelUserEdit();
            await renderUserList();
            showToast('Usuario actualizado correctamente.');
        }

        async function deactivateUser(userId, nick) {
            if (!requireAdmin()) return;
            if (userId === firebase.auth().currentUser?.uid) {
                showToast('No podés desactivar tu propio usuario.');
                return;
            }
            if (!confirm(`¿Desactivar el usuario ${nick}? No podrá ingresar al sistema.`)) return;
            await db.collection('users').doc(userId).update({ active: false, deactivatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            await renderUserList();
            showToast('Usuario desactivado.');
        }

        async function reactivateUser(userId, nick) {
            if (!requireAdmin()) return;
            await db.collection('users').doc(userId).update({ active: true, reactivatedAt: firebase.firestore.FieldValue.serverTimestamp() });
            await renderUserList();
            showToast(`${nick} puede volver a ingresar al sistema.`);
        }

        /* CLOCK WIDGET */
        function startSystemClock() {
            function tick() {
                const now = new Date();
                document.getElementById('clockTime').textContent = now.toLocaleTimeString('es-AR');
                document.getElementById('clockDate').textContent = now.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
            }
            tick();
            setInterval(tick, 1000);
        }

        /* NAVIGATION & TAB SWITCHING */
        function switchTab(tabId) {
            const tabs = ['dashboard', 'pos', 'inventory-acc', 'inventory-phones', 'sales-history', 'canje-calculator', 'categories', 'clients'];
            
            tabs.forEach(t => {
                const navBtn = document.getElementById(`nav-${t}`);
                const viewSec = document.getElementById(`view-${t}`);
                if (navBtn) navBtn.classList.remove('active');
                document.querySelectorAll(`[data-tab-nav="${t}"]`).forEach(button => button.classList.remove('active'));
                if (viewSec) viewSec.classList.add('hidden');
            });

            const activeBtn = document.getElementById(`nav-${tabId}`);
            const activeSec = document.getElementById(`view-${tabId}`);
            
            if (activeBtn) activeBtn.classList.add('active');
            document.querySelectorAll(`[data-tab-nav="${tabId}"]`).forEach(button => button.classList.add('active'));
            if (activeSec) activeSec.classList.remove('hidden');

            // Update Header Title
            const titles = {
                'dashboard': '<i class="fa-solid fa-chart-pie text-brand-600"></i> Dashboard General',
                'pos': '<i class="fa-solid fa-cash-register text-emerald-600"></i> Punto de Venta (POS)',
                'inventory-acc': '<i class="fa-solid fa-boxes-stacked text-brand-accent"></i> Inventario Accesorios & Tech',
                'inventory-phones': '<i class="fa-solid fa-mobile-screen-button text-purple-600"></i> Stock de Celulares (Nuevos/Usados)',
                'sales-history': '<i class="fa-solid fa-receipt text-slate-600"></i> Historial de Ventas',
                'canje-calculator': '<i class="fa-solid fa-arrows-rotate text-emerald-600"></i> Cotizador Plan Canje',
            };
            document.getElementById('pageTitle').innerHTML = titles[tabId] || 'BE STORE System';

            if (tabId === 'dashboard') {
                renderDashboard();
            } else if (tabId === 'pos') {
                renderPOSItemsGrid();
            } else if (tabId === 'categories') {
                renderCategoriesPage();
            } else if (tabId === 'clients') {
                renderClients();
            }
        }

        /* DASHBOARD RENDERING */
        function renderDashboard() {
            // Calculations
            let accValue = PRODUCTS.reduce((sum, p) => sum + (p.price * p.stock), 0);
            let phoneValue = PHONES.filter(p => p.status === 'En Stock').reduce((sum, p) => sum + p.price, 0);

            let inStockPhones = PHONES.filter(p => p.status === 'En Stock');
            let newPhones = inStockPhones.filter(p => p.condition === 'Nuevo').length;
            let usedPhones = inStockPhones.filter(p => p.condition.includes('Usado')).length;

            let lowStockAcc = PRODUCTS.filter(p => p.stock > 0 && p.stock <= p.minStock);

            document.getElementById('dashTotalValue').textContent = `$${accValue.toLocaleString('es-AR')}`;
            document.getElementById('dashPhoneValue').textContent = `$${phoneValue.toLocaleString('es-AR')}`;
            document.getElementById('dashPhonesCount').textContent = `${inStockPhones.length} unidades`;
            document.getElementById('dashPhonesSub').textContent = `${newPhones} Nuevos / ${usedPhones} Usados`;
            document.getElementById('dashLowStockCount').textContent = `${lowStockAcc.length} ítems`;

            // Today's Sales
            const todayStr = new Date().toLocaleDateString('es-AR');
            const salesToday = SALES.filter(s => s.date.includes(todayStr));
            const revToday = salesToday.reduce((sum, s) => sum + s.total, 0);

            document.getElementById('dashSalesToday').textContent = `${salesToday.length} oper.`;
            document.getElementById('dashRevenueToday').textContent = `$${revToday.toLocaleString('es-AR')} facturado`;
            renderCashRegister();

            // Badges
            const badgeLow = document.getElementById('badgeLowStock');
            if (lowStockAcc.length > 0) {
                badgeLow.textContent = lowStockAcc.length;
                badgeLow.classList.remove('hidden');
            } else {
                badgeLow.classList.add('hidden');
            }
            document.getElementById('badgePhonesCount').textContent = inStockPhones.length;

            // Render Low Stock List
            const lowStockContainer = document.getElementById('dashLowStockList');
            if (lowStockAcc.length === 0) {
                lowStockContainer.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">No hay productos en nivel crítico de stock.</p>`;
            } else {
                lowStockContainer.innerHTML = lowStockAcc.map(item => `
                    <div class="bg-amber-50/70 p-2.5 rounded-xl border border-amber-200 flex items-center justify-between">
                        <div class="min-w-0 flex-1 pr-2">
                            <h4 class="text-xs font-bold text-slate-800 truncate">${item.title}</h4>
                            <span class="text-[10px] text-amber-800 font-semibold">Quedan ${item.stock} un. (Mín: ${item.minStock})</span>
                        </div>
                        <button onclick="quickAddStock('${item.id}', 5)" class="bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg shrink-0">
                            +5 Stock
                        </button>
                    </div>
                `).join('');
            }

            renderDashboardRecentSales();
        }

        function renderDashboardRecentSales() {
            const container = document.getElementById('dashRecentSalesList');
            const recentSales = SALES.slice(0, 6);
            container.innerHTML = recentSales.map(sale => `
                <button onclick="reprintReceipt('${sale.id}')" class="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-left hover:border-brand-400 hover:bg-white transition">
                    <span class="flex items-center justify-between gap-3"><strong class="text-xs text-slate-900">${sale.id}</strong><strong class="text-xs font-mono-num ${sale.status === 'Anulada' ? 'text-red-600 line-through' : 'text-emerald-600'}">$${sale.total.toLocaleString('es-AR')}</strong></span>
                    <span class="mt-1 block truncate text-[11px] text-slate-600">${sale.customerName} · ${sale.items.map(item => `${item.quantity}x ${item.title}`).join(', ')}</span>
                    <span class="mt-1 block text-[10px] text-slate-400">${sale.date}${sale.status === 'Anulada' ? ' · Anulada' : ''}</span>
                </button>
            `).join('') || '<p class="py-12 text-center text-xs text-slate-400">Aún no hay ventas registradas.</p>';
        }

        function normalizeCommercialData() {
            PRODUCTS.forEach(product => { product.cashPrice = product.price; });
            PHONES.forEach(phone => {
                if (!phone.currency) phone.currency = 'ARS';
                if (phone.currency === 'USD' && phone.priceUsd && dailyDollarRate > 0) phone.price = Math.round(phone.priceUsd * dailyDollarRate);
            });
        }

        function getCardPlanRate() {
            return CARD_PLANS[document.getElementById('cardPlanSelect').value]?.rate || 0;
        }

        function calculateCardCharges(cardAmount) {
            const planId = document.getElementById('cardPlanSelect').value;
            const plan = CARD_PLANS[planId] || { rate: 0 };
            const commission = Math.round(cardAmount * plan.rate);
            const vat = planId.startsWith('mp-') ? Math.round(commission * MERCADO_PAGO_VAT_RATE) : 0;
            return { commission, vat, total: commission + vat };
        }

        async function updateDollarRate() {
            if (!requireAdmin()) return;
            const input = parseFloat(document.getElementById('dailyDollarRate').value);
            if (!Number.isFinite(input) || input <= 0) {
                showToast('Ingresa una cotización del dólar válida.');
                return;
            }
            dailyDollarRate = input;
            normalizeCommercialData();
            await saveLocalState();
            renderDashboard();
            renderPhonesTable();
            renderPOSItemsGrid();
            showToast('Cotización actualizada. Se recalcularon los celulares en USD.');
        }

        /* ACCESSORIES TABLE LOGIC */
        function renderAccTable() {
            const body = document.getElementById('accTableBody');
            const search = document.getElementById('accSearchInput').value.toLowerCase();
            const cat = document.getElementById('accCategoryFilter').value;
            const subcategory = document.getElementById('accSubcategoryFilter').value;
            const sort = document.getElementById('accSort').value;

            const filtered = PRODUCTS.filter(p => {
                const matchesCat = cat === 'ALL' || p.category === cat;
                const matchesSubcategory = subcategory === 'ALL' || p.subcategory === subcategory;
                const matchesSearch = p.title.toLowerCase().includes(search) || p.brand.toLowerCase().includes(search) || p.id.toLowerCase().includes(search) || getAccessorySubcategoryName(p.category, p.subcategory).toLowerCase().includes(search);
                return matchesCat && matchesSubcategory && matchesSearch;
            }).sort((first, second) => {
                if (sort === 'stock-asc') return first.stock - second.stock || first.title.localeCompare(second.title);
                if (sort === 'stock-desc') return second.stock - first.stock || first.title.localeCompare(second.title);
                if (sort === 'price-asc') return first.price - second.price || first.title.localeCompare(second.title);
                if (sort === 'price-desc') return second.price - first.price || first.title.localeCompare(second.title);
                return first.title.localeCompare(second.title);
            });

            if (filtered.length === 0) {
                body.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">No se encontraron productos en el inventario.</td></tr>`;
                renderAccTableTotals(filtered);
                return;
            }

            body.innerHTML = filtered.map(item => `
                <tr class="hover:bg-slate-50 transition ${item.status === 'Anulado' ? 'opacity-60 bg-slate-100' : ''}">
                    <td class="p-3.5">
                        <div class="accessory-product-cell flex items-center gap-3">
                            <img src="${item.image}" class="w-9 h-9 rounded-lg object-cover bg-slate-100 border border-slate-200">
                            <div>
                                <span class="font-bold text-slate-900 block">${item.title}</span>
                                <span class="text-[10px] text-slate-400 font-mono-num">SKU: ${item.id}</span>
                            </div>
                        </div>
                    </td>
                    <td class="p-3.5 font-semibold text-slate-700">${item.brand}</td>
                    <td class="p-3.5 font-medium text-slate-600">
                        <span class="block">${getCategoryName(item.category)}</span>
                        ${['fundas', 'proteccion'].includes(item.category) ? `<span class="text-[10px] text-brand-600">${getAccessorySubcategoryName(item.category, item.subcategory)}</span>` : ''}
                    </td>
                    <td class="p-3.5">
                        <div class="accessory-stock-cell flex items-center gap-2">
                            <span class="font-bold font-mono-num text-xs ${item.stock <= item.minStock ? 'text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200' : 'text-slate-800'}">
                                ${item.stock} un. ${item.status === 'Anulado' ? '<span class="ml-1 text-[9px] uppercase">Anulado</span>' : ''}
                            </span>
                            <div class="flex flex-col gap-0.5">
                                <button onclick="quickAddStock('${item.id}', 1)" class="w-4 h-4 bg-slate-200 hover:bg-slate-300 rounded text-[9px] flex items-center justify-center font-bold">+</button>
                                <button onclick="quickAddStock('${item.id}', -1)" class="w-4 h-4 bg-slate-200 hover:bg-slate-300 rounded text-[9px] flex items-center justify-center font-bold">-</button>
                            </div>
                        </div>
                    </td>
                    <td class="p-3.5 font-mono-num font-semibold text-slate-600">$${item.cost.toLocaleString('es-AR')}</td>
                    <td class="p-3.5 font-mono-num font-bold text-slate-900">$${item.price.toLocaleString('es-AR')}</td>
                    <td class="p-3.5 font-mono-num font-bold text-emerald-600">$${item.cashPrice.toLocaleString('es-AR')}</td>
                    <td class="p-3.5 text-center">
                        <div class="flex items-center justify-center gap-2">
                            <button onclick="editProduct('${item.id}')" class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs" title="Editar">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button onclick="toggleProductStatus('${item.id}')" class="p-1.5 rounded-lg ${item.status === 'Anulado' ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700' : 'bg-amber-50 hover:bg-amber-100 text-amber-700'} text-xs" title="${item.status === 'Anulado' ? 'Reactivar producto' : 'Anular producto'}">
                                <i class="fa-solid ${item.status === 'Anulado' ? 'fa-rotate-left' : 'fa-ban'}"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `).join('');
            renderAccTableTotals(filtered);
        }

        function renderAccTableTotals(products) {
            const totals = products.reduce((result, product) => ({
                stock: result.stock + product.stock,
                cost: result.cost + (product.cost * product.stock),
                sale: result.sale + (product.price * product.stock)
            }), { stock: 0, cost: 0, sale: 0 });
            document.getElementById('accTableTotals').innerHTML = `
                <div><span class="block text-slate-500">Cantidad total</span><strong class="font-mono-num text-sm text-slate-900">${totals.stock} un.</strong></div>
                <div><span class="block text-slate-500">Valor a costo</span><strong class="font-mono-num text-sm text-slate-900">$${totals.cost.toLocaleString('es-AR')}</strong></div>
                <div><span class="block text-emerald-700">Valor a precio de lista</span><strong class="font-mono-num text-sm text-emerald-700">$${totals.sale.toLocaleString('es-AR')}</strong></div>
            `;
        }

        /* PHONES TABLE LOGIC */
        function renderPhonesTable() {
            const body = document.getElementById('phonesTableBody');
            const search = document.getElementById('phoneSearchInput').value.toLowerCase();
            const cond = document.getElementById('phoneConditionFilter').value;

            const filtered = PHONES.filter(p => {
                const matchesCond = cond === 'ALL' || (cond === 'Nuevo' ? p.condition === 'Nuevo' : p.condition.includes('Usado'));
                const matchesSearch = p.model.toLowerCase().includes(search) || p.imei.toLowerCase().includes(search) || p.color.toLowerCase().includes(search) || p.storage.toLowerCase().includes(search);
                return matchesCond && matchesSearch;
            });

            if (filtered.length === 0) {
                body.innerHTML = `<tr><td colspan="8" class="p-8 text-center text-slate-400">No hay smartphones registrados con este criterio.</td></tr>`;
                return;
            }

            body.innerHTML = filtered.map(item => `
                <tr class="hover:bg-slate-50 transition">
                    <td class="p-3.5">
                        <div class="flex items-center gap-3">
                            <img src="${item.image}" class="w-9 h-9 rounded-lg object-cover bg-slate-100 border border-slate-200">
                            <div>
                                <span class="font-bold text-slate-900 block">${item.brand} ${item.model}</span>
                                <span class="text-[10px] text-slate-400 font-mono-num">ID: ${item.id}</span>
                            </div>
                        </div>
                    </td>
                    <td class="p-3.5">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${item.condition === 'Nuevo' ? 'bg-emerald-100 text-emerald-800' : 'bg-purple-100 text-purple-800'}">
                            ${item.condition}
                        </span>
                        ${item.issues?.length ? `<p class="mt-1 text-[10px] text-amber-700">${item.issues.map(getPhoneIssueName).join(' · ')}</p>` : ''}
                    </td>
                    <td class="p-3.5 font-mono-num font-bold text-xs ${item.battery >= 85 ? 'text-emerald-600' : 'text-amber-600'}">
                        ${item.battery}%
                    </td>
                    <td class="p-3.5 font-medium text-slate-700">${item.storage} - ${item.color}</td>
                    <td class="p-3.5 font-mono-num text-xs font-semibold text-slate-600">${item.imei}</td>
                    <td class="p-3.5 font-mono-num font-bold text-slate-900">$${item.price.toLocaleString('es-AR')}</td>
                    <td class="p-3.5">
                        <span class="px-2 py-0.5 rounded-md text-[10px] font-bold ${item.status === 'En Stock' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-600'}">
                            ${item.status}
                        </span>
                    </td>
                    <td class="p-3.5 text-center">
                        <div class="flex items-center justify-center gap-2">
                            ${item.status === 'En Stock' ? `
                                <button onclick="addPhoneToPOS('${item.id}')" class="p-1.5 rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-800 font-bold text-xs flex items-center gap-1" title="Vender en Caja">
                                    <i class="fa-solid fa-cart-plus"></i> Vender
                                </button>
                            ` : ''}
                            ${item.status === 'En Stock' ? `<button onclick="markPhoneSold('${item.id}')" class="p-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-800 text-xs" title="Marcar vendido"><i class="fa-solid fa-check"></i></button>` : ''}
                            <button onclick="editPhone('${item.id}')" class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs" title="Editar">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button onclick="deletePhone('${item.id}')" class="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-xs" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        /* POINT OF SALE (POS) TICKET ENGINE */
        function renderPOSCategories() {
            const container = document.getElementById('posCategoryPills');
            const cats = [{ id: 'ALL', label: 'Todos los Productos' }, ...CATEGORIES, { id: 'celulares', label: 'Smartphone Stock' }];

            container.innerHTML = cats.map(c => `
                <button 
                    onclick="setPOSCategory('${c.id}')" 
                    class="px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition border ${posState.selectedCategory === c.id ? 'bg-emerald-600 text-white border-transparent shadow-sm' : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'}"
                >
                    ${c.name || c.label}
                </button>
            `).join('');
        }

        function setPOSCategory(catId) {
            posState.selectedCategory = catId;
            if (catId !== 'celulares') posState.phoneConditionFilter = 'ALL';
            renderPOSCategories();
            renderPOSItemsGrid();
        }

        function filterPOSItems() {
            renderPOSItemsGrid();
        }

        function handleBarcodeScan(event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const code = event.target.value.trim().toLowerCase();
            if (!code) return;

            const product = PRODUCTS.find(item => item.id.toLowerCase() === code || item.barcode?.toLowerCase() === code);
            const phone = PHONES.find(item => item.id.toLowerCase() === code || item.imei.toLowerCase() === code);
            const item = product || phone;

            if (!item) {
                showToast('No se encontró ningún producto con ese código.');
            } else {
                addPOSItem(item.id, product ? 'acc' : 'phone');
            }

            event.target.value = '';
            event.target.focus();
        }

        function renderPOSItemsGrid() {
            const grid = document.getElementById('posItemsGrid');
            const search = document.getElementById('posSearchInput').value.toLowerCase();
            const cat = posState.selectedCategory;

            let itemsList = [];

            if (cat !== 'celulares') {
                PRODUCTS.forEach(p => {
                    if ((cat === 'ALL' || p.category === cat) && p.stock > 0 && p.status !== 'Anulado') {
                        if (p.title.toLowerCase().includes(search) || p.brand.toLowerCase().includes(search) || p.id.toLowerCase().includes(search)) {
                            itemsList.push({ ...p, type: 'acc' });
                        }
                    }
                });
            }

            if (cat === 'ALL' || cat === 'celulares') {
                PHONES.forEach(ph => {
                    if (ph.status === 'En Stock' && (posState.phoneConditionFilter === 'ALL' || ph.condition === posState.phoneConditionFilter)) {
                        const title = `${ph.brand} ${ph.model} ${ph.storage} (${ph.condition})`;
                        if (title.toLowerCase().includes(search) || ph.imei.toLowerCase().includes(search)) {
                            itemsList.push({
                                id: ph.id,
                                title: title,
                                category: 'celulares',
                                brand: ph.brand,
                                price: ph.price,
                                cashPrice: ph.price,
                                image: ph.image,
                                stock: 1,
                                type: 'phone',
                                imei: ph.imei
                            });
                        }
                    }
                });
            }

            if (itemsList.length === 0) {
                grid.innerHTML = `<div class="col-span-full py-12 text-center text-slate-400 text-xs">No hay productos disponibles en stock con este filtro.</div>`;
                return;
            }

            grid.innerHTML = itemsList.map(item => `
                <div onclick="addPOSItem('${item.id}', '${item.type}')" class="custom-card custom-card-hover p-3 flex flex-col justify-between cursor-pointer group bg-white">
                    <div class="space-y-2">
                        <div class="aspect-square rounded-xl overflow-hidden bg-slate-100 relative">
                            <img src="${item.image}" class="w-full h-full object-cover group-hover:scale-105 transition">
                            <span class="absolute top-1.5 left-1.5 bg-slate-900/80 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                                ${item.type === 'phone' ? 'Celular' : 'Stock: ' + item.stock}
                            </span>
                        </div>
                        <div>
                            <span class="text-[9px] font-bold text-brand-600 uppercase tracking-wider block">${item.brand}</span>
                            <h4 class="text-xs font-bold text-slate-900 line-clamp-2 leading-snug">${item.title}</h4>
                        </div>
                    </div>
                    <div class="pt-2 mt-1 border-t border-bonewhite-border flex items-baseline justify-between">
                        <span class="text-xs font-extrabold font-mono-num text-slate-900">$${item.price.toLocaleString('es-AR')}</span>
                        <span class="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">+ Agregar</span>
                    </div>
                </div>
            `).join('');
        }

        function addPOSItem(id, type) {
            let foundItem = null;

            if (type === 'acc') {
                foundItem = PRODUCTS.find(p => p.id === id);
            } else if (type === 'phone') {
                const ph = PHONES.find(p => p.id === id);
                if (ph) {
                    foundItem = {
                        id: ph.id,
                        title: `${ph.brand} ${ph.model} ${ph.storage} (${ph.condition})`,
                        price: ph.price,
                        cashPrice: ph.price,
                        type: 'phone',
                        imei: ph.imei,
                        maxStock: 1
                    };
                }
            }

            if (!foundItem) return;

            const existingIndex = posState.ticket.findIndex(t => t.id === id);

            if (existingIndex > -1) {
                if (type === 'phone') {
                    showToast("Este celular único ya está cargado en el ticket.");
                    return;
                }
                if (foundItem.stock > 0) {
                    posState.ticket[existingIndex].quantity += 1;
                } else {
                    showToast("No hay más unidades en stock disponible.");
                    return;
                }
            } else {
                posState.ticket.push({
                    id: foundItem.id,
                    title: foundItem.title,
                    price: foundItem.price,
                    cashPrice: foundItem.cashPrice,
                    quantity: 1,
                    type,
                    imei: foundItem.imei || null,
                    maxStock: type === 'acc' ? foundItem.stock : 1
                });
            }

            if (!reservePOSItem(foundItem.id, type, 1)) {
                if (existingIndex > -1) posState.ticket[existingIndex].quantity -= 1;
                else posState.ticket.pop();
                return;
            }
            renderPOSTicket();
            renderPOSItemsGrid();
            renderAccTable();
            renderPhonesTable();
            showToast(`"${foundItem.title.substring(0, 20)}..." agregado a la caja`);
        }

        function addPhoneToPOS(phoneId) {
            switchTab('pos');
            addPOSItem(phoneId, 'phone');
        }

        function updatePOSTicketQty(id, delta) {
            const index = posState.ticket.findIndex(t => t.id === id);
            if (index > -1) {
                const item = posState.ticket[index];
                if (delta > 0 && !reservePOSItem(id, item.type, 1)) return;
                if (delta < 0) releasePOSItem(id, item.type, Math.min(item.quantity, Math.abs(delta)));
                item.quantity += delta;
                if (posState.ticket[index].quantity <= 0) {
                    posState.ticket.splice(index, 1);
                }
            }
            renderPOSTicket();
            renderPOSItemsGrid();
            renderAccTable();
            renderPhonesTable();
        }

        function clearPOSTicket() {
            posState.ticket.forEach(item => releasePOSItem(item.id, item.type, item.quantity));
            posState.ticket = [];
            document.getElementById('posCanjeDeduction').value = '';
            renderPOSTicket();
            renderPOSItemsGrid();
            renderAccTable();
            renderPhonesTable();
        }

        function reservePOSItem(id, type, quantity) {
            if (type === 'acc') {
                const product = PRODUCTS.find(item => item.id === id);
                if (!product || product.stock < quantity) {
                    showToast('No hay más unidades en stock disponible.');
                    return false;
                }
                product.stock -= quantity;
            } else {
                const phone = PHONES.find(item => item.id === id);
                if (!phone || phone.status !== 'En Stock') return false;
                phone.status = 'Reservado';
            }
            saveLocalState();
            return true;
        }

        function releasePOSItem(id, type, quantity) {
            if (type === 'acc') {
                const product = PRODUCTS.find(item => item.id === id);
                if (product) product.stock += quantity;
            } else {
                const phone = PHONES.find(item => item.id === id);
                if (phone?.status === 'Reservado') phone.status = 'En Stock';
            }
            saveLocalState();
        }

        function setPOSPaymentMethod(method) {
            posState.paymentMethod = method;
            const btnTransf = document.getElementById('posPayTransfer');
            const btnCard = document.getElementById('posPayCard');
            const btnMixed = document.getElementById('posPayMixed');
            const btnAccount = document.getElementById('posPayAccount');
            const mixedFields = document.getElementById('mixedPaymentFields');
            posState.paymentMethod = method;

            if (method === 'transfer') {
                document.getElementById('cardPlanSelect').classList.add('hidden');
                mixedFields.classList.add('hidden');
                btnTransf.className = 'py-2 px-2 rounded-xl bg-emerald-50 border border-emerald-500 text-emerald-700 font-bold text-center transition';
                btnCard.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnMixed.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnAccount.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
            } else if (method === 'mixed') {
                document.getElementById('cardPlanSelect').classList.remove('hidden');
                mixedFields.classList.remove('hidden');
                btnMixed.className = 'py-2 px-2 rounded-xl bg-brand-50 border border-brand-500 text-brand-700 font-bold text-center transition';
                btnTransf.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnCard.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnAccount.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
            } else if (method === 'account') {
                document.getElementById('cardPlanSelect').classList.add('hidden');
                mixedFields.classList.add('hidden');
                btnAccount.className = 'py-2 px-2 rounded-xl bg-brand-50 border border-brand-500 text-brand-700 font-bold text-center transition';
                btnTransf.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnCard.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnMixed.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
            } else {
                document.getElementById('cardPlanSelect').classList.remove('hidden');
                mixedFields.classList.add('hidden');
                btnCard.className = 'py-2 px-2 rounded-xl bg-brand-50 border border-brand-500 text-brand-700 font-bold text-center transition';
                btnTransf.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnMixed.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
                btnAccount.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
            }

            calculatePOSTotals();
        }

        function renderPOSTicket() {
            const container = document.getElementById('posTicketList');

            if (posState.ticket.length === 0) {
                container.innerHTML = `
                    <div class="text-center py-10 text-slate-400 space-y-2">
                        <i class="fa-solid fa-cart-shopping text-3xl text-slate-300"></i>
                        <p class="text-xs">El ticket de venta está vacío.</p>
                        <p class="text-[10px]">Haz clic en los productos a la izquierda para sumarlos.</p>
                    </div>
                `;
            } else {
                container.innerHTML = posState.ticket.map(item => `
                    <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-200 flex items-center justify-between gap-2">
                        <div class="min-w-0 flex-1">
                            <h4 class="text-xs font-bold text-slate-900 truncate">${item.title}</h4>
                            <div class="text-[10px] text-slate-500 font-mono-num flex items-center gap-2">
                                <span>$${item.price.toLocaleString('es-AR')} un.</span>
                                ${item.imei ? `<span class="bg-slate-200 px-1 rounded text-slate-700">IMEI: ${item.imei}</span>` : ''}
                            </div>
                        </div>
                        
                        <div class="flex items-center gap-2 shrink-0">
                            ${item.type === 'acc' ? `
                                <div class="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-0.5">
                                    <button onclick="updatePOSTicketQty('${item.id}', -1)" class="w-5 h-5 rounded hover:bg-slate-100 text-xs font-bold text-slate-600 flex items-center justify-center">-</button>
                                    <span class="text-xs font-bold font-mono-num px-1">${item.quantity}</span>
                                    <button onclick="updatePOSTicketQty('${item.id}', 1)" class="w-5 h-5 rounded hover:bg-slate-100 text-xs font-bold text-slate-600 flex items-center justify-center">+</button>
                                </div>
                            ` : `<span class="text-xs font-bold bg-purple-100 text-purple-800 px-2 py-0.5 rounded">Unidad única</span>`}
                            
                            <button onclick="updatePOSTicketQty('${item.id}', -999)" class="text-slate-400 hover:text-red-600 text-xs p-1">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </div>
                `).join('');
            }

            calculatePOSTotals();
        }

        function calculatePOSTotals() {
            let subtotal = posState.ticket.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            let canjeVal = parseFloat(document.getElementById('posCanjeDeduction').value) || 0;
            const mixedCard = parseFloat(document.getElementById('mixedCardAmount').value) || 0;
            const cardBase = posState.paymentMethod === 'mixed' ? mixedCard : Math.max(0, subtotal - canjeVal);
            const cardCharges = posState.paymentMethod === 'mixed' || posState.paymentMethod === 'card' ? calculateCardCharges(cardBase) : { commission: 0, vat: 0, total: 0 };
            const surcharge = cardCharges.total;
            document.getElementById('posSurchargeRow').classList.toggle('hidden', surcharge === 0);
            document.getElementById('posSurcharge').textContent = `+$${surcharge.toLocaleString('es-AR')} (comisión + IVA)`;
            let finalTotal = Math.max(0, subtotal + surcharge - canjeVal);

            document.getElementById('posSubtotal').textContent = `$${subtotal.toLocaleString('es-AR')}`;
            document.getElementById('posTotal').textContent = `$${finalTotal.toLocaleString('es-AR')}`;
        }

        function syncMixedPayment(source) {
            const subtotal = posState.ticket.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const canjeVal = parseFloat(document.getElementById('posCanjeDeduction').value) || 0;
            const amountDue = Math.max(0, subtotal - canjeVal);
            const sourceInput = document.getElementById(source === 'cash' ? 'mixedCashAmount' : 'mixedCardAmount');
            const otherInput = document.getElementById(source === 'cash' ? 'mixedCardAmount' : 'mixedCashAmount');
            const sourceAmount = Math.min(Math.max(0, parseFloat(sourceInput.value) || 0), amountDue);

            sourceInput.value = sourceAmount || '';
            otherInput.value = sourceAmount < amountDue ? amountDue - sourceAmount : '';
            calculatePOSTotals();
        }

        function processPOSCheckout() {
            if (posOperationInProgress || pendingSaleId) return;
            if (posState.ticket.length === 0) {
                showToast("Cargá al menos un producto al ticket antes de cobrar.");
                return;
            }

            const customerName = document.getElementById('posCustomerName').value.trim() || 'Cliente Mostrador';
            const customerPhone = document.getElementById('posCustomerPhone').value.trim() || '-';
            if (posState.paymentMethod === 'account' && customerName === 'Cliente Mostrador') {
                showToast('Selecciona o carga un cliente para registrar una venta en cuenta corriente.');
                return;
            }
            const canjeVal = parseFloat(document.getElementById('posCanjeDeduction').value) || 0;

            let subtotal = posState.ticket.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const mixedCash = parseFloat(document.getElementById('mixedCashAmount').value) || 0;
            const mixedCard = parseFloat(document.getElementById('mixedCardAmount').value) || 0;
            const netTotal = Math.max(0, subtotal - canjeVal);
            if (posState.paymentMethod === 'mixed' && Math.round(mixedCash + mixedCard) > Math.round(netTotal)) {
                showToast('El pago mixto no puede superar el importe a cobrar.');
                return;
            }
            if (posState.paymentMethod === 'mixed' && Math.round(mixedCash + mixedCard) !== Math.round(netTotal)) {
                showToast('El pago mixto debe completar el importe a cobrar.');
                return;
            }
            const cardBase = posState.paymentMethod === 'mixed' ? mixedCard : posState.paymentMethod === 'account' ? 0 : netTotal;
            const cardCharges = posState.paymentMethod === 'mixed' || posState.paymentMethod === 'card' ? calculateCardCharges(cardBase) : { commission: 0, vat: 0, total: 0 };
            const surcharge = cardCharges.total;
            let total = netTotal + surcharge;

            posOperationInProgress = true;
            const checkoutButton = document.getElementById('posCheckoutButton');
            checkoutButton.disabled = true;
            checkoutButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>Preparando comprobante...</span>';
            const saleRecord = {
                id: `TK-${Date.now().toString().slice(-5)}`,
                date: `${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
                customerName: customerName,
                customerPhone: customerPhone,
                items: posState.ticket.map(item => ({ ...item })),
                status: 'Pendiente de emisión',
                paymentMethod: posState.paymentMethod === 'transfer' ? 'Efectivo/Transferencia' : posState.paymentMethod === 'mixed' ? 'Pago mixto' : posState.paymentMethod === 'account' ? 'Cuenta corriente' : 'Tarjeta/Cuotas',
                paymentBreakdown: { cash: posState.paymentMethod === 'mixed' ? mixedCash : posState.paymentMethod === 'transfer' ? total : 0, card: posState.paymentMethod === 'mixed' ? mixedCard + surcharge : posState.paymentMethod === 'card' ? total : 0 },
                cardCommission: cardCharges.commission,
                cardCommissionVat: cardCharges.vat,
                canjeDeduction: canjeVal,
                surcharge: surcharge,
                subtotal: subtotal,
                total: total
            };

            SALES.unshift(saleRecord);
            let client = CLIENTS.find(item => item.name.toLowerCase() === customerName.toLowerCase());
            if (!client && customerName !== 'Cliente Mostrador') {
                client = { id: `CLI-${Date.now()}`, name: customerName, phone: customerPhone === '-' ? '' : customerPhone, email: '', purchaseCount: 0 };
                CLIENTS.push(client);
            }
            if (client) {
                client.purchaseCount = (client.purchaseCount || 0) + 1;
                if (posState.paymentMethod === 'account') client.accountBalance = (client.accountBalance || 0) + total;
            }
            lastCreatedSale = saleRecord;
            pendingSaleId = saleRecord.id;
            saveLocalState();

            // Refresh UI
            renderDashboard();
            renderAccTable();
            renderPhonesTable();
            renderSalesTable();
            renderPOSItemsGrid();

            openReceiptModal(saleRecord);
            showToast('Comprobante listo. Imprime, envía por WhatsApp o cancela la venta.');
        }

        function cashRegisterDate() {
            return new Date().toLocaleDateString('es-AR');
        }

        function renderCashRegister() {
            const today = cashRegisterDate();
            const todaySales = SALES.filter(sale => sale.date.includes(today) && sale.status !== 'Anulada' && sale.status !== 'Pendiente de emisión' && sale.paymentMethod !== 'Cuenta corriente');
            const totals = todaySales.reduce((result, sale) => {
                const breakdown = sale.paymentBreakdown || {
                    cash: sale.paymentMethod === 'Tarjeta/Cuotas' ? 0 : sale.total,
                    card: sale.paymentMethod === 'Tarjeta/Cuotas' ? sale.total : 0
                };
                result.cash += breakdown.cash || 0;
                result.card += breakdown.card || 0;
                return result;
            }, { cash: 0, card: 0 });
            const opening = cashRegister.date === today ? cashRegister.openingCash : 0;
            const status = cashRegister.date === today && cashRegister.open ? `Abierta con $${opening.toLocaleString('es-AR')} de fondo` : 'Caja cerrada';
            document.getElementById('cashRegisterStatus').textContent = status;
            document.getElementById('cashRegisterSummary').innerHTML = `
                <div class="bg-slate-50 rounded-xl p-3"><span class="block text-slate-500">Efectivo / transferencia</span><strong class="text-slate-900">$${totals.cash.toLocaleString('es-AR')}</strong></div>
                <div class="bg-slate-50 rounded-xl p-3"><span class="block text-slate-500">Tarjetas</span><strong class="text-slate-900">$${totals.card.toLocaleString('es-AR')}</strong></div>
                <div class="bg-emerald-50 rounded-xl p-3"><span class="block text-emerald-700">Efectivo esperado</span><strong class="text-emerald-800">$${(opening + totals.cash).toLocaleString('es-AR')}</strong></div>
            `;
        }

        async function openCashRegister() {
            if (!requireAdmin()) return;
            const opening = parseFloat(document.getElementById('openingCashInput').value);
            if (!Number.isFinite(opening) || opening < 0) {
                showToast('Ingresa un fondo inicial válido para abrir la caja.');
                return;
            }
            cashRegister = { date: cashRegisterDate(), openingCash: opening, open: true };
            await saveLocalState();
            renderCashRegister();
            showToast('Caja abierta correctamente.');
        }

        async function closeCashRegister() {
            if (!requireAdmin()) return;
            if (cashRegister.date !== cashRegisterDate() || !cashRegister.open) {
                showToast('No hay una caja abierta para cerrar.');
                return;
            }
            const todaySales = SALES.filter(sale => sale.date.includes(cashRegisterDate()) && sale.status !== 'Anulada' && sale.status !== 'Pendiente de emisión' && sale.paymentMethod !== 'Cuenta corriente');
            const cashSales = todaySales.reduce((sum, sale) => sum + (sale.paymentBreakdown?.cash || (sale.paymentMethod === 'Tarjeta/Cuotas' ? 0 : sale.total)), 0);
            const expectedAmount = cashRegister.openingCash + cashSales;
            const expected = `$${expectedAmount.toLocaleString('es-AR')}`;
            const actual = window.prompt(`Efectivo real contado (esperado ${expected}):`, '0');
            if (actual === null) return;
            const actualCash = parseFloat(actual);
            if (!Number.isFinite(actualCash) || actualCash < 0) {
                showToast('Ingresa un importe contado válido.');
                return;
            }
            cashRegister = { ...cashRegister, open: false, closingCash: actualCash, closedAt: new Date().toISOString() };
            await saveLocalState();
            renderCashRegister();
            showToast(`Caja cerrada. Diferencia: $${(actualCash - expectedAmount).toLocaleString('es-AR')}`);
        }

        /* SALES HISTORY TABLE */
        function renderSalesTable() {
            const body = document.getElementById('salesTableBody');

            if (SALES.length === 0) {
                body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">Aún no hay ventas registradas en el sistema.</td></tr>`;
                return;
            }

            body.innerHTML = SALES.map(sale => `
                <tr class="hover:bg-slate-50 transition ${sale.status === 'Anulada' ? 'opacity-50 bg-red-50' : sale.status === 'Pendiente de emisión' ? 'bg-amber-50' : ''}">
                    <td class="p-3.5">
                        <span class="font-bold text-slate-900 block font-mono-num">${sale.id}</span>
                        <span class="text-[10px] text-slate-400">${sale.date}</span>
                    </td>
                    <td class="p-3.5 font-medium text-slate-800">
                        ${sale.customerName}
                        ${sale.customerPhone !== '-' ? `<span class="block text-[10px] text-slate-400">${sale.customerPhone}</span>` : ''}
                    </td>
                    <td class="p-3.5">
                        <div class="text-xs space-y-0.5">
                            ${sale.items.map(i => `<div class="text-slate-700">${i.quantity}x ${i.title}</div>`).join('')}
                        </div>
                    </td>
                    <td class="p-3.5 font-semibold text-slate-700">${sale.paymentMethod}</td>
                    <td class="p-3.5 font-bold font-mono-num ${sale.status === 'Anulada' ? 'text-red-600 line-through' : 'text-emerald-600'}">$${sale.total.toLocaleString('es-AR')} ${sale.status === 'Anulada' ? '<span class="block text-[10px] no-underline">ANULADA</span>' : sale.status === 'Pendiente de emisión' ? '<span class="block text-[10px] text-amber-700 no-underline">PENDIENTE</span>' : sale.paymentMethod === 'Cuenta corriente' ? '<span class="block text-[10px] text-slate-500 no-underline">A CUENTA</span>' : ''}</td>
                    <td class="p-3.5 text-center">
                        <button onclick="reprintReceipt('${sale.id}')" class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold" title="Ver Comprobante">
                            <i class="fa-solid fa-receipt"></i>
                        </button>
                        ${isAdmin() && sale.status !== 'Anulada' ? `<button onclick="cancelSale('${sale.id}')" class="p-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-700 text-xs" title="Anular venta"><i class="fa-solid fa-ban"></i></button>` : ''}
                        ${isAdmin() ? `<button onclick="deleteSale('${sale.id}')" class="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-xs" title="Eliminar venta"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </td>
                </tr>
            `).join('');
        }

        async function cancelSale(saleId) {
            if (!requireAdmin()) return;
            const sale = SALES.find(item => item.id === saleId);
            if (!sale || sale.status === 'Anulada') return;
            if (sale.status === 'Pendiente de emisión') {
                pendingSaleId = sale.id;
                await cancelPendingSale();
                return;
            }
            sale.items.forEach(item => {
                if (item.type === 'acc') {
                    const product = PRODUCTS.find(productItem => productItem.id === item.id);
                    if (product) product.stock += item.quantity;
                } else if (item.type === 'phone') {
                    const phone = PHONES.find(phoneItem => phoneItem.id === item.id);
                    if (phone) phone.status = 'En Stock';
                }
            });
            sale.status = 'Anulada';
            if (sale.paymentMethod === 'Cuenta corriente') {
                const client = CLIENTS.find(item => item.name.toLowerCase() === sale.customerName.toLowerCase());
                if (client) client.accountBalance = Math.max(0, (client.accountBalance || 0) - sale.total);
            }
            await saveLocalState();
            renderSalesTable();
            renderDashboard();
            renderAccTable();
            renderPhonesTable();
            renderPOSItemsGrid();
            showToast('Venta anulada. Se conserva en el historial.');
        }

        async function deleteSale(saleId) {
            if (!requireAdmin()) return;
            SALES = SALES.filter(item => item.id !== saleId);
            await saveLocalState();
            renderSalesTable();
            renderDashboard();
            showToast('Venta eliminada del historial.');
        }

        function reprintReceipt(saleId) {
            const sale = SALES.find(s => s.id === saleId);
            if (sale) {
                if (sale.status === 'Pendiente de emisión') pendingSaleId = sale.id;
                openReceiptModal(sale);
            }
        }

        function openReceiptModal(sale) {
            lastCreatedSale = sale;
            document.getElementById('receiptDate').textContent = `Fecha: ${sale.date} | Ticket: ${sale.id}`;
            document.getElementById('receiptCustomerInfo').innerHTML = `
                <div><strong>Cliente:</strong> ${sale.customerName}</div>
                ${sale.customerPhone !== '-' ? `<div><strong>Teléfono:</strong> ${sale.customerPhone}</div>` : ''}
                <div><strong>Forma de pago:</strong> ${sale.paymentMethod}</div>
            `;

            document.getElementById('receiptItemsList').innerHTML = sale.items.map(i => `
                <div class="flex justify-between text-slate-800">
                    <span>${i.quantity}x ${i.title}</span>
                    <span>$${(i.price * i.quantity).toLocaleString('es-AR')}</span>
                </div>
            `).join('');

            let totalsHTML = `<div>Subtotal: $${sale.subtotal.toLocaleString('es-AR')}</div>`;
            if (sale.surcharge > 0) totalsHTML += `<div class="text-amber-700">Recargo tarjeta: +$${sale.surcharge.toLocaleString('es-AR')}</div>`;
            if (sale.canjeDeduction > 0) totalsHTML += `<div class="text-amber-700">Plan Canje: -$${sale.canjeDeduction.toLocaleString('es-AR')}</div>`;
            totalsHTML += `<div class="text-sm font-black pt-1 border-t border-slate-300">TOTAL: $${sale.total.toLocaleString('es-AR')}</div>`;

            document.getElementById('receiptTotals').innerHTML = totalsHTML;
            document.getElementById('cancelPendingSaleBtn').classList.toggle('hidden', sale.status !== 'Pendiente de emisión');
            document.getElementById('receiptModal').classList.remove('hidden');
        }

        function closeReceiptModal() {
            if (pendingSaleId) {
                cancelPendingSale();
                return;
            }
            document.getElementById('receiptModal').classList.add('hidden');
        }

        async function finalizePendingSale(deliveryMethod) {
            const sale = SALES.find(item => item.id === pendingSaleId);
            if (!sale || sale.status !== 'Pendiente de emisión' || posOperationInProgress === false) return;
            sale.status = 'Confirmada';
            sale.deliveryMethod = deliveryMethod;
            sale.items.forEach(item => {
                if (item.type !== 'acc') return;
                const product = PRODUCTS.find(productItem => productItem.id === item.id);
                if (product?.stock === 0) product.status = 'Anulado';
            });
            await saveLocalState();
            pendingSaleId = null;
            posState.ticket = [];
            document.getElementById('posCanjeDeduction').value = '';
            document.getElementById('posCustomerName').value = '';
            document.getElementById('posCustomerPhone').value = '';
            posState.phoneConditionFilter = 'ALL';
            posOperationInProgress = false;
            const checkoutButton = document.getElementById('posCheckoutButton');
            checkoutButton.disabled = false;
            checkoutButton.innerHTML = '<i class="fa-solid fa-check-circle"></i><span>Emitir comprobante</span>';
            renderPOSTicket();
            renderDashboard();
            renderSalesTable();
            renderCashRegister();
            document.getElementById('receiptModal').classList.add('hidden');
            showToast('Venta confirmada y stock actualizado.');
        }

        async function cancelPendingSale() {
            const sale = SALES.find(item => item.id === pendingSaleId);
            if (!sale || sale.status !== 'Pendiente de emisión') return;
            sale.items.forEach(item => releasePOSItem(item.id, item.type, item.quantity));
            const client = CLIENTS.find(item => item.name.toLowerCase() === sale.customerName.toLowerCase());
            if (client) {
                client.purchaseCount = Math.max(0, (client.purchaseCount || 1) - 1);
                if (sale.paymentMethod === 'Cuenta corriente') client.accountBalance = Math.max(0, (client.accountBalance || 0) - sale.total);
            }
            SALES = SALES.filter(item => item.id !== sale.id);
            pendingSaleId = null;
            posState.ticket = [];
            posOperationInProgress = false;
            const checkoutButton = document.getElementById('posCheckoutButton');
            checkoutButton.disabled = false;
            checkoutButton.innerHTML = '<i class="fa-solid fa-check-circle"></i><span>Emitir comprobante</span>';
            await saveLocalState();
            renderPOSTicket();
            renderDashboard();
            renderAccTable();
            renderPhonesTable();
            renderPOSItemsGrid();
            renderSalesTable();
            document.getElementById('receiptModal').classList.add('hidden');
            showToast('Venta cancelada. Se restauró el stock reservado.');
        }

        async function printReceipt() {
            window.print();
            if (pendingSaleId) await finalizePendingSale('Impreso');
        }

        async function sendReceiptViaWhatsApp() {
            if (!lastCreatedSale) return;

            let msg = 'BE STORE - COMPROBANTE DE COMPRA\n';
            msg += 'N Ticket: ' + lastCreatedSale.id + '\nFecha: ' + lastCreatedSale.date + '\nCliente: ' + lastCreatedSale.customerName + '\n\n';
            msg += 'Detalle de Productos:\n';
            lastCreatedSale.items.forEach((item, index) => {
                msg += (index + 1) + '. ' + item.quantity + 'x ' + item.title + ' - ' + (item.price * item.quantity).toLocaleString('es-AR') + '\n';
            });
            msg += '\nTotal Pagado: ' + lastCreatedSale.total.toLocaleString('es-AR') + '\n';
            msg += 'Medio de Pago: ' + lastCreatedSale.paymentMethod + '\n\nGracias por elegir BE STORE! @bestoreok';
            window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
            if (pendingSaleId) await finalizePendingSale('WhatsApp');
        }

        /* PLAN CANJE ENGINE */
        async function loadIphoneTradeInRates() {
            try {
                const response = await fetch('js/iphone-trade-in-rates.json');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (!Array.isArray(data.rates) || data.rates.length === 0) throw new Error('La tabla no contiene cotizaciones.');
                IPHONE_TRADE_IN_RATES = data.rates;
            } catch (error) {
                console.error('No se pudo cargar la tabla de cotizaciones de iPhone.', error);
                showToast('No se pudo cargar la tabla de cotizaciones de iPhone.');
            }
        }

        function updateCanjeModelOptions() {
            const modelSelect = document.getElementById('canjeModelSelect');
            const currentModel = modelSelect.value;
            modelSelect.innerHTML = '';
            [...new Set(IPHONE_TRADE_IN_RATES.map(rate => rate.model))].forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                modelSelect.appendChild(option);
            });
            if ([...modelSelect.options].some(option => option.value === currentModel)) modelSelect.value = currentModel;
            modelSelect.onchange = updateCanjeStorageOptions;
            updateCanjeStorageOptions();
        }

        function updateCanjeStorageOptions() {
            const model = document.getElementById('canjeModelSelect').value;
            const storageSelect = document.getElementById('canjeStorageSelect');
            const currentStorage = storageSelect.value;
            storageSelect.innerHTML = '';
            IPHONE_TRADE_IN_RATES
                .filter(rate => rate.model === model)
                .sort((first, second) => first.storageGb - second.storageGb)
                .forEach(rate => {
                    const option = document.createElement('option');
                    option.value = rate.storageGb;
                    option.textContent = `${rate.storageGb} GB`;
                    storageSelect.appendChild(option);
                });
            if ([...storageSelect.options].some(option => option.value === currentStorage)) storageSelect.value = currentStorage;
        }

        function renderCategorySelects() {
            const selects = [document.getElementById('prodCategory'), document.getElementById('accCategoryFilter')];
            selects.forEach(select => {
                if (!select) return;
                const current = select.value;
                select.innerHTML = select.id === 'accCategoryFilter' ? '<option value="ALL">Todas las categorías</option>' : '';
                CATEGORIES.forEach(category => {
                    const option = document.createElement('option');
                    option.value = category.id;
                    option.textContent = category.name;
                    select.appendChild(option);
                });
                if ([...select.options].some(option => option.value === current)) select.value = current;
            });
            updateProductSubcategoryField();
            updateAccessorySubcategoryFilter();
        }

        function getCategoryName(categoryId) {
            return CATEGORIES.find(category => category.id === categoryId)?.name || categoryId;
        }

        function getCaseSubcategoryName(subcategoryId) {
            return CASE_SUBCATEGORIES.find(subcategory => subcategory.id === subcategoryId)?.name || 'Sin especificar';
        }

        function getAccessorySubcategories(categoryId) {
            if (categoryId === 'fundas') return CASE_SUBCATEGORIES;
            if (categoryId === 'proteccion') return PROTECTION_SUBCATEGORIES;
            return [];
        }

        function getAccessorySubcategoryName(categoryId, subcategoryId) {
            return getAccessorySubcategories(categoryId).find(subcategory => subcategory.id === subcategoryId)?.name || 'Sin especificar';
        }

        function normalizeCaseSubcategories() {
            CASE_SUBCATEGORIES = CASE_SUBCATEGORIES.filter(subcategory => subcategory.id !== 'otro');
        }

        function updateProductSubcategoryField() {
            const categoryId = document.getElementById('prodCategory').value;
            const hasSubcategories = getAccessorySubcategories(categoryId).length > 0;
            const field = document.getElementById('prodSubcategoryField');
            const select = document.getElementById('prodSubcategory');
            field.classList.toggle('hidden', !hasSubcategories);
            select.required = hasSubcategories;
            document.getElementById('prodSubcategoryLabel').textContent = categoryId === 'proteccion' ? 'Tipo de vidrio templado *' : 'Tipo de funda *';
            renderAccessorySubcategoryOptions(categoryId);
            if (!hasSubcategories) {
                select.value = '';
                document.getElementById('prodCustomSubcategory').value = '';
            }
            updateCustomCaseSubcategoryField();
        }

        function updateCustomCaseSubcategoryField() {
            const select = document.getElementById('prodSubcategory');
            const input = document.getElementById('prodCustomSubcategory');
            const isCustomType = document.getElementById('prodCategory').value === 'fundas' && select.value === 'otro';
            input.classList.toggle('hidden', !isCustomType);
            input.required = isCustomType;
            if (!isCustomType) input.value = '';
        }

        function saveCustomCaseSubcategory(name) {
            const normalizedName = name.trim();
            const existing = CASE_SUBCATEGORIES.find(subcategory => subcategory.name.toLowerCase() === normalizedName.toLowerCase());
            if (existing) return existing.id;

            const baseId = normalizedName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'tipo-funda';
            let id = baseId;
            let suffix = 2;
            while (CASE_SUBCATEGORIES.some(subcategory => subcategory.id === id)) id = `${baseId}-${suffix++}`;
            CASE_SUBCATEGORIES.push({ id, name: normalizedName });
            return id;
        }

        function updateAccessorySubcategoryFilter() {
            const categoryFilter = document.getElementById('accCategoryFilter');
            const subcategoryFilter = document.getElementById('accSubcategoryFilter');
            const current = subcategoryFilter.value;
            const subcategories = getAccessorySubcategories(categoryFilter.value);
            const hasSubcategories = subcategories.length > 0;
            subcategoryFilter.innerHTML = '<option value="ALL">Todos los tipos</option>' + subcategories.map(subcategory => `<option value="${subcategory.id}">${subcategory.name}</option>`).join('');
            if ([...subcategoryFilter.options].some(option => option.value === current)) subcategoryFilter.value = current;
            subcategoryFilter.disabled = !hasSubcategories;
            subcategoryFilter.classList.toggle('text-slate-400', !hasSubcategories);
            subcategoryFilter.classList.toggle('text-slate-700', hasSubcategories);
            if (!hasSubcategories) subcategoryFilter.value = 'ALL';
        }

        function renderCaseSubcategoryOptions() {
            renderAccessorySubcategoryOptions(document.getElementById('prodCategory').value);
        }

        function renderAccessorySubcategoryOptions(categoryId) {
            const select = document.getElementById('prodSubcategory');
            const current = select.value;
            const subcategories = getAccessorySubcategories(categoryId);
            const placeholder = categoryId === 'proteccion' ? 'Seleccionar tipo de vidrio' : 'Seleccionar tipo de funda';
            select.innerHTML = `<option value="">${placeholder}</option>` + subcategories.map(subcategory => `<option value="${subcategory.id}">${subcategory.name}</option>`).join('') + (categoryId === 'fundas' ? '<option value="otro">Otro tipo</option>' : '');
            if ([...select.options].some(option => option.value === current)) select.value = current;
        }

        function renderCategoriesPage() {
            const container = document.getElementById('categoriesPageList');
            if (!container) return;
            const sort = document.getElementById('categorySort')?.value || 'name';
            const categories = [...CATEGORIES].sort((a, b) => {
                const countA = PRODUCTS.filter(product => product.category === a.id).length;
                const countB = PRODUCTS.filter(product => product.category === b.id).length;
                return sort === 'count' ? countB - countA || a.name.localeCompare(b.name) : a.name.localeCompare(b.name);
            });
            container.innerHTML = categories.map(category => `
                <button onclick="showCategoryProducts('${category.id}')" class="custom-card p-5 text-left hover:border-brand-500 transition"><div class="flex items-center justify-between"><h4 class="font-bold text-slate-900">${category.name}</h4><span class="bg-brand-50 text-brand-700 rounded-full px-2 py-1 text-xs font-bold">${PRODUCTS.filter(product => product.category === category.id).length} productos</span></div><p class="text-[11px] text-slate-500 mt-2">Ver productos de esta categoría</p></button>
            `).join('');
        }

        function showCategoryProducts(categoryId) {
            const category = CATEGORIES.find(item => item.id === categoryId);
            if (!category) return;
            const products = PRODUCTS.filter(product => product.category === categoryId);
            document.getElementById('categoryProductsTitle').textContent = `${category.name} (${products.length})`;
            document.getElementById('categoryProductsList').innerHTML = products.map(product => `<div class="border border-slate-200 rounded-xl p-3 flex items-center justify-between"><div><p class="font-bold text-xs text-slate-900">${product.title}</p><p class="text-[10px] text-slate-500">${product.brand} · Stock: ${product.stock}</p></div><span class="font-mono-num font-bold text-xs">$${product.price.toLocaleString('es-AR')}</span></div>`).join('') || '<p class="text-xs text-slate-400">No hay productos en esta categoría.</p>';
            document.getElementById('categoryProductsPanel').classList.remove('hidden');
        }

        function closeCategoryProducts() {
            document.getElementById('categoryProductsPanel').classList.add('hidden');
        }

        function renderClients() {
            const body = document.getElementById('clientsTableBody');
            if (!body) return;
            document.getElementById('clientsOptions').innerHTML = CLIENTS.map(client => `<option value="${client.name}">`).join('');
            body.innerHTML = CLIENTS.map(client => {
                const whatsappNumber = (client.phone || '').replace(/\D/g, '');
                const contact = whatsappNumber
                    ? `<a href="https://wa.me/${whatsappNumber}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 font-semibold text-emerald-700 hover:underline" title="Enviar mensaje por WhatsApp"><i class="fa-brands fa-whatsapp"></i>${client.phone}</a>`
                    : '-';
                return `<tr class="border-b border-slate-100"><td class="p-3 font-semibold">${client.name}</td><td class="p-3">${contact}${client.email ? `<span class="block text-[10px] text-slate-500">${client.email}</span>` : ''}</td><td class="p-3">${client.purchaseCount || 0}${client.accountBalance > 0 ? `<span class="block text-[10px] font-mono-num text-amber-700">Cuenta corriente: $${client.accountBalance.toLocaleString('es-AR')}</span>` : ''}</td><td class="p-3 text-center"><button onclick="editClient('${client.id}')" class="p-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs" title="Editar cliente"><i class="fa-solid fa-pen"></i></button></td></tr>`;
            }).join('') || '<tr><td colspan="4" class="p-6 text-center text-slate-400">No hay clientes registrados.</td></tr>';
        }

        async function saveClient(event) {
            event.preventDefault();
            const clientId = document.getElementById('clientId').value;
            const clientData = { name: document.getElementById('clientName').value.trim(), phone: document.getElementById('clientPhone').value.trim(), email: document.getElementById('clientEmail').value.trim() };
            const existingIndex = CLIENTS.findIndex(client => client.id === clientId);
            if (existingIndex > -1) {
                CLIENTS[existingIndex] = { ...CLIENTS[existingIndex], ...clientData };
            } else {
                CLIENTS.push({ id: `CLI-${Date.now()}`, ...clientData, purchaseCount: 0, accountBalance: 0 });
            }
            await saveLocalState();
            cancelClientEdit();
            renderClients();
            showToast(existingIndex > -1 ? 'Cliente actualizado correctamente.' : 'Cliente registrado correctamente.');
        }

        function editClient(clientId) {
            const client = CLIENTS.find(item => item.id === clientId);
            if (!client) return;
            document.getElementById('clientId').value = client.id;
            document.getElementById('clientName').value = client.name;
            document.getElementById('clientPhone').value = client.phone || '';
            document.getElementById('clientEmail').value = client.email || '';
            document.getElementById('clientFormTitle').textContent = 'Editar cliente';
            document.getElementById('clientSubmitButton').textContent = 'Guardar cambios';
            document.getElementById('cancelClientEditButton').classList.remove('hidden');
            document.getElementById('clientName').focus();
        }

        function cancelClientEdit() {
            const form = document.getElementById('clientId').closest('form');
            form.reset();
            document.getElementById('clientId').value = '';
            document.getElementById('clientFormTitle').textContent = 'Clientes';
            document.getElementById('clientSubmitButton').textContent = 'Registrar cliente';
            document.getElementById('cancelClientEditButton').classList.add('hidden');
        }

        async function markPhoneSold(id) {
            if (!requireAdmin()) return;
            const phone = PHONES.find(item => item.id === id);
            if (!phone) return;
            phone.status = 'Vendido';
            await saveLocalState();
            renderPhonesTable();
            renderDashboard();
        }

        async function deletePhone(id) {
            if (!requireAdmin()) return;
            PHONES = PHONES.filter(item => item.id !== id);
            await saveLocalState();
            renderPhonesTable();
            renderDashboard();
        }

        function openCategoryModal() {
            if (!requireAdmin()) return;
            renderCategoryList();
            document.getElementById('categoryModal').classList.remove('hidden');
        }

        function closeCategoryModal() {
            document.getElementById('categoryModal').classList.add('hidden');
        }

        function renderCategoryList() {
            document.getElementById('categoryList').innerHTML = CATEGORIES.map(category => `
                <div class="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs">
                    <span class="font-semibold">${category.name}</span>
                    <button onclick="deleteCategory('${category.id}')" class="text-red-600 hover:text-red-800" title="Eliminar"><i class="fa-solid fa-trash"></i></button>
                </div>
            `).join('');
        }

        async function saveCategory(event) {
            event.preventDefault();
            if (!requireAdmin()) return;
            const name = document.getElementById('categoryName').value.trim();
            const id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            if (!id || CATEGORIES.some(category => category.id === id)) return showToast('La categoría ya existe.');
            CATEGORIES.push({ id, name });
            document.getElementById('categoryName').value = '';
            await saveLocalState();
            renderCategorySelects();
            renderCategoryList();
        }

        async function deleteCategory(id) {
            if (!requireAdmin()) return;
            if (PRODUCTS.some(product => product.category === id)) return showToast('No se puede eliminar una categoría con productos.');
            CATEGORIES = CATEGORIES.filter(category => category.id !== id);
            await saveLocalState();
            renderCategorySelects();
            renderCategoryList();
        }

        function calculateTradeInValue() {
            if (dailyDollarRate <= 0) {
                showToast('Carga la cotización del dólar del día para calcular el canje.');
                return;
            }
            const model = document.getElementById('canjeModelSelect').value;
            const storageGb = Number(document.getElementById('canjeStorageSelect').value);
            const battery = parseInt(document.getElementById('canjeBatteryInput').value) || 85;
            const item = IPHONE_TRADE_IN_RATES.find(rate => rate.model === model && rate.storageGb === storageGb);
            if (!item) {
                showToast('No existe una cotización para el modelo y almacenamiento seleccionados.');
                return;
            }

            const baseValuationUsd = battery >= 90 ? item.over90Usd : item.under90Usd;
            const repairDiscountUsd = Math.max(0, Number(document.getElementById('canjeRepairDiscountUsd').value) || 0);
            activeTradeInValuationUsd = Math.max(0, baseValuationUsd - repairDiscountUsd);
            activeTradeInValuation = Math.round(activeTradeInValuationUsd * dailyDollarRate / 1000) * 1000;

            document.getElementById('canjeValuationResult').textContent = `USD ${activeTradeInValuationUsd.toLocaleString('en-US')}`;
            const breakdown = document.getElementById('canjeValuationBreakdown');
            breakdown.textContent = repairDiscountUsd > 0
                ? `USD ${baseValuationUsd.toLocaleString('en-US')} - USD ${repairDiscountUsd.toLocaleString('en-US')} por reparaciones`
                : `Cotización base: USD ${baseValuationUsd.toLocaleString('en-US')}`;
            breakdown.classList.remove('hidden');
            document.getElementById('canjeValuationArs').textContent = `$${activeTradeInValuation.toLocaleString('es-AR')} ARS`;
            document.getElementById('canjeValuationRate').textContent = `Cotización del dólar: $${dailyDollarRate.toLocaleString('es-AR')} ARS`;
            document.getElementById('canjeResultCard').classList.remove('hidden');
        }

        function toggleCanjeDamageFields() {
            const hasDetails = document.getElementById('canjeConditionSelect').value === 'Detalles';
            document.getElementById('canjeDamageFields').classList.toggle('hidden', !hasDetails);
            if (!hasDetails) {
                document.querySelectorAll('input[name="canjeDamage"]').forEach(checkbox => checkbox.checked = false);
                document.getElementById('canjeOtherDamageText').value = '';
                document.getElementById('canjeOtherDamageText').classList.add('hidden');
            }
        }

        function toggleCanjeOtherDamage() {
            const otherInput = document.getElementById('canjeOtherDamageText');
            const isOtherSelected = document.getElementById('canjeOtherDamage').checked;
            otherInput.classList.toggle('hidden', !isOtherSelected);
            if (!isOtherSelected) otherInput.value = '';
        }

        function applyCanjeToPOS() {
            if (activeTradeInValuation <= 0) return;
            switchTab('pos');
            document.getElementById('posSearchInput').value = '';
            posState.phoneConditionFilter = 'Nuevo';
            setPOSCategory('celulares');
            document.getElementById('posCanjeDeduction').value = activeTradeInValuation;
            calculatePOSTotals();
            showToast(`$${activeTradeInValuation.toLocaleString('es-AR')} cargados como descuento. Selecciona un celular nuevo en stock.`);
        }

        function intakeUsedPhoneFromCanje() {
            if (activeTradeInValuation <= 0) return;
            const brand = document.getElementById('canjeBrandSelect').value;
            const model = document.getElementById('canjeModelSelect').value;
            const storage = document.getElementById('canjeStorageSelect').value;
            const condition = document.getElementById('canjeConditionSelect').value;
            const battery = parseInt(document.getElementById('canjeBatteryInput').value) || 85;

            // Pre-fill phone modal
            openPhoneModal();
            document.getElementById('phoneBrand').value = brand;
            document.getElementById('phoneModel').value = model;
            document.getElementById('phoneCondition').value = condition === 'Detalles' ? 'Usado con detalles' : `Usado ${condition}`;
            document.getElementById('phoneBattery').value = battery;
            document.getElementById('phoneStorage').value = storage;
            document.getElementById('phoneCurrency').value = 'USD';
            document.getElementById('phonePrice').value = Math.round(activeTradeInValuationUsd * 1.25);
            updatePhonePriceLabel();
            showToast("Ficha de Smartphone pre-completada con la cotización.");
        }

        /* MODAL CRUD OPERATIONS FOR ACCESSORIES */
        function openProductModal() {
            if (!requireAdmin()) return;
            hideProductFeedback();
            document.getElementById('productForm').reset();
            document.getElementById('prodId').value = '';
            document.getElementById('productModalTitle').textContent = 'Cargar Nuevo Producto';
            renderCaseSubcategoryOptions();
            updateProductSubcategoryField();
            document.getElementById('productModal').classList.remove('hidden');
        }

        function closeProductModal() {
            hideProductFeedback();
            document.getElementById('productModal').classList.add('hidden');
        }

        function autoCalcCashPrice() {
            const listPrice = parseFloat(document.getElementById('prodPrice').value) || 0;
            document.getElementById('prodCashPrice').value = listPrice;
        }

        async function saveProduct(e) {
            e.preventDefault();
            if (!requireAdmin()) return;
            const id = document.getElementById('prodId').value || `ACC-${Date.now().toString().slice(-4)}`;
            const title = document.getElementById('prodTitle').value;
            const category = document.getElementById('prodCategory').value;
            let subcategory = ['fundas', 'proteccion'].includes(category) ? document.getElementById('prodSubcategory').value : '';
            if (subcategory === 'otro') subcategory = saveCustomCaseSubcategory(document.getElementById('prodCustomSubcategory').value);
            const brand = document.getElementById('prodBrand').value;
            const stock = parseInt(document.getElementById('prodStock').value) || 0;
            const minStock = parseInt(document.getElementById('prodMinStock').value) || 3;
            const cost = parseFloat(document.getElementById('prodCost').value) || 0;
            const price = parseFloat(document.getElementById('prodPrice').value) || 0;
            const cashPrice = price;
            const image = document.getElementById('prodImage').value || 'https://placehold.co/400x400/1e293b/ffffff?text=BE+STORE';
            const barcode = document.getElementById('prodBarcode').value.trim();

            const existingIndex = PRODUCTS.findIndex(p => p.id === id);
            const status = stock === 0 ? 'Anulado' : (existingIndex > -1 ? PRODUCTS[existingIndex].status || 'Activo' : 'Activo');
            const productObj = { id, title, category, subcategory, brand, stock, minStock, cost, price, cashPrice, image, barcode, status };

            const isUpdate = existingIndex > -1;

            try {
                if (isUpdate) {
                    PRODUCTS[existingIndex] = productObj;
                } else {
                    PRODUCTS.push(productObj);
                }

                await saveLocalState();
                renderDashboard();
                renderAccTable();
                renderCaseSubcategoryOptions();
                updateAccessorySubcategoryFilter();
                document.getElementById('productForm').reset();
                document.getElementById('prodId').value = '';
                document.getElementById('productModalTitle').textContent = 'Cargar Nuevo Producto';
                showProductFeedback(isUpdate ? 'Producto actualizado exitosamente.' : 'Nuevo producto cargado al inventario.', true);
            } catch (error) {
                console.error('No se pudo guardar el producto:', error);
                showProductFeedback('No se pudo guardar el producto. Revisa los datos e intenta nuevamente.', false);
            }
        }

        function showProductFeedback(message, isSuccess) {
            const feedback = document.getElementById('productFeedback');
            const icon = document.getElementById('productFeedbackIcon');

            clearTimeout(productFeedbackTimer);
            icon.className = `mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full text-xl ${isSuccess ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`;
            icon.innerHTML = isSuccess ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
            document.getElementById('productFeedbackMessage').textContent = message;
            feedback.classList.remove('hidden');
            productFeedbackTimer = setTimeout(hideProductFeedback, 2200);
        }

        function hideProductFeedback() {
            clearTimeout(productFeedbackTimer);
            productFeedbackTimer = null;
            const feedback = document.getElementById('productFeedback');
            if (feedback) feedback.classList.add('hidden');
        }

        function editProduct(id) {
            const p = PRODUCTS.find(item => item.id === id);
            if (!p) return;

            document.getElementById('prodId').value = p.id;
            document.getElementById('prodTitle').value = p.title;
            document.getElementById('prodCategory').value = p.category;
            renderCaseSubcategoryOptions();
            document.getElementById('prodSubcategory').value = p.subcategory || '';
            updateProductSubcategoryField();
            document.getElementById('prodBrand').value = p.brand;
            document.getElementById('prodStock').value = p.stock;
            document.getElementById('prodMinStock').value = p.minStock;
            document.getElementById('prodCost').value = p.cost;
            document.getElementById('prodPrice').value = p.price;
            document.getElementById('prodCashPrice').value = p.cashPrice;
            document.getElementById('prodImage').value = p.image;
            document.getElementById('prodBarcode').value = p.barcode || '';

            document.getElementById('productModalTitle').textContent = 'Editar Producto';
            document.getElementById('productModal').classList.remove('hidden');
        }

        async function toggleProductStatus(id) {
            if (!requireAdmin()) return;
            const product = PRODUCTS.find(item => item.id === id);
            if (!product) return;
            if (product.status === 'Anulado') {
                if (product.stock <= 0) return showToast('Repone stock antes de reactivar el producto.');
                product.status = 'Activo';
            } else {
                product.status = 'Anulado';
            }
            await saveLocalState();
            renderDashboard();
            renderAccTable();
            showToast(product.status === 'Anulado' ? 'Producto anulado del catálogo.' : 'Producto reactivado en el catálogo.');
        }

        async function quickAddStock(id, amount) {
            if (!requireAdmin()) return;
            const p = PRODUCTS.find(item => item.id === id);
            if (p) {
                p.stock = Math.max(0, p.stock + amount);
                p.status = p.stock === 0 ? 'Anulado' : 'Activo';
                await saveLocalState();
                renderDashboard();
                renderAccTable();
                showToast(`Stock actualizado para ${p.title}`);
            }
        }

        /* MODAL CRUD OPERATIONS FOR PHONES */
        function openPhoneModal() {
            if (!requireAdmin()) return;
            document.getElementById('phoneForm').reset();
            document.getElementById('phoneId').value = '';
            document.getElementById('phoneModalTitle').textContent = 'Ingresar Unidad Smartphone';
            renderPhoneIssueOptions();
            updatePhoneIssuesField();
            document.getElementById('phoneModal').classList.remove('hidden');
        }

        function closePhoneModal() {
            document.getElementById('phoneModal').classList.add('hidden');
        }

        function updatePhonePriceLabel() {
            const currency = document.getElementById('phoneCurrency').value;
            document.getElementById('phonePriceLabel').textContent = `Precio Efectivo / Transf. (${currency}) *`;
            updatePhoneConvertedPrice();
        }

        function updatePhoneConvertedPrice() {
            const currency = document.getElementById('phoneCurrency').value;
            const enteredPrice = parseFloat(document.getElementById('phonePrice').value) || 0;
            const converted = currency === 'USD' ? enteredPrice * dailyDollarRate : enteredPrice;
            const output = document.getElementById('phoneConvertedPrice');
            output.value = converted > 0 ? `$${Math.round(converted).toLocaleString('es-AR')}` : '';
        }

        function validatePhoneImei() {
            const input = document.getElementById('phoneImei');
            const feedback = document.getElementById('phoneImeiFeedback');
            const imei = input.value.trim().toLowerCase();
            const currentId = document.getElementById('phoneId').value;
            const duplicate = PHONES.find(phone => phone.imei.trim().toLowerCase() === imei && phone.id !== currentId);

            input.classList.toggle('border-red-500', Boolean(duplicate));
            input.classList.toggle('border-emerald-500', Boolean(imei) && !duplicate);
            feedback.textContent = duplicate ? 'Este IMEI ya existe en el inventario o fue registrado previamente.' : imei ? 'IMEI disponible.' : '';
            feedback.className = `mt-1 text-[10px] font-semibold ${duplicate ? 'text-red-600' : 'text-emerald-600'}`;
            return !duplicate;
        }

        function getPhoneIssueName(issueId) {
            return PHONE_ISSUES.find(issue => issue.id === issueId)?.name || issueId;
        }

        function renderPhoneIssueOptions(selectedIssues = []) {
            const container = document.getElementById('phoneIssuesOptions');
            container.innerHTML = PHONE_ISSUES.map(issue => `
                <label class="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-[11px] text-slate-700">
                    <input type="checkbox" name="phoneIssues" value="${issue.id}" ${selectedIssues.includes(issue.id) ? 'checked' : ''} class="accent-amber-600">
                    <span>${issue.name}</span>
                </label>
            `).join('');
        }

        function updatePhoneIssuesField() {
            const isUsed = document.getElementById('phoneCondition').value.includes('Usado');
            document.getElementById('phoneIssuesField').classList.toggle('hidden', !isUsed);
        }

        async function addCustomPhoneIssue() {
            const input = document.getElementById('phoneCustomIssue');
            const name = input.value.trim();
            if (!name) return;
            const selectedIssues = [...document.querySelectorAll('input[name="phoneIssues"]:checked')].map(checkbox => checkbox.value);
            const existing = PHONE_ISSUES.find(issue => issue.name.toLowerCase() === name.toLowerCase());
            if (!existing) {
                const baseId = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'detalle-equipo';
                let id = baseId;
                let suffix = 2;
                while (PHONE_ISSUES.some(issue => issue.id === id)) id = `${baseId}-${suffix++}`;
                PHONE_ISSUES.push({ id, name });
                await saveLocalState();
                renderPhoneIssueOptions([...selectedIssues, id]);
            } else {
                renderPhoneIssueOptions([...selectedIssues, existing.id]);
            }
            input.value = '';
        }

        function savePhoneUnit(e) {
            e.preventDefault();
            if (!requireAdmin()) return;
            const id = document.getElementById('phoneId').value || `PH-${Date.now().toString().slice(-4)}`;
            const brand = document.getElementById('phoneBrand').value;
            const model = document.getElementById('phoneModel').value;
            const condition = document.getElementById('phoneCondition').value;
            const battery = parseInt(document.getElementById('phoneBattery').value) || 100;
            const storage = document.getElementById('phoneStorage').value;
            const color = document.getElementById('phoneColor').value;
            const imei = document.getElementById('phoneImei').value;
            const currency = document.getElementById('phoneCurrency').value;
            const enteredPrice = parseFloat(document.getElementById('phonePrice').value) || 0;
            if (currency === 'USD' && dailyDollarRate <= 0) {
                showToast('Carga primero la cotización del dólar para guardar un precio en USD.');
                return;
            }
            const priceUsd = currency === 'USD' ? enteredPrice : null;
            const price = currency === 'USD' ? Math.round(enteredPrice * dailyDollarRate) : enteredPrice;
            const status = document.getElementById('phoneStatus').value;
            const image = document.getElementById('phoneImage').value || 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&auto=format&fit=crop&q=80';
            const issues = condition.includes('Usado') ? [...document.querySelectorAll('input[name="phoneIssues"]:checked')].map(input => input.value) : [];

            if (!validatePhoneImei()) {
                showToast('No se puede guardar: el IMEI ya está registrado.');
                return;
            }

            const phoneObj = { id, brand, model, condition, battery, storage, color, imei, price, priceUsd, currency, status, image, issues };
            const existingIndex = PHONES.findIndex(p => p.id === id);

            if (existingIndex > -1) {
                PHONES[existingIndex] = phoneObj;
                showToast("Ficha de smartphone actualizada.");
            } else {
                PHONES.push(phoneObj);
                showToast("Smartphone registrado en el stock.");
            }

            saveLocalState();
            renderDashboard();
            renderPhonesTable();
            closePhoneModal();
        }

        function editPhone(id) {
            if (!requireAdmin()) return;
            const ph = PHONES.find(item => item.id === id);
            if (!ph) return;

            document.getElementById('phoneId').value = ph.id;
            document.getElementById('phoneBrand').value = ph.brand;
            document.getElementById('phoneModel').value = ph.model;
            document.getElementById('phoneCondition').value = ph.condition;
            renderPhoneIssueOptions(ph.issues || []);
            updatePhoneIssuesField();
            document.getElementById('phoneBattery').value = ph.battery;
            document.getElementById('phoneStorage').value = ph.storage;
            document.getElementById('phoneColor').value = ph.color;
            document.getElementById('phoneImei').value = ph.imei;
            document.getElementById('phoneCurrency').value = ph.currency || 'ARS';
            document.getElementById('phonePrice').value = ph.currency === 'USD' ? ph.priceUsd : ph.price;
            updatePhonePriceLabel();
            updatePhoneConvertedPrice();
            document.getElementById('phoneStatus').value = ph.status;
            document.getElementById('phoneImage').value = ph.image;

            document.getElementById('phoneModalTitle').textContent = 'Editar Unidad Smartphone';
            document.getElementById('phoneModal').classList.remove('hidden');
        }

        /* FIRESTORE + LOCAL FALLBACK PERSISTENCE */
        function sanitizeForFirestore(value) {
            if (Array.isArray(value)) return value.map(sanitizeForFirestore);
            if (value && typeof value === 'object') {
                return Object.fromEntries(Object.entries(value)
                    .filter(([, entry]) => entry !== undefined)
                    .map(([key, entry]) => [key, sanitizeForFirestore(entry)]));
            }
            return value;
        }

        async function saveLocalState() {
            localStorage.setItem('bestore_internal_products', JSON.stringify(PRODUCTS));
            localStorage.setItem('bestore_internal_phones', JSON.stringify(PHONES));
            localStorage.setItem('bestore_internal_sales', JSON.stringify(SALES));
            localStorage.setItem('bestore_internal_clients', JSON.stringify(CLIENTS));
            localStorage.setItem('bestore_internal_cash_register', JSON.stringify(cashRegister));
            localStorage.setItem('bestore_internal_dollar_rate', String(dailyDollarRate));
            localStorage.setItem('bestore_internal_case_subcategories', JSON.stringify(CASE_SUBCATEGORIES));
            localStorage.setItem('bestore_internal_phone_issues', JSON.stringify(PHONE_ISSUES));

            if (!firebase.auth().currentUser) return;

            try {
                await appStateRef.set(sanitizeForFirestore({
                    version: DATA_VERSION,
                    products: PRODUCTS,
                    phones: PHONES,
                    sales: SALES,
                    clients: CLIENTS,
                    categories: CATEGORIES,
                    caseSubcategories: CASE_SUBCATEGORIES,
                    phoneIssues: PHONE_ISSUES,
                    cashRegister,
                    dailyDollarRate,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                }));
            } catch (error) {
                console.error('No se pudo guardar el estado en Firestore:', error);
            }
        }

        async function loadLocalState() {
            const p = localStorage.getItem('bestore_internal_products');
            const ph = localStorage.getItem('bestore_internal_phones');
            const s = localStorage.getItem('bestore_internal_sales');

            if (p) try { PRODUCTS = JSON.parse(p); } catch(e){}
            if (ph) try { PHONES = JSON.parse(ph); } catch(e){}
            if (s) try { SALES = JSON.parse(s); } catch(e){}
            const c = localStorage.getItem('bestore_internal_clients');
            if (c) try { CLIENTS = JSON.parse(c); } catch(e){}
            const cash = localStorage.getItem('bestore_internal_cash_register');
            if (cash) try { cashRegister = JSON.parse(cash); } catch(e){}
            const dollar = localStorage.getItem('bestore_internal_dollar_rate');
            if (dollar) dailyDollarRate = parseFloat(dollar) || 0;
            const caseSubcategories = localStorage.getItem('bestore_internal_case_subcategories');
            if (caseSubcategories) try { CASE_SUBCATEGORIES = JSON.parse(caseSubcategories); } catch(e){}
            const phoneIssues = localStorage.getItem('bestore_internal_phone_issues');
            if (phoneIssues) try { PHONE_ISSUES = JSON.parse(phoneIssues); } catch(e){}
            normalizeCaseSubcategories();

            try {
                const snapshot = await appStateRef.get();

                if (snapshot.exists && snapshot.data().version === DATA_VERSION) {
                    const remoteState = snapshot.data();
                    PRODUCTS = remoteState.products || PRODUCTS;
                    PHONES = remoteState.phones || PHONES;
                    SALES = remoteState.sales || SALES;
                    CLIENTS = remoteState.clients || CLIENTS;
                    CATEGORIES = remoteState.categories || CATEGORIES;
                    CASE_SUBCATEGORIES = remoteState.caseSubcategories || CASE_SUBCATEGORIES;
                    PHONE_ISSUES = remoteState.phoneIssues || PHONE_ISSUES;
                    normalizeCaseSubcategories();
                    cashRegister = remoteState.cashRegister || cashRegister;
                    dailyDollarRate = remoteState.dailyDollarRate || dailyDollarRate;
                    localStorage.setItem('bestore_internal_products', JSON.stringify(PRODUCTS));
                    localStorage.setItem('bestore_internal_phones', JSON.stringify(PHONES));
                    localStorage.setItem('bestore_internal_sales', JSON.stringify(SALES));
                    localStorage.setItem('bestore_internal_clients', JSON.stringify(CLIENTS));
                    localStorage.setItem('bestore_internal_cash_register', JSON.stringify(cashRegister));
                    localStorage.setItem('bestore_internal_dollar_rate', String(dailyDollarRate));
                    localStorage.setItem('bestore_internal_case_subcategories', JSON.stringify(CASE_SUBCATEGORIES));
                    localStorage.setItem('bestore_internal_phone_issues', JSON.stringify(PHONE_ISSUES));
                } else {
                    PRODUCTS = [];
                    PHONES = [];
                    SALES = [];
                    CLIENTS = [];
                    await saveLocalState();
                }
            } catch (error) {
                console.error('Firestore no disponible, se usara almacenamiento local:', error);
            }
        }

        /* TOAST NOTIFICATION HELPERS */
        function showToast(message) {
            const container = document.getElementById('toastContainer');
            const toast = document.createElement('div');
            toast.className = 'bg-slate-900 border border-slate-700 text-white text-xs font-semibold px-4 py-3 rounded-2xl shadow-xl flex items-center gap-2 transform translate-y-4 opacity-0 transition duration-300 pointer-events-auto';
            toast.innerHTML = `<i class="fa-solid fa-circle-check text-emerald-400"></i> ${message}`;
            
            container.appendChild(toast);

            setTimeout(() => {
                toast.classList.remove('translate-y-4', 'opacity-0');
            }, 10);

            setTimeout(() => {
                toast.classList.add('opacity-0', 'translate-y-2');
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }
