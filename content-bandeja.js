// Content script persistente: se ejecuta automáticamente cuando el usuario
// abre la bandeja de notificaciones de SINOE. A diferencia de los scripts
// puntuales de popup.js (inyectados a demanda con chrome.scripting), este
// corre siempre que la página carga — por eso es MUY importante que:
//   1) Solo agregue UI, nunca modifique ni envíe nada a SINOE.
//   2) Solo actúe si la identidad ya fue validada (ver chequeo de abajo) —
//      nunca mostrar nada de Okumet sobre una cuenta sin validar.
//   3) Reacciona EN VIVO a cambios de estado (chrome.storage.onChanged):
//      si te validas después de que la página ya cargó, los botones
//      aparecen solos; si cierras sesión o la validación deja de ser
//      "ok", los botones ya puestos se quitan — sin recargar la página.
//   4) Por ahora NO sincroniza nada real con el backend — solo guarda los
//      datos en chrome.storage.local para que la extensión los muestre.
(function () {
  // Una sola hoja de estilos inyectada (en vez de armar cssText por
  // elemento) — permite :hover/transiciones reales y mantiene los 3
  // estados ordenados por el atributo data-estado en vez de reconstruir
  // el inline style cada vez.
  function inyectarEstilos() {
    if (document.getElementById('okumet-sync-styles')) return;

    const style = document.createElement('style');
    style.id = 'okumet-sync-styles';
    style.textContent = `
      .okumet-sync-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        margin: 8px auto 0;
        border: none;
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 11px;
        font-weight: 600;
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        cursor: pointer;
        white-space: nowrap;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
        transition: transform 0.12s ease, box-shadow 0.12s ease, filter 0.12s ease;
      }
      .okumet-sync-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 3px 7px rgba(0, 0, 0, 0.22);
        filter: brightness(1.05);
      }
      .okumet-sync-btn:active:not(:disabled) {
        transform: translateY(0);
      }
      .okumet-sync-btn:disabled {
        cursor: default;
        box-shadow: none;
      }
      .okumet-sync-btn[data-estado="activo"] {
        background: linear-gradient(135deg, #f5a623, #dd9112);
        color: #0f2744;
      }
      .okumet-sync-btn[data-estado="agregado"] {
        background: rgba(15, 39, 68, 0.85);
        color: #fff;
      }
      .okumet-sync-btn[data-estado="sincronizado"] {
        background: linear-gradient(135deg, #16a34a, #15803d);
        color: #fff;
      }
      .okumet-sync-btn svg {
        width: 12px;
        height: 12px;
        flex: none;
        fill: currentColor;
      }

      /* Acento de fila: usa los MISMOS colores (navy/ámbar/verde) que el
         resto de la extensión, para que se reconozca como "esto es de
         Okumet" sin necesitar el logo — un borde a la izquierda + un
         fondo muy sutil, sobre la celda de selección (la primera de cada
         fila), para no competir con las columnas propias de SINOE. */
      tr:has(.okumet-sync-btn[data-estado="agregado"]) > td:first-child {
        box-shadow: inset 4px 0 0 0 #0f2744;
        background: rgba(15, 39, 68, 0.05) !important;
      }
      tr:has(.okumet-sync-btn[data-estado="sincronizado"]) > td:first-child {
        box-shadow: inset 4px 0 0 0 #16a34a;
        background: rgba(22, 163, 74, 0.06) !important;
      }

      /* Distintivo de "N° de expediente repetido en esta misma lista" —
         morado, deliberadamente distinto del navy/ámbar/verde de los
         estados del botón: esto es solo informativo (no una acción ni un
         estado de sincronización), así que no debe mezclarse visualmente
         con esos otros significados. */
      .okumet-dup-badge {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        margin-top: 4px;
        padding: 2px 6px;
        border-radius: 999px;
        background: #ede9fe;
        color: #6d28d9;
        font-size: 9.5px;
        font-weight: 600;
        font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
        white-space: nowrap;
      }
      .okumet-dup-badge svg {
        width: 10px;
        height: 10px;
        flex: none;
        fill: currentColor;
      }
    `;
    document.head.appendChild(style);
  }

  const ICONO_AGREGAR =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 11V5h2v6h6v2h-6v6h-2v-6H5v-2z"/></svg>';
  const ICONO_RELOJ =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.59 4 4-1.41 1.41L11 13V7h2z"/></svg>';
  const ICONO_CHECK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  const ICONO_REPETIDO =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7A5 5 0 0 0 7 17h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z"/></svg>';

  // IMPORTANTE: "agregado"/"sincronizado" ya NO deshabilitan el botón.
  // Backend solo actualiza (nunca duplica) cuando se sincroniza de nuevo
  // la misma notificación, así que no hay riesgo real en permitir
  // reenviar — el botón solo informa el estado con el título, nunca
  // bloquea la acción.
  function pintarBoton(btn, estado, etiqueta, icono, titulo) {
    btn.dataset.estado = estado;
    btn.disabled = false;
    btn.innerHTML = `${icono}<span>${etiqueta}</span>`;
    if (titulo) btn.title = titulo;
  }

  function marcarComoAgregado(btn) {
    pintarBoton(
      btn,
      'agregado',
      'Agregado',
      ICONO_RELOJ,
      'Ya está en tus "Pendientes" de Okumet. Puedes presionar de nuevo para agregarlo otra vez.'
    );
  }

  function marcarComoSincronizado(btn) {
    pintarBoton(
      btn,
      'sincronizado',
      'Sincronizado',
      ICONO_CHECK,
      'Ya existe en tu cuenta de Okumet. Presiona de nuevo si quieres volver a sincronizarlo (se actualiza, no se duplica).'
    );
  }

  function quitarBotones() {
    document.querySelectorAll('.okumet-sync-btn').forEach((btn) => btn.remove());
    document.querySelectorAll('.okumet-dup-badge').forEach((badge) => badge.remove());
  }

  // Agrega/quita, en la celda de "N° Expediente", un distintivo cuando ese
  // mismo número aparece en más de una fila de la lista visible (varias
  // notificaciones del mismo caso). Igual que con los botones: solo toca
  // el DOM si el estado realmente cambió, para no retriggerear el
  // MutationObserver de más abajo sobre sí mismo.
  function pintarDistintivoRepetido(celda, esRepetido) {
    if (!celda) return;
    const estadoDeseado = esRepetido ? 'si' : 'no';
    if (celda.dataset.okumetDup === estadoDeseado) return;
    celda.dataset.okumetDup = estadoDeseado;

    let badge = celda.querySelector('.okumet-dup-badge');
    if (!esRepetido) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'okumet-dup-badge';
      badge.title = 'Este N° de expediente aparece en más de una notificación de esta lista';
      celda.appendChild(badge);
    }
    badge.innerHTML = `${ICONO_REPETIDO}<span>Mismo expediente</span>`;
  }

  async function inyectarBotones() {
    const tbody = document.getElementById('frmBusqueda:tblLista_data');
    if (!tbody) return;

    inyectarEstilos();

    // Se lee UNA sola vez para todas las filas, en vez de una lectura de
    // storage por fila. También se revisa "Sincronizados": si ya se subió
    // antes y luego se recarga la página, no debe volver a verse como
    // "Agregar" — eso invitaría a repetir algo que ya quedó hecho.
    const { okumetPendingExpedientes, okumetSyncedExpedientes } = await chrome.storage.local.get([
      'okumetPendingExpedientes',
      'okumetSyncedExpedientes',
    ]);
    const listaPendientes = Array.isArray(okumetPendingExpedientes) ? okumetPendingExpedientes : [];
    const listaSincronizados = Array.isArray(okumetSyncedExpedientes) ? okumetSyncedExpedientes : [];
    const yaAgregados = new Set(listaPendientes.map((item) => item.numeroNotificacion));
    const yaSincronizados = new Set(listaSincronizados.map((item) => item.numeroNotificacion));

    // Todas las filas de la página actual de la tabla (respeta la
    // paginación de SINOE — no recorre automáticamente otras páginas).
    const rows = Array.from(tbody.querySelectorAll('tr'));

    // Comparación puramente local, dentro de esta misma lista: si el mismo
    // N° de expediente aparece en más de una fila visible (varias
    // notificaciones del mismo caso), se marca — no depende de backend ni
    // de lo que ya esté sincronizado, solo de lo que SINOE está mostrando
    // ahora mismo en pantalla.
    const conteoPorExpediente = {};
    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 9) return;
      const numeroExpediente = (cells[4]?.textContent || '').trim();
      if (!numeroExpediente) return;
      conteoPorExpediente[numeroExpediente] = (conteoPorExpediente[numeroExpediente] || 0) + 1;
    });

    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 9) return;

      const expediente = {
        numeroNotificacion: (cells[3]?.textContent || '').trim(),
        numeroExpediente: (cells[4]?.textContent || '').trim(),
        sumilla: (cells[5]?.querySelector('textarea')?.value || '').trim(),
        juzgado: (cells[6]?.textContent || '').trim(),
        fecha: (cells[7]?.textContent || '').trim(),
      };

      pintarDistintivoRepetido(cells[4], conteoPorExpediente[expediente.numeroExpediente] > 1);

      function pintarEstadoActual(btn) {
        const estado = yaSincronizados.has(expediente.numeroNotificacion)
          ? 'sincronizado'
          : yaAgregados.has(expediente.numeroNotificacion)
          ? 'agregado'
          : 'activo';

        // Si el estado no cambió, no se toca el DOM. Sin esto, cada
        // repintado (aunque sea idéntico al anterior) dispararía una
        // mutación, que dispararía al MutationObserver de más abajo, que
        // volvería a repintar — un loop que se alimenta de sí mismo.
        if (btn.dataset.estado === estado) return;

        if (estado === 'sincronizado') {
          marcarComoSincronizado(btn);
        } else if (estado === 'agregado') {
          marcarComoAgregado(btn);
        } else {
          pintarBoton(
            btn,
            'activo',
            'Agregar',
            ICONO_AGREGAR,
            'Agregar a la lista de pendientes en Okumet Document Access'
          );
        }
      }

      // Si el botón ya existe en esta fila, solo se repinta su estado
      // (ej. de "Agregado" a "Sincronizado" cuando el popup termina de
      // subirlo) — no se vuelve a crear ni a enganchar un segundo listener.
      const existente = row.querySelector('.okumet-sync-btn');
      if (existente) {
        pintarEstadoActual(existente);
        return;
      }

      const lastCell = cells[cells.length - 1];

      // La columna donde vive "Ver anexos" es muy angosta (6% del ancho de
      // la tabla) — poner el botón nuevo al lado (margin-left) lo apretaba
      // contra el otro botón. Va en su propia línea, debajo, con margen
      // arriba para separarlo visualmente.
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'okumet-sync-btn';

      pintarEstadoActual(btn);

      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.innerHTML = `${ICONO_RELOJ}<span>…</span>`;

        const { okumetPendingExpedientes: listaActualizada } =
          await chrome.storage.local.get('okumetPendingExpedientes');
        const lista = Array.isArray(listaActualizada) ? listaActualizada : [];
        const yaEsta = lista.some((item) => item.numeroNotificacion === expediente.numeroNotificacion);
        const actualizada = yaEsta ? lista : [...lista, expediente];

        await chrome.storage.local.set({ okumetPendingExpedientes: actualizada });

        marcarComoAgregado(btn);
      });

      lastCell.appendChild(btn);
    });
  }

  async function aplicarEstadoSegunValidacion() {
    const { okumetIdentityState } = await chrome.storage.local.get('okumetIdentityState');
    const validado = Boolean(okumetIdentityState && okumetIdentityState.status === 'ok');

    if (!validado) {
      quitarBotones();
      return;
    }

    await inyectarBotones();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.okumetIdentityState || changes.okumetPendingExpedientes || changes.okumetSyncedExpedientes) {
      aplicarEstadoSegunValidacion();
    }
  });

  // SINOE reemplaza la tabla completa por AJAX en varios casos (cerrar el
  // modal de anexos, buscar, etc.) — eso se lleva los botones ya inyectados
  // junto con el DOM viejo. En vez de perseguir cada caso puntual, se
  // observa el documento entero y se reaplica cada vez que algo cambia.
  // Con "debounce" para no reaccionar decenas de veces seguidas cuando
  // SINOE reemplaza muchos nodos de golpe (incluida nuestra propia
  // inyección, que también es un cambio del DOM). El chequeo de
  // "dataset.estado" en pintarEstadoActual es el que de verdad evita que
  // esto se retriggeree sobre sí mismo sin parar — sin él, repintar un
  // botón sin cambios generaría una mutación, que dispararía este mismo
  // observer otra vez, indefinidamente.
  let debounceId = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceId);
    debounceId = setTimeout(aplicarEstadoSegunValidacion, 250);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  aplicarEstadoSegunValidacion();
})();
