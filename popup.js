const SINOE_URL =
  'https://casillas.pj.gob.pe/sinoe/pages/casillas/notificaciones/notificacion-bandeja.xhtml';
const PANEL_URL = 'https://document.okumet.com/app/';

const viewLogin = document.getElementById('view-login');
const viewWorkspace = document.getElementById('view-workspace');
const loginForm = document.getElementById('login-form');

const profileBtn = document.getElementById('profile-btn');
const profileMenu = document.getElementById('profile-menu');
const goPanelBtn = document.getElementById('go-panel');
const logoutBtn = document.getElementById('logout');

const statusBanner = document.getElementById('status-banner');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

/* ---------- Navegación entre login y workspace (solo visual/demo) ---------- */

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  viewLogin.classList.add('hidden');
  viewWorkspace.classList.remove('hidden');
  renderConnectionStatus();
});

logoutBtn.addEventListener('click', () => {
  profileMenu.classList.add('hidden');
  viewWorkspace.classList.add('hidden');
  viewLogin.classList.remove('hidden');
  loginForm.reset();
});

/* ---------- Menú de perfil ---------- */

profileBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !profileMenu.classList.contains('hidden');
  profileMenu.classList.toggle('hidden', isOpen);
  profileBtn.setAttribute('aria-expanded', String(!isOpen));
});

document.addEventListener('click', () => {
  profileMenu.classList.add('hidden');
  profileBtn.setAttribute('aria-expanded', 'false');
});

goPanelBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: PANEL_URL });
  profileMenu.classList.add('hidden');
});

/* ---------- Tabs: Documentos / Notificaciones ---------- */

tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabButtons.forEach((b) => b.classList.remove('active'));
    tabPanels.forEach((p) => p.classList.remove('active'));

    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
  });
});

/* ---------- Detección de la pestaña activa (solo UI, sin lógica de negocio) ---------- */

async function renderConnectionStatus() {
  let isOnSinoe = false;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    isOnSinoe = Boolean(tab && tab.url && tab.url.startsWith(SINOE_URL));
  } catch (err) {
    isOnSinoe = false;
  }

  statusBanner.innerHTML = '';
  statusBanner.classList.remove('is-waiting', 'is-connected');

  if (isOnSinoe) {
    statusBanner.classList.add('is-connected');
    statusBanner.innerHTML = `
      <div class="status-row">
        <span class="status-dot"></span>
        <span class="status-title">Conectado a tu casilla SINOE</span>
      </div>
      <p class="status-subtitle">Detectamos tu bandeja de notificaciones de SINOE abierta en esta pestaña.</p>
      <div class="consent-box">
        <label class="consent-check">
          <input type="checkbox" id="sinoe-consent" />
          Acepto que Okumet obtenga los documentos de mi casilla SINOE.
        </label>
        <button id="confirm-consent" class="btn btn-confirm" disabled>Confirmar acceso</button>
      </div>
    `;

    const consentCheck = document.getElementById('sinoe-consent');
    const confirmBtn = document.getElementById('confirm-consent');
    consentCheck.addEventListener('change', () => {
      confirmBtn.disabled = !consentCheck.checked;
    });
  } else {
    statusBanner.classList.add('is-waiting');
    statusBanner.innerHTML = `
      <div class="status-row">
        <span class="status-dot"></span>
        <span class="status-title">Esperando conexión con SINOE</span>
      </div>
      <p class="status-subtitle">Abre la bandeja de notificaciones de SINOE en una pestaña para habilitar el acceso.</p>
    `;
  }
}
