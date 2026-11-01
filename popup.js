const PANEL_URL = 'https://document.okumet.com/app/';

// ---------- Clasificación segura de la pestaña activa frente a SINOE ----------
// Primer filtro: host EXACTO (nunca startsWith sobre el string completo,
// que podría confundirse con un subdominio/host distinto que solo comparte
// el prefijo). Después de este filtro, la clasificación real es por
// CONTENIDO de la página, no por ruta — ver classifySinoeZone más abajo.
const SINOE_HOST = 'casillas.pj.gob.pe';

const SINOE_PATHS = {
  // Formulario donde se ingresan las credenciales (todavía sin sesión).
  // Es la única ruta que se sigue verificando por URL: el resto de rutas
  // dentro de SINOE se clasifican por CONTENIDO (ver classifySinoeZone),
  // no por path exacto.
  loginForm: '/sinoe/login.xhtml',
};

function normalizePath(pathname) {
  return pathname.replace(/\/+$/, '');
}

// ---------- Clasificación por CONTENIDO, no solo por URL ----------
// Descubrimos que SINOE reutiliza la misma URL para estados distintos: si
// la sesión expira por inactividad, SINOE vuelve a mostrar el login EN LA
// MISMA url de una página autenticada, sin redirigir de verdad. Confiar
// solo en la ruta hubiera mostrado "conectado" aunque ya no haya sesión.
// Por eso, para cualquier URL de SINOE que no sea el login, se confirma
// mirando si el menú común de la app (frmMenu) sigue en la página — ese
// menú está presente en TODAS las vistas autenticadas que revisamos
// (bandeja de notificaciones y Mis Datos), así que su sola presencia ya es
// señal suficiente, sin necesitar reconocer la página exacta.
//
// Devuelve 'outside' | 'sinoe-pending' | 'sinoe-authenticated'.
// Nunca lanza: cualquier URL inesperada, ausente o no parseable, o cualquier
// fallo al leer el contenido, cae en el estado más restrictivo, nunca en
// el más permisivo.
async function classifySinoeZone(tab) {
  if (!tab || !tab.url) return { zone: 'outside' };

  let url;
  try {
    url = new URL(tab.url);
  } catch (err) {
    return { zone: 'outside' };
  }

  if (url.protocol !== 'https:' || url.hostname !== SINOE_HOST) {
    return { zone: 'outside' };
  }

  const path = normalizePath(url.pathname);

  if (path === SINOE_PATHS.loginForm) {
    return { zone: 'sinoe-pending', page: 'login' };
  }

  if (!tab.id) return { zone: 'sinoe-pending', page: 'unknown' };

  const appShellPresent = await checkSinoeSessionAlive(tab.id);
  if (appShellPresent) {
    return { zone: 'sinoe-authenticated' };
  }

  // Dominio de SINOE, no es el login, pero tampoco se confirma el menú de
  // la app (sesión recién expirada mostrando el login en esta misma URL,
  // o una pantalla que no reconocemos): por seguridad se trata igual que
  // "sin sesión todavía", nunca como autenticada.
  return { zone: 'sinoe-pending', page: 'unknown' };
}

// ---------- Validación de identidad (SINOE vs. cuenta Okumet) ----------
// Compara el DNI y el código de colegiatura visibles en "Mis Datos" de
// SINOE contra los de la cuenta Okumet logeada en la extensión. Si esos
// campos no están ya en pantalla, la extensión hace click en el botón real
// "MIS DATOS" del menú para llegar ahí — eso SÍ dispara una navegación real
// de la pestaña (ver detalle más abajo), no es una operación 100% pasiva.
// Nunca hace fetch/petición de red aparte: todo pasa por la UI real de
// SINOE, con cookies/sesión del propio navegador del usuario.

// Confirmado con backend (app/Models/User.php): campos `dni` y
// `colegiatura` en el usuario que devuelven /api/login y /api/yo.
const OKUMET_IDENTITY_FIELDS = {
  dni: 'dni',
  colegiatura: 'colegiatura',
};

// IMPORTANTE: el click en "MIS DATOS" NO es una actualización AJAX dentro
// de la misma página — es un <form> que navega de verdad a otra URL
// (confirmado: action="/sinoe/pages/casillas/gestion/abogadoDefensorPublico.xhtml"
// con .submit(), no PrimeFaces.ab()). Eso significa que el contexto donde
// se ejecuta el click MUERE en cuanto la navegación empieza, así que NO se
// puede "esperar" el resultado dentro de la misma función inyectada (ese
// era el bug original). Por eso el flujo se divide en 3 pasos separados,
// coordinados desde popup.js, no desde una sola función de página:
//   1) leer los campos si ya están visibles,
//   2) si no, click en el botón real + esperar a que la pestaña termine de
//      cargar la nueva URL (chrome.tabs.onUpdated, no un loop interno),
//   3) volver a inyectar un script (nuevo, en la página ya cargada) y leer.

// Se ejecuta DENTRO de la pestaña de SINOE. Solo LEE, nunca modifica nada.
// Los campos tienen id fijo asignado por el propio formulario (no
// autogenerado), por eso son confiables:
//   <input id="frm:dni" value="32978161" placeholder="Número de documento">
//   <input id="frm:nroColegiatura" value="484" placeholder="Nº Colegiatura">
function readSinoeIdentityFieldsInPage() {
  const dniInput = document.getElementById('frm:dni');
  const colegiaturaInput = document.getElementById('frm:nroColegiatura');
  if (!dniInput || !colegiaturaInput) return null;
  return { dni: dniInput.value.trim(), colegiatura: colegiaturaInput.value.trim() };
}

// Se ejecuta DENTRO de la pestaña de SINOE. SINOE cierra la sesión por
// inactividad y vuelve a mostrar el formulario de login EN LA MISMA URL
// (sin redirigir de verdad) — por eso la URL sola no basta para confiar en
// que la sesión sigue activa. "frmMenu" es el menú superior (logo + Mis
// Datos/Cambio de clave/Cerrar sesión) presente en toda la app autenticada;
// si no existe, lo más probable es que la sesión haya expirado.
function detectSinoeAppShellInPage() {
  return Boolean(document.getElementById('frmMenu'));
}

// Se ejecuta DENTRO de la pestaña de SINOE. Hace click en el botón REAL del
// menú ("MIS DATOS", id="frmMenu:clMisDatos") en vez de pedirle al usuario
// que navegue ahí manualmente. Es el mismo elemento que un click humano
// activaría — dispara el mismo manejador PrimeFaces.addSubmitParam(...)
// .submit(...) que ya usa SINOE, así que el servidor recibe la misma
// petición que si el usuario lo hubiera clickeado (a diferencia de abrir
// una URL pegada, que sí dispara las protecciones de SINOE que mencionaste).
// No se espera nada aquí: solo dispara el click y retorna de inmediato,
// antes de que la navegación destruya este contexto.
function clickMisDatosLinkInPage() {
  const link = document.getElementById('frmMenu:clMisDatos');
  if (!link) return false;
  link.click();
  return true;
}

