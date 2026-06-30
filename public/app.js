/* PWA del padre — conecta al servidor relay y controla el PC del hijo */

const $ = (id) => document.getElementById(id);

let ws = null;
let liveTimer = null;
let agentOnline = false;

// El servidor relay es el mismo que sirve esta pagina.
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

// ---------- Persistencia simple ----------
const saved = {
  room: localStorage.getItem('cp_room') || '',
  name: localStorage.getItem('cp_name') || '',
};

// ---------- UI helpers ----------
function showToast(text, ms = 2500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function setPresence(online, name) {
  agentOnline = online;
  $('dot').className = 'dot ' + (online ? 'online' : 'offline');
  $('status-text').textContent = online
    ? `${name || 'PC'} conectado`
    : 'PC desconectado';
}

function goMain() {
  $('connect-screen').classList.add('hidden');
  $('main-screen').classList.remove('hidden');
}
function goConnect() {
  $('main-screen').classList.add('hidden');
  $('connect-screen').classList.remove('hidden');
}

// ---------- WebSocket ----------
function connect(room, name) {
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'register', role: 'parent', room, name }));
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'registered':
        goMain();
        showToast('Conectado al servidor');
        break;
      case 'presence':
        setPresence(msg.agentOnline, msg.agentName);
        break;
      case 'screenshot': {
        const img = $('screenshot');
        img.src = 'data:image/jpeg;base64,' + msg.data;
        img.style.display = 'block';
        $('screen-placeholder').style.display = 'none';
        break;
      }
      case 'ack':
        if (msg.message) showToast(msg.message);
        break;
      case 'error':
        showToast('⚠️ ' + (msg.message || 'Error'));
        break;
    }
  };

  ws.onclose = () => {
    setPresence(false);
    showToast('Sin conexión, reintentando…');
    // Reconexión automática si seguimos en la pantalla principal
    if (!$('main-screen').classList.contains('hidden')) {
      setTimeout(() => connect(room, name), 3000);
    }
  };

  ws.onerror = () => {};
}

function sendCommand(action, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Sin conexión con el servidor');
    return;
  }
  if (!agentOnline) {
    showToast('El PC no está encendido o conectado');
    return;
  }
  ws.send(JSON.stringify({ type: 'command', action, payload }));
}

// ---------- Modo en vivo (captura periódica) ----------
function toggleLive() {
  const btn = $('btn-live');
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
    btn.classList.remove('live-on');
    showToast('Modo en vivo detenido');
  } else {
    sendCommand('screenshot');
    liveTimer = setInterval(() => sendCommand('screenshot'), 2000);
    btn.classList.add('live-on');
    showToast('Modo en vivo activado');
  }
}

// ---------- Eventos UI ----------
$('btn-connect').onclick = () => {
  const room = $('room').value.trim().toUpperCase();
  const name = $('parentName').value.trim();
  if (room.length < 4) {
    $('connect-error').textContent = 'El código debe tener al menos 4 caracteres.';
    return;
  }
  localStorage.setItem('cp_room', room);
  localStorage.setItem('cp_name', name);
  $('connect-error').textContent = '';
  connect(room, name);
};

$('btn-disconnect').onclick = () => {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  goConnect();
};

$('btn-view').onclick = () => { sendCommand('screenshot'); showToast('Capturando…'); };
$('btn-live').onclick = toggleLive;

$('btn-message').onclick = () => {
  const text = prompt('Mensaje para mostrar en el PC:');
  if (text && text.trim()) {
    sendCommand('message', { text: text.trim() });
    showToast('Mensaje enviado');
  }
};

$('btn-lock').onclick = () => {
  if (confirm('¿Bloquear la sesión del PC? Tu hijo verá la pantalla de bloqueo de Windows.')) {
    sendCommand('lock');
    showToast('Bloqueando PC…');
  }
};

$('btn-shutdown').onclick = () => {
  if (confirm('¿APAGAR el PC ahora? Se cerrará en pocos segundos.')) {
    sendCommand('shutdown');
    showToast('Apagando PC…');
  }
};

// ---------- Autoarranque ----------
$('room').value = saved.room;
$('parentName').value = saved.name;
if (saved.room) {
  // Conexión automática si ya se usó antes
  connect(saved.room, saved.name);
}

// Registrar service worker (para que sea instalable como app)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
