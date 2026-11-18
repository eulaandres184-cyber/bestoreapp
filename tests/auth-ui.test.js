const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createApp() {
    function element() {
        const classes = new Set();
        return {
            value: '',
            textContent: '',
            disabled: false,
            attributes: {},
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                toggle(name, force) {
                    if (force === undefined ? !classes.has(name) : force) classes.add(name);
                    else classes.delete(name);
                    return classes.has(name);
                },
                contains(name) { return classes.has(name); }
            },
            setAttribute(name, value) { this.attributes[name] = value; },
            querySelector() {
                return { classList: this.classList };
            }
        };
    }

    const elements = new Map();
    const form = element();
    const context = {
        tailwind: {},
        window: {},
        console,
        firebase: {
            initializeApp() {},
            firestore: () => ({ collection: () => ({ doc: () => ({}) }) }),
            auth: () => ({ signInWithEmailAndPassword: async () => ({ user: {} }) })
        },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            }
        }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    const controls = ['loginNick', 'loginPassword', 'toggleLoginPassword', 'loginSubmitButton']
        .map(id => context.document.getElementById(id));
    form.querySelectorAll = () => controls;
    elements.set('loginForm', form);
    return { context, elements, controls };
}

test('el formulario de cambio de clave permite verla y volver a ocultarla', () => {
    const { context } = createApp();
    const input = context.document.getElementById('passwordNewValue');
    input.type = 'password';

    context.togglePasswordVisibility('passwordNewValue', 'togglePasswordNewValue');
    assert.equal(input.type, 'text');
    assert.equal(context.document.getElementById('togglePasswordNewValue').attributes['aria-label'], 'Ocultar contraseña');

    context.togglePasswordVisibility('passwordNewValue', 'togglePasswordNewValue');
    assert.equal(input.type, 'password');
    assert.equal(context.document.getElementById('togglePasswordNewValue').attributes['aria-label'], 'Mostrar contraseña');
});

test('el acceso atenúa y bloquea usuario y clave mientras inicia sesión', async () => {
    const { context, elements, controls } = createApp();
    let resolveSignIn;
    context.firebase.auth = () => ({
        signInWithEmailAndPassword: () => new Promise(resolve => { resolveSignIn = resolve; })
    });
    context.finishLogin = async () => {};
    context.showAuthMessage = () => {};
    const login = context.loginUser({ preventDefault() {} });

    assert.ok(controls.every(control => control.disabled));
    assert.equal(elements.get('loginCredentials').classList.contains('opacity-50'), true);
    assert.equal(elements.get('loginSubmitLabel').textContent, 'Ingresando…');
    assert.equal(elements.get('loginLoadingSpinner').classList.contains('hidden'), false);
    assert.equal(elements.get('loginSubmitButton').attributes['aria-busy'], 'true');

    resolveSignIn({ user: {} });
    await login;

    assert.ok(controls.every(control => !control.disabled));
    assert.equal(elements.get('loginCredentials').classList.contains('opacity-50'), false);
    assert.equal(elements.get('loginSubmitLabel').textContent, 'Ingresar');
    assert.equal(elements.get('loginLoadingSpinner').classList.contains('hidden'), true);
    assert.equal(elements.get('loginSubmitButton').attributes['aria-busy'], 'false');
});

test('los controles para mostrar clave están presentes en los formularios correspondientes', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    assert.match(html, /id="togglePasswordNewValue" onclick="togglePasswordVisibility\('passwordNewValue', 'togglePasswordNewValue'\)"/);
    assert.match(html, /id="loginLoadingSpinner"[^>]*fa-spinner fa-spin/);
    assert.match(html, /id="loginCredentials" class="space-y-3 transition-opacity"/);
});

test('el cambio de clave informa éxito y evita envíos simultáneos', async () => {
    const { context } = createApp();
    context.requireAdmin = () => true;
    context.firebase.auth = () => ({ currentUser: { uid: '67V2bdleU2bZaazTtoZUvafJTsL2' } });
    context.document.getElementById('passwordUserId').value = 'admin';
    context.document.getElementById('passwordNewValue').value = 'clave123';
    context.document.getElementById('passwordNewValue').type = 'password';
    let resolveCall;
    let count = 0;
    context.callSecureFunction = () => { count++; return new Promise(resolve => { resolveCall = resolve; }); };
    const shown = [];
    context.showPasswordResult = (title, message) => shown.push({ title, message });
    const first = context.changeUserPassword({ preventDefault() {} });
    await context.changeUserPassword({ preventDefault() {} });
    assert.equal(count, 1);
    assert.equal(context.document.getElementById('changePasswordSubmit').disabled, true);
    resolveCall({ uid: 'admin', operationId: 'operation' });
    await first;
    assert.equal(shown[0].title, 'Clave actualizada');
    assert.match(shown[0].message, /se aplicó correctamente/);
    assert.equal(context.document.getElementById('passwordNewValue').value, '');
    assert.equal(context.document.getElementById('changePasswordSubmit').disabled, false);
});

test('el error internal genérico muestra una explicación y conserva el formulario', async () => {
    const { context } = createApp();
    context.requireAdmin = () => true;
    context.firebase.auth = () => ({ currentUser: { uid: '67V2bdleU2bZaazTtoZUvafJTsL2' } });
    context.document.getElementById('passwordUserId').value = 'seller';
    context.document.getElementById('passwordNewValue').value = 'clave123';
    context.console = { error() {} };
    context.callSecureFunction = async () => { throw Object.assign(new Error('internal'), { code: 'functions/internal' }); };
    const shown = [];
    context.showPasswordResult = (title, message) => shown.push({ title, message });
    await context.changeUserPassword({ preventDefault() {} });
    assert.match(shown[0].title, /No se pudo confirmar/);
    assert.match(shown[0].message, /Comprueba el acceso con la nueva clave/);
    assert.equal(context.document.getElementById('passwordNewValue').value, 'clave123');
});