// Se ejecuta DENTRO de la pestaña de SINOE. Hace la cadena completa para UN
// expediente: abre "Ver anexos" → espera a que el modal se pueble → busca
// la fila cuyo "Tipo" sea "Resolución" (nunca otra, aunque haya varias) →
// captura ese PDF reconstruyendo el MISMO POST que el botón "Descarga
// Individual" dispararía (new FormData(form, botón) incluye el ViewState
// actual y el nombre del botón presionado, exactamente como una descarga
// real) → cierra el modal.
//
// SIEMPRE intenta cerrar el modal antes de salir, sin importar en qué
// paso falló — nunca debe quedar abierto y trabado en la pantalla real
// del usuario. "Cerrar" se busca por su texto visible, no por su id
// autogenerado (j_idtNN), porque esos ids pueden cambiar entre renders.
async function syncResolucionPdfInPage(numeroNotificacion) {
  function cerrarModalAnexos() {
    const botones = document.querySelectorAll('#frmAnexos button');
    const cerrar = Array.from(botones).find((b) => (b.textContent || '').trim() === 'Cerrar');
    if (cerrar) cerrar.click();
  }

  function buscarFila() {
    const tbody = document.getElementById('frmBusqueda:tblLista_data');
    if (!tbody) return null;
    return Array.from(tbody.querySelectorAll('tr')).find((row) => {
      const cells = row.querySelectorAll('td');
      return cells.length >= 9 && (cells[3]?.textContent || '').trim() === numeroNotificacion;
    });
  }

  const row = buscarFila();
  if (!row) {
    console.error('[Okumet] syncResolucionPdf: no se encontró la fila', numeroNotificacion);
    return { ok: false, reason: 'row-not-found' };
  }

  // Se vuelve a leer la metadata FRESCA desde la fila (no la que ya tenía
  // guardada la extensión) — es la misma fuente de verdad que se está
  // usando para encontrar la fila, evita cualquier desfase.
  const celdas = row.querySelectorAll('td');
  const expediente = {
    numeroNotificacion,
    numeroExpediente: (celdas[4]?.textContent || '').trim(),
    sumilla: (celdas[5]?.querySelector('textarea')?.value || '').trim(),
    juzgado: (celdas[6]?.textContent || '').trim(),
    fecha: (celdas[7]?.textContent || '').trim(),
  };

  const verAnexosBtn = Array.from(row.querySelectorAll('button')).find(
    (btn) => !btn.classList.contains('okumet-sync-btn')
  );
  if (!verAnexosBtn) {
    console.error('[Okumet] syncResolucionPdf: no se encontró el botón "Ver anexos"');
    return { ok: false, reason: 'ver-anexos-not-found' };
  }

  verAnexosBtn.click();

  // Espera hasta ~5s a que el modal termine de poblarse por AJAX.
  let filasAnexos = null;
  for (let intento = 0; intento < 25; intento += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const cuerpo = document.getElementById('frmAnexos:tblListaAnexos_data');
    if (cuerpo && cuerpo.querySelector('tr')) {
      filasAnexos = Array.from(cuerpo.querySelectorAll('tr'));
      break;
    }
  }

  if (!filasAnexos) {
    console.error('[Okumet] syncResolucionPdf: el modal de anexos no se pobló a tiempo');
    cerrarModalAnexos();
    return { ok: false, reason: 'modal-timeout' };
  }

  // "resoluc" en vez de "resolución" completo: evita fallar por un posible
  // problema de codificación de acentos en el texto que viene de SINOE.
  const filaResolucion = filasAnexos.find((fila) => {
    const tipo = (fila.querySelector('td')?.textContent || '').trim().toLowerCase();
    return tipo.startsWith('resoluc');
  });

  if (!filaResolucion) {
    const tiposEncontrados = filasAnexos.map((fila) => (fila.querySelector('td')?.textContent || '').trim());
    console.error('[Okumet] syncResolucionPdf: sin fila "Resolución". Tipos presentes:', tiposEncontrados);
    cerrarModalAnexos();
    return { ok: false, reason: 'resolucion-not-found' };
  }

  const descargaBtn = filaResolucion.querySelector('button[id$=":clDescarga"]');
  const form = document.getElementById('frmAnexos');

  if (!descargaBtn || !form) {
    console.error('[Okumet] syncResolucionPdf: no se encontró el botón de descarga o el form');
    cerrarModalAnexos();
    return { ok: false, reason: 'download-button-not-found' };
  }

  try {
    // IMPORTANTE: este formulario tiene enctype="application/x-www-form-
    // urlencoded" (confirmado con una petición real capturada por el
    // usuario) — pero un FormData() enviado por fetch() SIEMPRE se manda
    // como multipart/form-data, sin importar el enctype real del <form>.
    // Con multipart, SINOE no reconocía qué botón se había "presionado" y
    // devolvía la página normal en vez del PDF. Por eso se arma el body
    // a mano como URLSearchParams, replicando el POST real campo por
    // campo (incluye el ViewState actual + el botón de descarga, con
    // value vacío, igual que un submit real de ese botón).
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === 'string') params.append(key, value);
    }
    params.append(descargaBtn.name, descargaBtn.value || '');

    const res = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);

    const contentType = res.headers.get('Content-Type') || 'application/pdf';
    const blob = await res.blob();
    console.debug('[Okumet] syncResolucionPdf: PDF capturado', { sizeBytes: blob.size, contentType });

    // SINOE puede devolver su página normal (HTML) en vez del archivo si
    // algo salió mal del lado del servidor — mejor detectarlo acá, con un
    // motivo claro, que subir HTML disfrazado de PDF al backend.
    if (!contentType.toLowerCase().includes('pdf')) {
      console.error('[Okumet] syncResolucionPdf: la respuesta no es un PDF, es', contentType);
      cerrarModalAnexos();
      return { ok: false, reason: 'not-a-pdf' };
    }

    // chrome.scripting.executeScript solo puede devolver datos serializables
    // (JSON-like) — un Blob no sobrevive el viaje de vuelta al popup, por
    // eso se convierte a base64 aquí mismo, dentro de la página.
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });

    cerrarModalAnexos();
    return { ok: true, sizeBytes: blob.size, contentType, base64, expediente };
  } catch (err) {
    console.error('[Okumet] syncResolucionPdf: falló la descarga del PDF', err);
    cerrarModalAnexos();
    return { ok: false, reason: 'download-failed' };
  }
}

