// Si el navegador soporta Side Panel (Chrome 114+, algunos Chromium recientes),
// lo usamos como vista principal. Si no existe el namespace chrome.sidePanel,
// no tocamos nada y el action.default_popup del manifest sigue funcionando
// como fallback normal.

function enableSidePanel() {
  if (!chrome.sidePanel) return;

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

  // Desactiva el popup para que el click del ícono dispare el side panel
  // en vez de abrir la ventana flotante clásica.
  chrome.action.setPopup({ popup: '' }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enableSidePanel);
chrome.runtime.onStartup.addListener(enableSidePanel);
enableSidePanel();
