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
  const ESTILO_ACTIVO =
    'display:block;margin:8px auto 0;background:#f5a623;color:#0f2744;border:none;' +
    'border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer;' +
    'white-space:nowrap;';

  // "Opaco con letra blanca" para que se note que esta fila ya está en la
  // lista de pendientes — distinto del botón activo (ámbar).
  const ESTILO_AGREGADO =
    'display:block;margin:8px auto 0;background:rgba(15,39,68,0.55);color:#fff;border:none;' +
    'border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:default;' +
    'white-space:nowrap;';

  const ESTILO_SINCRONIZADO =
    'display:block;margin:8px auto 0;background:rgba(22,163,74,0.75);color:#fff;border:none;' +
    'border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:default;' +
    'white-space:nowrap;';

  function marcarComoAgregado(btn) {
    btn.disabled = true;
    btn.textContent = '✓ Agregado';
    btn.style.cssText = ESTILO_AGREGADO;
  }

  function marcarComoSincronizado(btn) {
    btn.disabled = true;
    btn.textContent = '✓ Sincronizado';
    btn.style.cssText = ESTILO_SINCRONIZADO;
  }

  function quitarBotones() {
    document.querySelectorAll('.okumet-sync-btn').forEach((btn) => btn.remove());
  }

  async function inyectarBotones() {
    const tbody = document.getElementById('frmBusqueda:tblLista_data');
    if (!tbody) return;

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
        btn.dataset.estado = estado;

        if (estado === 'sincronizado') {
          marcarComoSincronizado(btn);
        } else if (estado === 'agregado') {
          marcarComoAgregado(btn);
        } else {
          btn.disabled = false;
          btn.textContent = 'Agregar';
          btn.style.cssText = ESTILO_ACTIVO;
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
      btn.title = 'Agregar a la lista de pendientes en Okumet Document Access';

      pintarEstadoActual(btn);

      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.textContent = '…';

        const { okumetPendingExpedientes: listaActualizada } =
          await chrome.storage.local.get('okumetPendingExpedientes');
        const lista = Array.isArray(listaActualizada) ? listaActualizada : [];
        const yaEsta = lista.some((item) => item.numeroNotificacion === expediente.numeroNotificacion);
        const actualizada = yaEsta ? lista : [...lista, expediente];

        await chrome.storage.local.set({ okumetPendingExpedientes: actualizada });

        btn.dataset.estado = 'agregado';
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