// Se ejecuta DENTRO de la pestaña de SINOE. Solo agrega/actualiza un overlay
// visual (div con estilos inline, sin depender de popup.css) — no toca
// ningún formulario, no envía nada al servidor, es puramente informativo
// para que el usuario entienda por qué su pantalla de SINOE cambia sola.
// Usa un id fijo para poder reutilizar el mismo overlay entre llamadas en
// vez de apilar varios.
function showOkumetOverlayInPage(message) {
  let overlay = document.getElementById('__okumet_validation_overlay__');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = '__okumet_validation_overlay__';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(15,39,68,0.55);font-family:"Segoe UI",system-ui,-apple-system,sans-serif;';

    const styleTag = document.createElement('style');
    styleTag.textContent = '@keyframes __okumet_spin__{to{transform:rotate(360deg)}}';
    overlay.appendChild(styleTag);

    const card = document.createElement('div');
    card.style.cssText =
      'width:min(85%,300px);background:#fff;border-radius:14px;padding:26px 22px;' +
      'box-shadow:0 20px 45px rgba(15,23,42,.35);display:flex;flex-direction:column;' +
      'align-items:center;gap:10px;text-align:center;';

    const spinner = document.createElement('div');
    spinner.style.cssText =
      'width:30px;height:30px;border-radius:50%;border:3px solid rgba(245,166,35,.25);' +
      'border-top-color:#f5a623;animation:__okumet_spin__ .7s linear infinite;';

    const title = document.createElement('p');
    title.textContent = 'Okumet Document Access';
    title.style.cssText = 'margin:0;font-size:14px;font-weight:700;color:#0f2744;';

    const text = document.createElement('p');
    text.id = '__okumet_validation_overlay_message__';
    text.style.cssText = 'margin:0;font-size:12px;color:#475569;line-height:1.4;';

    card.appendChild(spinner);
    card.appendChild(title);
    card.appendChild(text);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);
  }

  const textEl = document.getElementById('__okumet_validation_overlay_message__');
  if (textEl) textEl.textContent = message;
}

function hideOkumetOverlayInPage() {
  document.getElementById('__okumet_validation_overlay__')?.remove();
}

// Garantiza que CUALQUIER promesa se resuelva dentro de timeoutMs, aunque la
// promesa original nunca termine (ej. la pestaña de SINOE queda congelada a
// mitad de la inyección). Si se agota el tiempo, se resuelve con
// `onTimeoutValue` en vez de quedarse esperando para siempre — preferimos
// fallar rápido y visible a dejar la extensión colgada.
function withTimeout(promise, timeoutMs, onTimeoutValue) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeoutValue);
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeoutValue);
      }
    );
  });
}

async function readIdentityFields(tabId) {
  const run = (async () => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: readSinoeIdentityFieldsInPage,
      });
      return result;
    } catch (err) {
      // La pestaña puede estar a mitad de navegación justo en este instante;
      // se trata igual que "todavía no encontrado", nunca como error fatal.
      return null;
    }
  })();

  return withTimeout(run, 4000, null);
}

// Si no se puede confirmar (timeout, error), se asume que la sesión NO
// está activa — el estado más restrictivo, igual que el resto de la
// clasificación de zonas. Nunca se asume "autenticado" por defecto.
async function checkSinoeSessionAlive(tabId) {
  const run = (async () => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: detectSinoeAppShellInPage,
      });
      return Boolean(result);
    } catch (err) {
      return false;
    }
  })();

  return withTimeout(run, 4000, false);
}

async function clickMisDatosLink(tabId) {
  const run = (async () => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: clickMisDatosLinkInPage,
      });
      return Boolean(result);
    } catch (err) {
      return false;
    }
  })();

  return withTimeout(run, 4000, false);
}

// Puramente informativo: si falla (pestaña recién navegando, lo que sea),
// NUNCA debe tumbar la validación real — solo se intenta, con límite de
// tiempo, y se ignora cualquier error.
async function setSinoeOverlay(tabId, message) {
  const run = chrome.scripting
    .executeScript({ target: { tabId }, func: showOkumetOverlayInPage, args: [message] })
    .catch(() => {});
  await withTimeout(run, 2000, null);
}

async function clearSinoeOverlay(tabId) {
  const run = chrome.scripting
    .executeScript({ target: { tabId }, func: hideOkumetOverlayInPage })
    .catch(() => {});
  await withTimeout(run, 2000, null);
}

function waitForTabToFinishLoading(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getStoredUsuario() {
  const { okumetUsuario } = await chrome.storage.local.get('okumetUsuario');
  return okumetUsuario || null;
}

// La validación de identidad se guarda en chrome.storage.local (no solo en
// una variable de memoria) porque el popup clásico destruye y recrea TODO
// su contexto de JS cada vez que se cierra y se vuelve a abrir — sin esto,
// "ocultar y mostrar" la extensión hacía que se revalidara cada vez, aunque
// ya hubiera salido verde. Se limpia al cerrar sesión (ver showLogin).
async function getStoredIdentityState() {
  const { okumetIdentityState } = await chrome.storage.local.get('okumetIdentityState');
  return okumetIdentityState || null;
}

async function setStoredIdentityState(state) {
  await chrome.storage.local.set({ okumetIdentityState: state });
}

async function clearStoredIdentityState() {
  await chrome.storage.local.remove('okumetIdentityState');
}

function normalizeForCompare(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

// Pausa los refrescos automáticos del banner (chrome.tabs.onActivated /
// onUpdated, ver más abajo) mientras esta validación está en curso: el
// click en "MIS DATOS" dispara una navegación real, y esos mismos
// listeners reaccionarían a ESA navegación reconstruyendo el banner a
// mitad de camino, perdiendo el estado "Validando…" (ese era el segundo
// bug: dos sistemas reaccionando a la misma navegación, pisándose entre sí).
let isValidatingIdentity = false;

// Guarda el tabId de la pestaña donde se mostró el overlay de SINOE, para
// que el llamador de más afuera (runAutoIdentityValidation) pueda quitarlo
// DESPUÉS de cumplir el mínimo de 2s (ver withMinDuration) — si se limpiara
// aquí mismo, apenas termina el chequeo real, desaparecería mucho antes que
// el modal de la extensión (ese era justo el bug: el modal sí respetaba el
// mínimo, pero el overlay de SINOE no).
let currentOverlayTabId = null;

async function runIdentityValidation(onProgress) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};

  // Pausa deliberada antes de hacer nada: si el auto-click a "Mis Datos"
  // ocurriera en el mismo instante en que se detecta la zona autenticada,
  // se vería como una reacción al milisegundo, muy poco humana. El modal
  // (ya mostrado por quien llama a esta función) cubre esta espera.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, reason: 'no-tab' };
  }

  const tabId = tab.id;

  // Re-chequeo defensivo: classifySinoeZone ya confirmó esto mismo antes de
  // llegar aquí, pero puede pasar algo de tiempo (la pausa de 1s de arriba,
  // lo que tarde chrome.tabs.query) entre ese chequeo y este punto. Si la
  // sesión se cae justo en esa ventana, mejor repetir la verificación que
  // confiar en un estado que ya puede estar desactualizado.
  const sessionAlive = await checkSinoeSessionAlive(tabId);
  if (!sessionAlive) {
    return { ok: false, reason: 'session-expired' };
  }

  currentOverlayTabId = tabId;

  // Muestra el mismo mensaje en el modal de la extensión Y como overlay
  // sobre la propia pestaña de SINOE (solo visual, nada se envía al
  // servidor). El retiro del overlay NO pasa aquí — ver currentOverlayTabId.
  const sync = async (message) => {
    notify(message);
    await setSinoeOverlay(tabId, message);
  };

  await sync('Validando SINOE con Okumet Document…');

  let scraped = await readIdentityFields(tabId);

  if (!scraped) {
    await sync('Abriendo "Mis Datos" en SINOE…');
    const clicked = await clickMisDatosLink(tabId);
    if (!clicked) {
      return { ok: false, reason: 'link-not-found' };
    }

    await waitForTabToFinishLoading(tabId, 6000);
    // La navegación recién terminada destruyó el overlay anterior junto
    // con la página vieja — se vuelve a mostrar en la página nueva.
    await sync('Leyendo tus datos…');
    scraped = await readIdentityFields(tabId);

    if (!scraped) {
      return { ok: false, reason: 'timeout' };
    }
  }

  console.debug('[Okumet] Datos extraídos de SINOE para validar identidad:', scraped);

  await sync('Comparando con tu cuenta Okumet…');
  const usuario = await getStoredUsuario();
  if (!usuario) {
    return { ok: false, reason: 'no-usuario' };
  }

  const okumetDni = usuario[OKUMET_IDENTITY_FIELDS.dni];
  const okumetColegiatura = usuario[OKUMET_IDENTITY_FIELDS.colegiatura];

  if (!scraped.dni || !scraped.colegiatura) {
    return { ok: false, reason: 'not-found', scraped };
  }

  const dniMatches = normalizeForCompare(scraped.dni) === normalizeForCompare(okumetDni);
  const colegiaturaMatches =
    normalizeForCompare(scraped.colegiatura) === normalizeForCompare(okumetColegiatura);

  if (dniMatches && colegiaturaMatches) {
    return { ok: true };
  }

  return { ok: false, reason: 'mismatch', scraped };
}

