tailwind.config = {
    darkMode: 'class',
    theme: {
        extend: {
            colors: {
                bonewhite: {
                    50: '#fcfbf9',
                    100: '#f7f6f2',
                    200: '#eeebe3',
                    300: '#e2ddcf',
                    border: '#e5e2d8'
                },
                brand: {
                    50: '#eef2ff',
                    100: '#e0e7ff',
                    500: '#4f46e5',
                    600: '#4338ca',
                    700: '#3730a3',
                    accent: '#0284c7',
                    emerald: '#059669',
                    amber: '#d97706'
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
const CARD_SURCHARGE = 0.10;
const DATA_VERSION = 2;

/* Empty initial state: inventory is entered manually by an administrator. */
        let PRODUCTS = [];
        let PHONES = [];
        let SALES = [];
        let CLIENTS = [];

        let posState = {
            ticket: [],
            paymentMethod: 'transfer', // 'transfer' or 'card'
            selectedCategory: 'ALL'
        };

        let activeTradeInValuation = 0;
        let categoryChartInstance = null;
        let lastCreatedSale = null;

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
            let totalValue = accValue + phoneValue;

            let inStockPhones = PHONES.filter(p => p.status === 'En Stock');
            let newPhones = inStockPhones.filter(p => p.condition === 'Nuevo').length;
            let usedPhones = inStockPhones.filter(p => p.condition.includes('Usado')).length;

            let lowStockAcc = PRODUCTS.filter(p => p.stock <= p.minStock);

            document.getElementById('dashTotalValue').textContent = `$${totalValue.toLocaleString('es-AR')}`;
            document.getElementById('dashPhonesCount').textContent = `${inStockPhones.length} unidades`;
            document.getElementById('dashPhonesSub').textContent = `${newPhones} Nuevos / ${usedPhones} Usados`;
            document.getElementById('dashLowStockCount').textContent = `${lowStockAcc.length} ítems`;

            // Today's Sales
            const todayStr = new Date().toLocaleDateString('es-AR');
            const salesToday = SALES.filter(s => s.date.includes(todayStr));
            const revToday = salesToday.reduce((sum, s) => sum + s.total, 0);

            document.getElementById('dashSalesToday').textContent = `${salesToday.length} oper.`;
            document.getElementById('dashRevenueToday').textContent = `$${revToday.toLocaleString('es-AR')} facturado`;

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

            renderCategoryChart();
        }

        function normalizeCommercialData() {
            PRODUCTS.forEach(product => { product.cashPrice = product.price; });
        }

        function renderCategoryChart() {
            const ctx = document.getElementById('categoryChart').getContext('2d');
            
            const catMap = {
                'fundas': 0,
                'proteccion': 0,
                'cargadores': 0,
                'audio': 0,
                'celulares': PHONES.filter(p => p.status === 'En Stock').length
            };

            PRODUCTS.forEach(p => {
                if (catMap[p.category] !== undefined) {
                    catMap[p.category] += p.stock;
                }
            });

            if (categoryChartInstance) {
                categoryChartInstance.destroy();
            }

            categoryChartInstance = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: ['Fundas', 'Protección', 'Cargadores', 'Audio', 'Celulares'],
                    datasets: [{
                        label: 'Unidades en Stock',
                        data: [catMap.fundas, catMap.proteccion, catMap.cargadores, catMap.audio, catMap.celulares],
                        backgroundColor: ['#6366f1', '#38bdf8', '#059669', '#a855f7', '#d97706'],
                        borderRadius: 8
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, grid: { color: '#f1f5f9' } },
                        x: { grid: { display: false } }
                    }
                }
            });
        }

        /* ACCESSORIES TABLE LOGIC */
        function renderAccTable() {
            const body = document.getElementById('accTableBody');
            const search = document.getElementById('accSearchInput').value.toLowerCase();
            const cat = document.getElementById('accCategoryFilter').value;

            const filtered = PRODUCTS.filter(p => {
                const matchesCat = cat === 'ALL' || p.category === cat;
                const matchesSearch = p.title.toLowerCase().includes(search) || p.brand.toLowerCase().includes(search) || p.id.toLowerCase().includes(search);
                return matchesCat && matchesSearch;
            });

            if (filtered.length === 0) {
                body.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400">No se encontraron productos en el inventario.</td></tr>`;
                return;
            }

            body.innerHTML = filtered.map(item => `
                <tr class="hover:bg-slate-50 transition ${item.status === 'Vendido' ? 'opacity-50 bg-slate-100' : ''}">
                    <td class="p-3.5">
                        <div class="flex items-center gap-3">
                            <img src="${item.image}" class="w-9 h-9 rounded-lg object-cover bg-slate-100 border border-slate-200">
                            <div>
                                <span class="font-bold text-slate-900 block">${item.title}</span>
                                <span class="text-[10px] text-slate-400 font-mono-num">SKU: ${item.id} | ${item.brand}</span>
                            </div>
                        </div>
                    </td>
                    <td class="p-3.5 capitalize font-medium text-slate-600">${item.category}</td>
                    <td class="p-3.5">
                        <div class="flex items-center gap-2">
                            <span class="font-bold font-mono-num text-xs ${item.stock <= item.minStock ? 'text-amber-600 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200' : 'text-slate-800'}">
                                ${item.stock} un.
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
                            <button onclick="deleteProduct('${item.id}')" class="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-xs" title="Eliminar">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    </td>
                </tr>
            `).join('');
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
            renderPOSCategories();
            renderPOSItemsGrid();
        }

        function filterPOSItems() {
            renderPOSItemsGrid();
        }

        function renderPOSItemsGrid() {
            const grid = document.getElementById('posItemsGrid');
            const search = document.getElementById('posSearchInput').value.toLowerCase();
            const cat = posState.selectedCategory;

            let itemsList = [];

            if (cat !== 'celulares') {
                PRODUCTS.forEach(p => {
                    if ((cat === 'ALL' || p.category === cat) && p.stock > 0) {
                        if (p.title.toLowerCase().includes(search) || p.brand.toLowerCase().includes(search) || p.id.toLowerCase().includes(search)) {
                            itemsList.push({ ...p, type: 'acc' });
                        }
                    }
                });
            }

            if (cat === 'ALL' || cat === 'celulares') {
                PHONES.forEach(ph => {
                    if (ph.status === 'En Stock') {
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
                if (foundItem.type === 'phone') {
                    showToast("Este celular único ya está cargado en el ticket.");
                    return;
                }
                if (posState.ticket[existingIndex].quantity < foundItem.stock) {
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
                    type: foundItem.type,
                    imei: foundItem.imei || null,
                    maxStock: foundItem.type === 'acc' ? foundItem.stock : 1
                });
            }

            renderPOSTicket();
            showToast(`"${foundItem.title.substring(0, 20)}..." agregado a la caja`);
        }

        function addPhoneToPOS(phoneId) {
            switchTab('pos');
            addPOSItem(phoneId, 'phone');
        }

        function updatePOSTicketQty(id, delta) {
            const index = posState.ticket.findIndex(t => t.id === id);
            if (index > -1) {
                posState.ticket[index].quantity += delta;
                if (posState.ticket[index].quantity <= 0) {
                    posState.ticket.splice(index, 1);
                }
            }
            renderPOSTicket();
        }

        function clearPOSTicket() {
            posState.ticket = [];
            document.getElementById('posCanjeDeduction').value = '';
            renderPOSTicket();
        }

        function setPOSPaymentMethod(method) {
            posState.paymentMethod = method;
            const btnTransf = document.getElementById('posPayTransfer');
            const btnCard = document.getElementById('posPayCard');

            if (method === 'transfer') {
                document.getElementById('cardPlanSelect').classList.add('hidden');
                btnTransf.className = 'py-2 px-2 rounded-xl bg-emerald-50 border border-emerald-500 text-emerald-700 font-bold text-center transition';
                btnCard.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
            } else {
                document.getElementById('cardPlanSelect').classList.remove('hidden');
                btnCard.className = 'py-2 px-2 rounded-xl bg-brand-50 border border-brand-500 text-brand-700 font-bold text-center transition';
                btnTransf.className = 'py-2 px-2 rounded-xl bg-slate-100 text-slate-600 border border-transparent font-medium text-center transition';
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
            const plan = document.getElementById('cardPlanSelect').value;
            const surchargeRate = posState.paymentMethod === 'card' && plan === 'card-20' ? 0.20 : (posState.paymentMethod === 'card' && plan === 'card-single' ? CARD_SURCHARGE : 0);
            const surcharge = Math.round(subtotal * surchargeRate);
            document.getElementById('posSurchargeRow').classList.toggle('hidden', surcharge === 0);
            document.getElementById('posSurcharge').textContent = `+$${surcharge.toLocaleString('es-AR')}`;
            let finalTotal = Math.max(0, subtotal + surcharge - canjeVal);

            document.getElementById('posSubtotal').textContent = `$${subtotal.toLocaleString('es-AR')}`;
            document.getElementById('posTotal').textContent = `$${finalTotal.toLocaleString('es-AR')}`;
        }

        function processPOSCheckout() {
            if (posState.ticket.length === 0) {
                showToast("Cargá al menos un producto al ticket antes de cobrar.");
                return;
            }

            const customerName = document.getElementById('posCustomerName').value.trim() || 'Cliente Mostrador';
            const customerPhone = document.getElementById('posCustomerPhone').value.trim() || '-';
            const canjeVal = parseFloat(document.getElementById('posCanjeDeduction').value) || 0;

            let subtotal = posState.ticket.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const plan = document.getElementById('cardPlanSelect').value;
            const surchargeRate = posState.paymentMethod === 'card' && plan === 'card-20' ? 0.20 : (posState.paymentMethod === 'card' && plan === 'card-single' ? CARD_SURCHARGE : 0);
            const surcharge = Math.round(subtotal * surchargeRate);
            let total = Math.max(0, subtotal + surcharge - canjeVal);

            // Deduct Stock
            posState.ticket.forEach(tItem => {
                if (tItem.type === 'acc') {
                    const acc = PRODUCTS.find(p => p.id === tItem.id);
                    if (acc) acc.stock = Math.max(0, acc.stock - tItem.quantity);
                } else if (tItem.type === 'phone') {
                    const phone = PHONES.find(p => p.id === tItem.id);
                    if (phone) phone.status = 'Vendido';
                }
            });

            // Record Sale Transaction
            const saleRecord = {
                id: `TK-${Date.now().toString().slice(-5)}`,
                date: `${new Date().toLocaleDateString('es-AR')} ${new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
                customerName: customerName,
                customerPhone: customerPhone,
                items: [...posState.ticket],
                paymentMethod: posState.paymentMethod === 'transfer' ? 'Efectivo/Transferencia' : 'Tarjeta/Cuotas',
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
            if (client) client.purchaseCount = (client.purchaseCount || 0) + 1;
            lastCreatedSale = saleRecord;
            saveLocalState();

            // Refresh UI
            renderDashboard();
            renderAccTable();
            renderPhonesTable();
            renderSalesTable();
            renderPOSItemsGrid();

            openReceiptModal(saleRecord);
            clearPOSTicket();
            showToast("¡Venta finalizada y registrada correctamente!");
        }

        /* SALES HISTORY TABLE */
        function renderSalesTable() {
            const body = document.getElementById('salesTableBody');

            if (SALES.length === 0) {
                body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-slate-400">Aún no hay ventas registradas en el sistema.</td></tr>`;
                return;
            }

            body.innerHTML = SALES.map(sale => `
                <tr class="hover:bg-slate-50 transition ${sale.status === 'Anulada' ? 'opacity-50 bg-red-50' : ''}">
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
                    <td class="p-3.5 font-bold font-mono-num ${sale.status === 'Anulada' ? 'text-red-600 line-through' : 'text-emerald-600'}">$${sale.total.toLocaleString('es-AR')} ${sale.status === 'Anulada' ? '<span class="block text-[10px] no-underline">ANULADA</span>' : ''}</td>
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
            await saveLocalState();
            renderSalesTable();
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
            if (sale) openReceiptModal(sale);
        }

        function openReceiptModal(sale) {
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
            document.getElementById('receiptModal').classList.remove('hidden');
        }

        function closeReceiptModal() {
            document.getElementById('receiptModal').classList.add('hidden');
        }

        function sendReceiptViaWhatsApp() {
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
        }

        /* PLAN CANJE ENGINE */
        const CANJE_RATES = {
            'Apple': [
                { model: 'iPhone 14 Pro Max', base: 850000 },
                { model: 'iPhone 14 Pro', base: 750000 },
                { model: 'iPhone 14', base: 580000 },
                { model: 'iPhone 13 Pro Max', base: 620000 },
                { model: 'iPhone 13', base: 480000 },
                { model: 'iPhone 12 Pro', base: 410000 },
                { model: 'iPhone 12', base: 340000 },
                { model: 'iPhone 11', base: 260000 }
            ],
            'Samsung': [
                { model: 'Galaxy S23 Ultra', base: 720000 },
                { model: 'Galaxy S22 Ultra', base: 510000 },
                { model: 'Galaxy S21 FE', base: 280000 }
            ]
        };

        function updateCanjeModelOptions() {
            const brand = document.getElementById('canjeBrandSelect').value;
            const modelSelect = document.getElementById('canjeModelSelect');
            modelSelect.innerHTML = '';

            if (CANJE_RATES[brand]) {
                CANJE_RATES[brand].forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.model;
                    opt.textContent = m.model;
                    modelSelect.appendChild(opt);
                });
            }
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
            body.innerHTML = CLIENTS.map(client => `<tr class="border-b border-slate-100"><td class="p-3 font-semibold">${client.name}</td><td class="p-3">${client.phone || '-'}${client.email ? ` · ${client.email}` : ''}</td><td class="p-3">${client.purchaseCount || 0}</td></tr>`).join('') || '<tr><td colspan="3" class="p-6 text-center text-slate-400">No hay clientes registrados.</td></tr>';
        }

        async function saveClient(event) {
            event.preventDefault();
            const client = { id: `CLI-${Date.now()}`, name: document.getElementById('clientName').value.trim(), phone: document.getElementById('clientPhone').value.trim(), email: document.getElementById('clientEmail').value.trim(), purchaseCount: 0 };
            CLIENTS.push(client);
            await saveLocalState();
            event.target.reset();
            renderClients();
            showToast('Cliente registrado correctamente.');
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
            const brand = document.getElementById('canjeBrandSelect').value;
            const model = document.getElementById('canjeModelSelect').value;
            const storage = document.getElementById('canjeStorageSelect').value;
            const condition = document.getElementById('canjeConditionSelect').value;
            const battery = parseInt(document.getElementById('canjeBatteryInput').value) || 85;

            const list = CANJE_RATES[brand] || [];
            const item = list.find(m => m.model === model);
            
            let baseVal = item ? item.base : 200000;

            if (storage === '256GB') baseVal *= 1.08;
            if (storage === '512GB') baseVal *= 1.15;

            if (condition === 'Bueno') baseVal *= 0.90;
            if (condition === 'Detalles') baseVal *= 0.80;

            if (battery < 80) baseVal *= 0.88;
            else if (battery < 85) baseVal *= 0.94;

            activeTradeInValuation = Math.round(baseVal / 1000) * 1000;

            document.getElementById('canjeValuationResult').textContent = `$${activeTradeInValuation.toLocaleString('es-AR')}`;
            document.getElementById('canjeResultCard').classList.remove('hidden');
        }

        function applyCanjeToPOS() {
            if (activeTradeInValuation <= 0) return;
            switchTab('pos');
            document.getElementById('posCanjeDeduction').value = activeTradeInValuation;
            calculatePOSTotals();
            showToast(`¡$${activeTradeInValuation.toLocaleString('es-AR')} cargados como descuento de Canje en Caja!`);
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
            document.getElementById('phoneCondition').value = `Usado ${condition}`;
            document.getElementById('phoneBattery').value = battery;
            document.getElementById('phoneStorage').value = storage;
            document.getElementById('phonePrice').value = Math.round(activeTradeInValuation * 1.25);
            showToast("Ficha de Smartphone pre-completada con la cotización.");
        }

        /* MODAL CRUD OPERATIONS FOR ACCESSORIES */
        function openProductModal() {
            if (!requireAdmin()) return;
            document.getElementById('productForm').reset();
            document.getElementById('prodId').value = '';
            document.getElementById('productModalTitle').textContent = 'Cargar Nuevo Producto';
            document.getElementById('productModal').classList.remove('hidden');
        }

        function closeProductModal() {
            document.getElementById('productModal').classList.add('hidden');
        }

        function autoCalcCashPrice() {
            const listPrice = parseFloat(document.getElementById('prodPrice').value) || 0;
            document.getElementById('prodCashPrice').value = listPrice;
        }

        function saveProduct(e) {
            e.preventDefault();
            if (!requireAdmin()) return;
            const id = document.getElementById('prodId').value || `ACC-${Date.now().toString().slice(-4)}`;
            const title = document.getElementById('prodTitle').value;
            const category = document.getElementById('prodCategory').value;
            const brand = document.getElementById('prodBrand').value;
            const stock = parseInt(document.getElementById('prodStock').value) || 0;
            const minStock = parseInt(document.getElementById('prodMinStock').value) || 3;
            const cost = parseFloat(document.getElementById('prodCost').value) || 0;
            const price = parseFloat(document.getElementById('prodPrice').value) || 0;
            const cashPrice = price;
            const image = document.getElementById('prodImage').value || 'https://placehold.co/400x400/1e293b/ffffff?text=BE+STORE';

            const existingIndex = PRODUCTS.findIndex(p => p.id === id);
            const productObj = { id, title, category, brand, stock, minStock, cost, price, cashPrice, image };

            if (existingIndex > -1) {
                PRODUCTS[existingIndex] = productObj;
                showToast("Producto actualizado exitosamente.");
            } else {
                PRODUCTS.push(productObj);
                showToast("Nuevo producto cargado al inventario.");
            }

            saveLocalState();
            renderDashboard();
            renderAccTable();
            closeProductModal();
        }

        function editProduct(id) {
            const p = PRODUCTS.find(item => item.id === id);
            if (!p) return;

            document.getElementById('prodId').value = p.id;
            document.getElementById('prodTitle').value = p.title;
            document.getElementById('prodCategory').value = p.category;
            document.getElementById('prodBrand').value = p.brand;
            document.getElementById('prodStock').value = p.stock;
            document.getElementById('prodMinStock').value = p.minStock;
            document.getElementById('prodCost').value = p.cost;
            document.getElementById('prodPrice').value = p.price;
            document.getElementById('prodCashPrice').value = p.cashPrice;
            document.getElementById('prodImage').value = p.image;

            document.getElementById('productModalTitle').textContent = 'Editar Producto';
            document.getElementById('productModal').classList.remove('hidden');
        }

        function deleteProduct(id) {
            if (!requireAdmin()) return;
            PRODUCTS = PRODUCTS.filter(p => p.id !== id);
            saveLocalState();
            renderDashboard();
            renderAccTable();
            showToast("Producto eliminado del inventario.");
        }

        function quickAddStock(id, amount) {
            if (!requireAdmin()) return;
            const p = PRODUCTS.find(item => item.id === id);
            if (p) {
                p.stock = Math.max(0, p.stock + amount);
                saveLocalState();
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
            document.getElementById('phoneModal').classList.remove('hidden');
        }

        function closePhoneModal() {
            document.getElementById('phoneModal').classList.add('hidden');
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
            const price = parseFloat(document.getElementById('phonePrice').value) || 0;
            const status = document.getElementById('phoneStatus').value;
            const image = document.getElementById('phoneImage').value || 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&auto=format&fit=crop&q=80';

            const phoneObj = { id, brand, model, condition, battery, storage, color, imei, price, status, image };
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
            document.getElementById('phoneBattery').value = ph.battery;
            document.getElementById('phoneStorage').value = ph.storage;
            document.getElementById('phoneColor').value = ph.color;
            document.getElementById('phoneImei').value = ph.imei;
            document.getElementById('phonePrice').value = ph.price;
            document.getElementById('phoneStatus').value = ph.status;
            document.getElementById('phoneImage').value = ph.image;

            document.getElementById('phoneModalTitle').textContent = 'Editar Unidad Smartphone';
            document.getElementById('phoneModal').classList.remove('hidden');
        }

        /* FIRESTORE + LOCAL FALLBACK PERSISTENCE */
        async function saveLocalState() {
            localStorage.setItem('bestore_internal_products', JSON.stringify(PRODUCTS));
            localStorage.setItem('bestore_internal_phones', JSON.stringify(PHONES));
            localStorage.setItem('bestore_internal_sales', JSON.stringify(SALES));
            localStorage.setItem('bestore_internal_clients', JSON.stringify(CLIENTS));

            if (!firebase.auth().currentUser) return;

            try {
                await appStateRef.set({
                    version: DATA_VERSION,
                    products: PRODUCTS,
                    phones: PHONES,
                    sales: SALES,
                    clients: CLIENTS,
                    categories: CATEGORIES,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
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

            try {
                const snapshot = await appStateRef.get();

                if (snapshot.exists && snapshot.data().version === DATA_VERSION) {
                    const remoteState = snapshot.data();
                    PRODUCTS = remoteState.products || PRODUCTS;
                    PHONES = remoteState.phones || PHONES;
                    SALES = remoteState.sales || SALES;
                    CLIENTS = remoteState.clients || CLIENTS;
                    CATEGORIES = remoteState.categories || CATEGORIES;
                    localStorage.setItem('bestore_internal_products', JSON.stringify(PRODUCTS));
                    localStorage.setItem('bestore_internal_phones', JSON.stringify(PHONES));
                    localStorage.setItem('bestore_internal_sales', JSON.stringify(SALES));
                    localStorage.setItem('bestore_internal_clients', JSON.stringify(CLIENTS));
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
