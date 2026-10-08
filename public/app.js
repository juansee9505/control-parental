/* PWA del padre — conecta al servidor relay y controla el PC del hijo */

const $ = (id) => document.getElementById(id);

let ws = null;
let agentOnline = false;
let wantConnected = false;   // false tras pulsar "Salir" o ante un error fatal
let reconnectTimer = null;
let reconnectDelay = 1000;   // espera creciente: 1s, 2s, 4s... hasta 30s
const MAX_RECONNECT_DELAY = 30000;

// Modo en vivo: se pide la siguiente captura solo cuando llega la anterior
const LIVE_INTERVAL_MS = 2000;
const LIVE_TIMEOUT_MS = 10000;
let liveOn = false;
let liveTimer = null;

// El servidor relay es el mismo que sirve esta pagina.
function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

// ---------- Persistencia simple ----------
function load(key) {
  try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function store(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

const saved = {
  room: load('cp_room'),
  name: load('cp_name'),
  token: load('cp_token'),
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
  if (!online) stopLive(false);
}

function goMain() {
  $('connect-screen').classList.add('hidden');
  $('main-screen').classList.remove('hidden');
}
function goConnect(errorText = '') {
  $('main-screen').classList.add('hidden');
  $('connect-screen').classList.remove('hidden');
  $('connect-error').textContent = errorText;
}

// ---------- WebSocket ----------
function closeSocket() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch {}
    ws = null;
  }
}

function connect(room, name, token) {
  closeSocket(); // nunca mas de un socket abierto
  wantConnected = true;

  const sock = new WebSocket(wsUrl());
  ws = sock;

  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'register', role: 'parent', room, name, token }));
  };

  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.type) {
      case 'registered':
        reconnectDelay = 1000;
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
        if (liveOn) scheduleLive(LIVE_INTERVAL_MS);
        break;
      }
      case 'ack':
        if (msg.message) showToast(msg.message);
        break;
      case 'error':
        // Errores que no se arreglan reintentando: volver a la pantalla de conexion
        if (msg.code === 'bad_token' || msg.code === 'bad_room' || msg.code === 'rate_limited') {
          wantConnected = false;
          stopLive(false);
          closeSocket();
          goConnect(msg.message || 'Error');
        } else {
          showToast('⚠️ ' + (msg.message || 'Error'));
        }
        break;
    }
  };

  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    setPresence(false);
    if (!wantConnected) return;
    showToast('Sin conexión, reintentando…');
    reconnectTimer = setTimeout(() => connect(room, name, token), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };

  sock.onerror = () => {};
}

function sendCommand(action, payload = {}, quiet = false) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (!quiet) showToast('Sin conexión con el servidor');
    return false;
  }
  if (!agentOnline) {
    if (!quiet) showToast('El PC no está encendido o conectado');
    return false;
  }
  ws.send(JSON.stringify({ type: 'command', action, payload }));
  return true;
}

// ---------- Modo en vivo (captura periódica) ----------
function scheduleLive(delay) {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(requestLiveFrame, delay);
}

function requestLiveFrame() {
  if (!liveOn) return;
  if (!sendCommand('screenshot', {}, true)) {
    stopLive(true);
    return;
  }
  // Si la captura no llega a tiempo, se vuelve a pedir
  scheduleLive(LIVE_TIMEOUT_MS);
}

function stopLive(notify) {
  if (!liveOn) return;
  liveOn = false;
  clearTimeout(liveTimer);
  liveTimer = null;
  $('btn-live').classList.remove('live-on');
  if (notify) showToast('Modo en vivo detenido');
}

function toggleLive() {
  if (liveOn) {
    stopLive(true);
    return;
  }
  if (!sendCommand('screenshot')) return;
  liveOn = true;
  scheduleLive(LIVE_TIMEOUT_MS);
  $('btn-live').classList.add('live-on');
  showToast('Modo en vivo activado');
}

// ---------- Eventos UI ----------
$('btn-connect').onclick = () => {
  const room = $('room').value.trim().toUpperCase();
  const name = $('parentName').value.trim();
  const token = $('token').value.trim();
  if (room.length < 4) {
    $('connect-error').textContent = 'El código debe tener al menos 4 caracteres.';
    return;
  }
  store('cp_room', room);
  store('cp_name', name);
  store('cp_token', token);
  $('connect-error').textContent = '';
  reconnectDelay = 1000;
  connect(room, name, token);
};

$('btn-disconnect').onclick = () => {
  wantConnected = false;
  stopLive(false);
  closeSocket();
  setPresence(false);
  goConnect();
};

$('btn-view').onclick = () => {
  if (sendCommand('screenshot')) showToast('Capturando…');
};
$('btn-live').onclick = toggleLive;

$('btn-message').onclick = () => {
  const text = prompt('Mensaje para mostrar en el PC:');
  if (text && text.trim() && sendCommand('message', { text: text.trim() })) {
    showToast('Mensaje enviado');
  }
};

$('btn-lock').onclick = () => {
  if (confirm('¿Bloquear la sesión del PC? Tu hijo verá la pantalla de bloqueo de Windows.')) {
    if (sendCommand('lock')) showToast('Bloqueando PC…');
  }
};

$('btn-shutdown').onclick = () => {
  if (confirm('¿APAGAR el PC ahora? Se cerrará en pocos segundos.')) {
    if (sendCommand('shutdown')) showToast('Apagando PC…');
  }
};

// ---------- Autoarranque ----------
$('room').value = saved.room;
$('parentName').value = saved.name;
$('token').value = saved.token;
if (saved.room) {
  // Conexión automática si ya se usó antes
  connect(saved.room, saved.name, saved.token);
}

// Registrar service worker (para que sea instalable como app)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