// Techo absoluto: sin importar qué pase adentro (una API del navegador que
// no responda, una pestaña congelada, lo que sea), esta función SIEMPRE
// termina y SIEMPRE libera `isValidatingIdentity` — nunca se queda colgada
// bloqueando el resto de la extensión indefinidamente.
// Puesto deliberadamente por encima de la suma de los sub-timeouts internos
// (1s pausa + 4s sesión-viva + 4s lectura + 4s click + 6s espera + 4s
// segunda lectura = 23s) para no cortar a mitad de un caso simplemente
// lento; sigue siendo un límite duro, no un "por si acaso" sin efecto.
async function validateIdentityOnActiveTab(onProgress) {
  isValidatingIdentity = true;
  try {
    return await withTimeout(runIdentityValidation(onProgress), 26000, {
      ok: false,
      reason: 'timeout-global',
    });
  } finally {
    isValidatingIdentity = false;
  }
}

const IDENTITY_ERROR_MESSAGES = {
  'no-usuario': 'No se encontró tu sesión de Okumet. Vuelve a iniciar sesión en la extensión.',
  'session-expired':
    'Tu sesión de SINOE expiró. Vuelve a iniciar sesión en SINOE y entra de nuevo a tu casilla.',
  'not-found': 'No se pudo leer tu DNI/colegiatura en esta vista de SINOE.',
  'link-not-found':
    'No se encontró el botón "MIS DATOS" en esta pantalla. Verifica que sigues dentro de tu casilla SINOE.',
  timeout: 'SINOE tardó demasiado en mostrar tus datos. Inténtalo de nuevo.',
  'timeout-global': 'La validación tardó demasiado y se canceló por seguridad. Inténtalo de nuevo.',
  mismatch: 'Los datos de SINOE no coinciden con tu cuenta Okumet. No se puede continuar.',
  'script-error': 'No se pudo leer la página de SINOE. Recarga la pestaña e inténtalo de nuevo.',
  'no-tab': 'No se detectó ninguna pestaña activa.',
};

// Estado cacheado para esta apertura del popup/panel (y además persistido
// en chrome.storage.local, ver getStoredIdentityState/setStoredIdentityState
// más arriba): una vez validado OK o fallido, no se repite solo porque el
// usuario cambió de pestaña, ni siquiera si cierra y vuelve a abrir el
// popup — evita clicks automáticos repetidos dentro de SINOE sin que el
// usuario lo note. Solo un reintento MANUAL (botón) vuelve a disparar la
// validación; nunca hay reintento automático en loop.
let identityState = { status: 'idle' };

function showIdentityModal(message) {
  const modal = document.getElementById('identity-modal');
  const messageEl = document.getElementById('identity-modal-message');
  if (!modal || !messageEl) return;
  messageEl.textContent = message;
  modal.classList.remove('hidden');
}

function updateIdentityModalMessage(message) {
  const messageEl = document.getElementById('identity-modal-message');
  if (messageEl) messageEl.textContent = message;
}

function hideIdentityModal() {
  document.getElementById('identity-modal')?.classList.add('hidden');
}

// Asegura que `promise` tarde al menos `minMs` en resolverse, aunque
// termine antes — una validación que se ve instantánea es, justamente, lo
// que más se parece a un bot. El modal se queda visible ese tiempo mínimo
// aunque el chequeo real ya haya terminado de fondo.
function withMinDuration(promise, minMs) {
  const delay = new Promise((resolve) => setTimeout(resolve, minMs));
  return Promise.all([promise, delay]).then(([result]) => result);
}

