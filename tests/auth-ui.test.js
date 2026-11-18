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