// IMPORTANTE: nunca recibe ni guarda una referencia a #identity-box o
// #consent-box como parámetro — siempre los busca por ID en el momento
// exacto de usarlos. Si dos eventos de pestaña casi simultáneos (Chrome
// dispara onActivated y onUpdated por separado, y pueden solaparse)
// reconstruyen statusBanner.innerHTML dos veces, cualquier referencia
// guardada de antemano quedaría apuntando a un nodo viejo ya desconectado
// del documento — y actualizar un nodo desconectado no se ve en pantalla,
// aunque el código "funcione" sin lanzar ningún error. Buscar por ID cada
// vez evita esa clase de bug silencioso.
function renderIdentitySection() {
  // Caso especial: sesión de SINOE expirada. No es un error chico dentro
  // del cuadro de consentimiento — se trata igual que los demás bloqueos
  // (pantalla completa, nada de pestañas ni contenido detrás), porque en
  // los hechos ya no hay sesión real, aunque la URL diga lo contrario.
  if (identityState.status === 'error' && identityState.reason === 'session-expired') {
    hideIdentityModal();
    viewWorkspace.classList.add('is-locked');
    statusBanner.classList.remove('is-connected', 'is-pending');
    statusBanner.classList.add('is-blocked');
    statusBanner.innerHTML = `
      <span class="status-icon">🔒</span>
      <span class="status-title">Sesión de SINOE expirada</span>
      <p class="status-subtitle">${IDENTITY_ERROR_MESSAGES['session-expired']}</p>
      <button id="retry-identity" class="btn btn-validate">Reintentar validación</button>
    `;
    document.getElementById('retry-identity')?.addEventListener('click', () => {
      runAutoIdentityValidation();
    });
    return;
  }

  const identityBox = document.getElementById('identity-box');
  if (!identityBox) return;

  if (identityState.status === 'ok') {
    hideIdentityModal();

    if (identityState.confirmarOda) {
      // Ya confirmó el acceso antes (confirmar_oda = true en Okumet): no
      // se le vuelve a pedir el consentimiento, solo se confirma que todo
      // sigue en orden.
      identityBox.innerHTML = `<p class="identity-result is-ok">✓ Identidad verificada. Acceso ya autorizado.</p>`;
      return;
    }

    identityBox.innerHTML = `<p class="identity-result is-ok">✓ Identidad verificada. Ya puedes autorizar el acceso.</p>`;
    document.getElementById('consent-box')?.classList.remove('hidden');
    return;
  }

  if (identityState.status === 'validating' || identityState.status === 'checking') {
    // El feedback real mientras valida es el modal (ver showIdentityModal);
    // aquí no hace falta duplicar el mensaje, el modal cubre toda la vista.
    identityBox.innerHTML = '';
    return;
  }

  if (identityState.status === 'error') {
    hideIdentityModal();
    identityBox.innerHTML = `
      <p class="identity-result is-error">
        ${IDENTITY_ERROR_MESSAGES[identityState.reason] || 'No se pudo validar la identidad.'}
      </p>
      <button id="retry-identity" class="btn btn-validate">Reintentar validación</button>
    `;
    document.getElementById('retry-identity').addEventListener('click', () => {
      runAutoIdentityValidation();
    });
    return;
  }

  // status === 'idle': primera vez en esta apertura del popup/panel. Antes
  // de validar de nuevo, revisa si ya quedó un resultado guardado de una
  // apertura anterior (por eso NO revalida solo porque cerraste/abriste la
  // extensión) — y si no hay nada guardado, recién ahí dispara la
  // validación real, sola, sin que el usuario tenga que presionar nada.
  //
  // IMPORTANTE: el cambio a 'checking' pasa AQUÍ, de forma síncrona, antes
  // de llamar a initIdentitySection (que hace `await` a storage). Si no
  // fuera así, dos eventos de pestaña casi simultáneos podrían ambos ver
  // 'idle' todavía (mientras el primero sigue esperando la lectura de
  // storage) y disparar la inicialización por duplicado — dos
  // validaciones corriendo a la vez sobre la misma pestaña de SINOE.
  identityBox.innerHTML = '';
  identityState = { status: 'checking' };
  initIdentitySection();
}

async function initIdentitySection() {
  const stored = await getStoredIdentityState();

  if (!document.getElementById('identity-box')) return;

  if (stored && (stored.status === 'ok' || stored.status === 'error')) {
    identityState = stored;
    renderIdentitySection();
    return;
  }

  runAutoIdentityValidation();
}

async function runAutoIdentityValidation() {
  // Protege contra doble-click en "Reintentar validación" (u otra llamada
  // duplicada que se nos escape): si ya hay una validación en curso, esta
  // segunda invocación no hace nada — nunca dos validaciones a la vez
  // sobre la misma pestaña de SINOE. Como las líneas de abajo (hasta el
  // primer await real) corren de forma síncrona apenas se llama a esta
  // función, un segundo click siempre llega DESPUÉS de que el primero ya
  // puso `isValidatingIdentity` en true dentro de validateIdentityOnActiveTab.
  if (isValidatingIdentity) return;

  identityState = { status: 'validating' };
  renderIdentitySection();
  showIdentityModal('Preparando validación…');
  currentOverlayTabId = null;

  try {
    const result = await withMinDuration(
      validateIdentityOnActiveTab((message) => {
        // Puede llegar DESPUÉS de que el usuario ya haya cerrado sesión o
        // navegado fuera: solo actualiza si el modal sigue en pantalla.
        if (document.getElementById('identity-modal')) {
          updateIdentityModalMessage(message);
        }
      }),
      2000
    );

    if (result.ok) {
      // Primera validación exitosa: marca al abogado como habilitado en
      // Okumet (idempotente en backend, seguro llamarlo siempre que se
      // valida de nuevo tras cerrar/abrir sesión). Si falla por red, se
      // sigue mostrando el consentimiento (fallback seguro: pedir de más
      // nunca es tan malo como saltarse un consentimiento real).
      const usuarioActualizado = await markAbogadoHabilitado();
      const usuarioLocal = usuarioActualizado || (await getStoredUsuario());
      identityState = { status: 'ok', confirmarOda: Boolean(usuarioLocal && usuarioLocal.confirmar_oda) };
    } else {
      identityState = { status: 'error', reason: result.reason };
    }
    await setStoredIdentityState(identityState);
  } finally {
    // Recién AHORA, ya cumplido el mínimo de 2s de arriba, se quita el
    // overlay de la pestaña de SINOE — así dura lo mismo que el modal de
    // la extensión, en vez de desaparecer apenas termina el chequeo real.
    if (currentOverlayTabId) {
      await clearSinoeOverlay(currentOverlayTabId);
      currentOverlayTabId = null;
    }
  }

  // Solo re-pinta si el cuadro de identidad sigue en el DOM (pudo haberse
  // cerrado el popup, o renderConnectionStatus pudo haber reconstruido todo
  // de nuevo mientras tanto una vez liberada la bandera de pausa). Como
  // renderIdentitySection ya busca todo por ID en el momento, esto es
  // seguro incluso si statusBanner se reconstruyó varias veces mientras
  // esta validación corría de fondo.
  if (document.getElementById('identity-box')) {
    renderIdentitySection();
  } else {
    hideIdentityModal();
  }
}

// Cambia aquí entre 'development' y 'production' según contra qué API
// quieras probar. 'development' apunta al backend corriendo en local
// (http://localhost:8000, según el .env del repo okd-backend).
const ENVIRONMENT = 'development';

const API_BASES = {
  development: 'http://localhost:8000/api',
  production: 'https://api.okumet.com/api',
};

const API_BASE = API_BASES[ENVIRONMENT];

// Mismo popup.html se usa como popup clásico y como side panel (manifest
// "side_panel.default_path" agrega "?context=panel"). Esta clase deja que
// el CSS adapte el layout a cada contenedor sin duplicar markup.
const isPanelContext = new URLSearchParams(location.search).get('context') === 'panel';
document.body.classList.toggle('is-panel', isPanelContext);

const viewLogin = document.getElementById('view-login');
const viewWorkspace = document.getElementById('view-workspace');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginSubmitBtn = document.getElementById('login-submit');

const profileBtn = document.getElementById('profile-btn');
const profileMenu = document.getElementById('profile-menu');
const goPanelBtn = document.getElementById('go-panel');
const logoutBtn = document.getElementById('logout');

const statusBanner = document.getElementById('status-banner');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');
const pendingList = document.getElementById('pending-list');
const pendingEmpty = document.getElementById('pending-empty');
const syncedList = document.getElementById('synced-list');
const syncedEmpty = document.getElementById('synced-empty');

/* ---------- Sesión: token guardado en chrome.storage.local ---------- */

async function getStoredToken() {
  const { okumetToken } = await chrome.storage.local.get('okumetToken');
  return okumetToken || null;
}

async function setStoredSession(token, usuario) {
  await chrome.storage.local.set({ okumetToken: token, okumetUsuario: usuario || null });
}

async function clearStoredSession() {
  await chrome.storage.local.remove(['okumetToken', 'okumetUsuario']);
}

async function updateStoredUsuario(usuario) {
  if (!usuario) return;
  await chrome.storage.local.set({ okumetUsuario: usuario });
}

// POST autenticado a un endpoint de /api/sinoe/*. Nunca lanza: si falla
// (sin token, sin red, error del servidor), devuelve null y el llamador
// decide el fallback — estos pasos son complementarios a la validación de
// identidad, nunca deben tumbarla si fallan.
async function callSinoeAuthEndpoint(path) {
  const token = await getStoredToken();
  if (!token) return null;

  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

// Se llama una sola vez, justo después de que la identidad se valida
// exitosamente por primera vez (ver runAutoIdentityValidation). Es
// idempotente en el backend, así que no pasa nada si se llama de nuevo.
async function markAbogadoHabilitado() {
  const usuario = await callSinoeAuthEndpoint('/sinoe/validar-abogado');
  if (usuario) await updateStoredUsuario(usuario);
  return usuario;
}

// Se llama cuando el usuario marca el checkbox y presiona "Confirmar
// acceso". Una vez que el backend confirma, no se vuelve a pedir ese
// consentimiento (ver confirmarOda en identityState / renderIdentitySection).
async function confirmarAccesoOda() {
  const usuario = await callSinoeAuthEndpoint('/sinoe/confirmar-acceso');
  if (usuario) await updateStoredUsuario(usuario);
  return usuario;
}

// Sube el PDF capturado + sus metadatos a POST /api/sinoe/expedientes.
// Del lado del backend esto crea/actualiza un Expediente real (origen:
// 'sinoe') con el PDF como Documento colgado de él — no una tabla aparte.
// Devuelve { ok: true, actualizado, expedienteId } en éxito, o
// { ok: false, status, message } en error — el llamador decide si mueve
// la tarjeta de "Pendientes" a "Sincronizados" (solo cuando ok === true).
async function subirExpedienteAlBackend(expediente, base64DataUrl, contentType) {
  const token = await getStoredToken();
  if (!token) return { ok: false, status: 0, message: 'No hay sesión de Okumet activa.' };

  let blob;
  try {
    // fetch() también puede leer URLs "data:" — es la forma más simple de
    // volver a convertir el base64 en un Blob real dentro del popup.
    blob = await (await fetch(base64DataUrl)).blob();
  } catch (err) {
    return { ok: false, status: 0, message: 'No se pudo preparar el archivo para subir.' };
  }

  const formData = new FormData();
  formData.append('numero_notificacion', expediente.numeroNotificacion);
  formData.append('numero_expediente', expediente.numeroExpediente);
  formData.append('sumilla', expediente.sumilla);
  formData.append('juzgado', expediente.juzgado);
  // SINOE ya entrega la fecha como "30/10/2026 14:13:59" — coincide
  // exactamente con el formato "d/m/Y H:i:s" que pide el backend.
  formData.append('fecha_notificacion', expediente.fecha);
  formData.append(
    'documento',
    new File([blob], `${expediente.numeroExpediente || expediente.numeroNotificacion}.pdf`, {
      type: contentType || 'application/pdf',
    })
  );

  try {
    const res = await fetch(`${API_BASE}/sinoe/expedientes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      body: formData,
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error('[Okumet] subirExpedienteAlBackend: rechazado por el servidor', res.status, data);
      return { ok: false, status: res.status, message: data.message || 'El servidor rechazó la subida.' };
    }

    console.debug('[Okumet] subirExpedienteAlBackend: subido con éxito', data);
    // El endpoint crea/actualiza un Expediente real colgando el PDF como
    // Documento — "documento_actualizado" dice si ESTA notificación puntual
    // ya existía y se reemplazó su PDF (no si el expediente en sí es nuevo:
    // un mismo expediente puede tener varias notificaciones/documentos).
    return {
      ok: true,
      documentoActualizado: Boolean(data.documento_actualizado),
      expedienteId: data.data && data.data.id,
    };
  } catch (err) {
    console.error('[Okumet] subirExpedienteAlBackend: error de red', err);
    return { ok: false, status: 0, message: 'No se pudo conectar con el servidor.' };
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Muestra lo que el content script de la bandeja (content-bandeja.js) fue
// guardando en chrome.storage.local al presionar "Agregar" en cada fila.
// Por ahora SOLO se muestra aquí — no se envía nada al backend de Okumet
// todavía, esto es puramente informativo.
async function renderPendientesTab() {
  if (!pendingList || !pendingEmpty) return;

  const { okumetPendingExpedientes } = await chrome.storage.local.get('okumetPendingExpedientes');
  const items = Array.isArray(okumetPendingExpedientes) ? okumetPendingExpedientes : [];

  if (items.length === 0) {
    pendingList.innerHTML = '';
    pendingEmpty.classList.remove('hidden');
    return;
  }

  pendingEmpty.classList.add('hidden');
  pendingList.innerHTML = items
    .map(
      (item) => `
        <li class="pending-item">
          <span class="pending-item-icon">📄</span>
          <div class="pending-item-text">
            <strong>${escapeHtml(item.numeroExpediente)}</strong>
            <small>${escapeHtml(item.sumilla)}</small>
            <small>${escapeHtml(item.juzgado)} · ${escapeHtml(item.fecha)}</small>
          </div>
          <button
            type="button"
            class="pending-sync-btn"
            data-numero="${escapeHtml(item.numeroNotificacion)}"
            title="Abrir anexos en SINOE"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6a5.96 5.96 0 0 1 4.22 1.78L13 11h7V4z" />
            </svg>
          </button>
        </li>
      `
    )
    .join('');
}

// Muestra los expedientes que el backend ya confirmó como guardados
// (okumetSyncedExpedientes). Todavía no hay nada que los mueva aquí desde
// "Pendientes" — eso llega cuando se conecte el endpoint de subida; por
// ahora es solo la base de UI para no tener que rehacer esto después.
async function renderSincronizadosTab() {
  if (!syncedList || !syncedEmpty) return;

  const { okumetSyncedExpedientes } = await chrome.storage.local.get('okumetSyncedExpedientes');
  const items = Array.isArray(okumetSyncedExpedientes) ? okumetSyncedExpedientes : [];

  if (items.length === 0) {
    syncedList.innerHTML = '';
    syncedEmpty.classList.remove('hidden');
    return;
  }

  syncedEmpty.classList.add('hidden');
  syncedList.innerHTML = items
    .map(
      (item) => `
        <li class="pending-item">
          <span class="pending-item-icon">✅</span>
          <div class="pending-item-text">
            <strong>${escapeHtml(item.numeroExpediente)}</strong>
            <small>${escapeHtml(item.sumilla)}</small>
            <small>${escapeHtml(item.juzgado)} · ${escapeHtml(item.fecha)}</small>
          </div>
        </li>
      `
    )
    .join('');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.okumetSyncedExpedientes) {
    renderSincronizadosTab();
  }
});

// Rutas donde puede estar la bandeja con la tabla de expedientes — las
// mismas 3 que ya usamos para la zona autenticada (ver clasificación por
// contenido más arriba), porque SINOE puede mostrarla bajo cualquiera.
const SINOE_TAB_URL_PATTERNS = [
  'https://casillas.pj.gob.pe/sinoe/pages/seguridad/sso/sso-menu-app.xhtml*',
  'https://casillas.pj.gob.pe/sinoe/pages/casillas/notificaciones/notificacion-bandeja.xhtml*',
  'https://casillas.pj.gob.pe/sinoe/pages/casillas/gestion/abogadoDefensorPublico.xhtml*',
];

// Busca entre las pestañas abiertas (no necesariamente la activa — el
// usuario puede estar mirando el popup/panel mientras SINOE está en otra
// pestaña) una que coincida con la bandeja, y le pide que haga la cadena
// completa para ese expediente (ver syncResolucionPdfInPage): abrir
// anexos, capturar SOLO el PDF de tipo "Resolución", cerrar el modal.
// Techo de tiempo duro — nunca se queda colgado esperando el modal o el
// fetch, consistente con el resto de la extensión.
async function syncResolucionPdf(numeroNotificacion) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: SINOE_TAB_URL_PATTERNS });
  } catch (err) {
    return { ok: false, reason: 'no-tab' };
  }

  const tab = tabs[0];
  if (!tab || !tab.id) return { ok: false, reason: 'no-tab' };

  const run = (async () => {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: syncResolucionPdfInPage,
        args: [numeroNotificacion],
      });
      return result || { ok: false, reason: 'script-error' };
    } catch (err) {
      return { ok: false, reason: 'script-error' };
    }
  })();

  const resultado = await withTimeout(run, 20000, { ok: false, reason: 'timeout' });

  if (resultado.ok) {
    try {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch (err) {
      // No crítico: la captura ya se hizo, solo no se pudo enfocar la
      // pestaña (ej. ventana cerrada entretanto).
    }
  }

  return resultado;
}

const SYNC_RESULT_MESSAGES = {
  'no-tab': 'No se encontró esa pestaña de SINOE abierta.',
  'row-not-found': 'Ese expediente ya no está en esta vista de la bandeja.',
  'ver-anexos-not-found': 'No se encontró el botón "Ver anexos" de esa fila.',
  'modal-timeout': 'SINOE tardó demasiado en mostrar los anexos. Inténtalo de nuevo.',
  'resolucion-not-found': 'Este expediente no tiene un documento de tipo "Resolución".',
  'download-button-not-found': 'No se encontró el botón de descarga del anexo.',
  'download-failed': 'No se pudo descargar el PDF. Inténtalo de nuevo.',
  'not-a-pdf': 'SINOE no devolvió un PDF válido. Inténtalo de nuevo.',
  'script-error': 'No se pudo leer la página de SINOE. Recarga la pestaña e inténtalo de nuevo.',
  timeout: 'La operación tardó demasiado y se canceló por seguridad. Inténtalo de nuevo.',
};

// Pasa un expediente de "Pendientes" a "Sincronizados" — se llama SOLO
// después de que el backend confirmó la subida con éxito, nunca antes
// (si la subida falla, el expediente se queda en Pendientes para
// reintentar, en vez de mentir sobre su estado real).
async function moverExpedienteASincronizados(expediente) {
  const { okumetPendingExpedientes, okumetSyncedExpedientes } = await chrome.storage.local.get([
    'okumetPendingExpedientes',
    'okumetSyncedExpedientes',
  ]);

  const pendientes = Array.isArray(okumetPendingExpedientes) ? okumetPendingExpedientes : [];
  const sincronizados = Array.isArray(okumetSyncedExpedientes) ? okumetSyncedExpedientes : [];

  const nuevosPendientes = pendientes.filter(
    (item) => item.numeroNotificacion !== expediente.numeroNotificacion
  );
  const yaEstaba = sincronizados.some((item) => item.numeroNotificacion === expediente.numeroNotificacion);
  const nuevosSincronizados = yaEstaba ? sincronizados : [...sincronizados, expediente];

  await chrome.storage.local.set({
    okumetPendingExpedientes: nuevosPendientes,
    okumetSyncedExpedientes: nuevosSincronizados,
  });
}

pendingList?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pending-sync-btn');
  if (!btn || btn.disabled) return;

  const numero = btn.dataset.numero;
  btn.disabled = true;
  btn.classList.add('is-busy');

  const resultado = await syncResolucionPdf(numero);

  if (resultado.ok) {
    const subida = await subirExpedienteAlBackend(
      resultado.expediente,
      resultado.base64,
      resultado.contentType
    );

    if (subida.ok) {
      // IMPORTANTE: no se toca `btn` después de esto. Mover el expediente
      // dispara storage.onChanged → renderPendientesTab() reconstruye toda
      // la lista, y esta tarjeta (con este mismo botón) desaparece de ahí
      // — cualquier cosa que le hiciéramos al nodo después sería sobre un
      // elemento ya desconectado del documento, invisible para el usuario.
      await moverExpedienteASincronizados(resultado.expediente);
      return;
    }

    btn.title =
      subida.status === 403
        ? 'Tu suscripción de Okumet no está activa — no se pudo sincronizar.'
        : subida.message || 'No se pudo subir el documento a Okumet.';
    btn.classList.add('sync-error');
  } else {
    btn.title = SYNC_RESULT_MESSAGES[resultado.reason] || 'No se pudo completar la sincronización.';
    btn.classList.add('sync-error');
  }

  btn.disabled = false;
  btn.classList.remove('is-busy');

  // Feedback visual transitorio (3s) — con solo el "title" el usuario
  // tendría que pasar el mouse encima para enterarse de algo.
  setTimeout(() => {
    btn.classList.remove('sync-error');
  }, 3000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.okumetPendingExpedientes) {
    renderPendientesTab();
  }
});

function showError(message) {
  loginError.textContent = message;
  loginError.classList.add('visible');
}

function clearError() {
  loginError.textContent = '';
  loginError.classList.remove('visible');
}

function revealApp() {
  document.getElementById('app').classList.remove('app-loading');
}

function showWorkspace() {
  viewLogin.classList.add('hidden');
  viewWorkspace.classList.remove('hidden');
  renderConnectionStatus();
  renderPendientesTab();
  renderSincronizadosTab();
  revealApp();
}

function showLogin() {
  viewWorkspace.classList.add('hidden');
  viewLogin.classList.remove('hidden');
  // Resetea el caché de validación (memoria + storage persistido): si otra
  // persona inicia sesión con otra cuenta Okumet en este mismo panel, no
  // debe heredar el "ya validado" de la sesión anterior.
  identityState = { status: 'idle' };
  clearStoredIdentityState();
  chrome.storage.local.remove(['okumetPendingExpedientes', 'okumetSyncedExpedientes']);
  revealApp();
}


/* ---------- Login contra la API (POST /api/login) ---------- */

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const formData = new FormData(loginForm);
  const email = formData.get('email');
  const password = formData.get('password');

  loginSubmitBtn.disabled = true;
  loginSubmitBtn.textContent = 'Ingresando…';

  try {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showError(data.message || 'Credenciales incorrectas. Inténtalo nuevamente.');
      return;
    }

    await setStoredSession(data.token, data.usuario);
    showWorkspace();
    loginForm.reset();
  } catch (err) {
    showError('No se pudo conectar con el servidor. Verifica tu conexión.');
  } finally {
    loginSubmitBtn.disabled = false;
    loginSubmitBtn.textContent = 'Iniciar sesión';
  }
});

/* ---------- Restaurar sesión activa al abrir el popup (GET /api/yo) ---------- */

(async function restoreSession() {
  const token = await getStoredToken();
  if (!token) {
    showLogin();
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/yo`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (!res.ok) {
      await clearStoredSession();
      showLogin();
      return;
    }

    showWorkspace();
  } catch (err) {
    // Sin conexión: no se puede validar el token, se deja la vista de login.
    showLogin();
  }
})();

/* ---------- Logout real (POST /api/logout) ---------- */

logoutBtn.addEventListener('click', async () => {
  profileMenu.classList.add('hidden');

  const token = await getStoredToken();
  if (token) {
    try {
      await fetch(`${API_BASE}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch (err) {
      // Si falla la llamada, igual limpiamos la sesión local.
    }
  }

  await clearStoredSession();
  showLogin();
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

/* ---------- Detección en vivo de la pestaña activa ---------- */
/* Relevante sobre todo en modo side panel, donde la vista queda abierta
   mientras el usuario navega entre pestañas (en el popup clásico esto casi
   no se nota porque se cierra al perder foco). */

chrome.tabs.onActivated.addListener(() => {
  if (isValidatingIdentity) return;
  if (!viewWorkspace.classList.contains('hidden')) renderConnectionStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isValidatingIdentity) return;
  if (tab.active && changeInfo.url && !viewWorkspace.classList.contains('hidden')) {
    renderConnectionStatus();
  }
});

/* ---------- Detección de la pestaña activa (solo UI, sin lógica de negocio) ---------- */

async function renderConnectionStatus() {
  let classification = { zone: 'outside' };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    classification = await classifySinoeZone(tab);
  } catch (err) {
    classification = { zone: 'outside' };
  }

  const isRefresh = statusBanner.childElementCount > 0;
  if (isRefresh) {
    statusBanner.style.opacity = '0';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  statusBanner.innerHTML = '';
  statusBanner.classList.remove('is-blocked', 'is-pending', 'is-connected');

  const isAuthenticated = classification.zone === 'sinoe-authenticated';
  viewWorkspace.classList.toggle('is-locked', !isAuthenticated);

  if (isAuthenticated) {
    statusBanner.classList.add('is-connected');
    statusBanner.innerHTML = `
      <div class="status-row">
        <span class="status-dot"></span>
        <span class="status-title">Conectado a tu casilla SINOE</span>
      </div>
      <p class="status-subtitle">Sesión SINOE activa. Antes de sincronizar, validemos que eres el titular de esta cuenta.</p>
      <div class="identity-box" id="identity-box"></div>
      <div class="consent-box hidden" id="consent-box">
        <label class="consent-check">
          <input type="checkbox" id="sinoe-consent" />
          Acepto que Okumet obtenga los documentos de mi casilla SINOE.
        </label>
        <button id="confirm-consent" class="btn btn-confirm" disabled>Confirmar acceso</button>
      </div>
    `;

    const consentCheck = document.getElementById('sinoe-consent');
    const confirmBtn = document.getElementById('confirm-consent');
    const consentBox = document.getElementById('consent-box');

    consentCheck.addEventListener('change', () => {
      confirmBtn.disabled = !consentCheck.checked;
    });

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Confirmando…';

      const usuarioActualizado = await confirmarAccesoOda();

      if (usuarioActualizado) {
        if (identityState.status === 'ok') {
          identityState = { status: 'ok', confirmarOda: true };
          await setStoredIdentityState(identityState);
        }
        consentBox.classList.add('hidden');
        const box = document.getElementById('identity-box');
        if (box) {
          box.innerHTML = '<p class="identity-result is-ok">✓ Acceso confirmado. Ya puedes cerrar esta ventana.</p>';
        }
      } else {
        // Falla de red/servidor: se deja el checkbox y botón tal cual
        // estaban para que el usuario pueda reintentar, en vez de asumir
        // que el consentimiento quedó registrado cuando no fue así.
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Confirmar acceso';
      }
    });

    renderIdentitySection();
  } else if (classification.zone === 'sinoe-pending') {
    statusBanner.classList.add('is-pending');

    const messages = {
      login: {
        icon: '⏳',
        title: 'Extensión bloqueada',
        subtitle: 'Estás iniciando sesión en SINOE. Termina de ingresar tus credenciales para continuar.',
      },
      unknown: {
        icon: '🔒',
        title: 'Extensión bloqueada',
        subtitle: 'Estás dentro de SINOE, pero debes estar en tu casilla con la sesión iniciada para continuar.',
      },
    };
    const { icon, title, subtitle } = messages[classification.page] || messages.unknown;

    statusBanner.innerHTML = `
      <span class="status-icon">${icon}</span>
      <span class="status-title">${title}</span>
      <p class="status-subtitle">${subtitle}</p>
    `;
  } else {
    statusBanner.classList.add('is-blocked');
    statusBanner.innerHTML = `
      <span class="status-icon">🔒</span>
      <span class="status-title">Extensión bloqueada</span>
      <p class="status-subtitle">Debes estar en tu casilla SINOE, con la sesión iniciada, para usar la extensión.</p>
    `;
  }

  requestAnimationFrame(() => {
    statusBanner.style.opacity = '1';
  });
}
