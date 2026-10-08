/**
 * Servidor relay de Control Parental
 * --------------------------------------------------------------
 * - Sirve la PWA del padre (carpeta /public) por HTTP.
 * - Mantiene una conexion WebSocket con el AGENTE (PC del hijo) y
 *   con el/los PADRE(s) (la PWA en el celular).
 * - Empareja a ambos por un "codigo de familia" (room) y reenvia
 *   mensajes entre ellos. No guarda nada en disco.
 *
 * Protocolo (mensajes JSON):
 *   { type:"register", role:"agent"|"parent", room:"ABC123", token:"...", name:"..." }
 *   { type:"command",  action:"screenshot"|"shutdown"|"message"|"lock", payload:{...} }
 *   { type:"screenshot", data:"<base64 jpeg>" }
 *   { type:"status", ... }
 *   { type:"presence", agentOnline:true|false }
 */

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Token compartido (capa extra de seguridad). Se define como variable de
// entorno en el hosting y se pone el MISMO valor en el agente y en la PWA.
// Si no se define, cualquiera que adivine el codigo de familia tiene acceso.
const SHARED_TOKEN = process.env.SHARED_TOKEN || '';
if (!SHARED_TOKEN) {
  console.warn('AVISO: SHARED_TOKEN no esta definido. El codigo de familia es la unica proteccion.');
}

const MIN_ROOM_LENGTH = 4;
const MAX_ROOM_LENGTH = 32;
const MAX_NAME_LENGTH = 40;
const MAX_PAYLOAD = 10 * 1024 * 1024; // 10 MB: suficiente para una captura JPEG
const ALLOWED_ACTIONS = new Set(['screenshot', 'shutdown', 'message', 'lock']);

// Limite de intentos de registro por IP (evita probar codigos a fuerza bruta)
const REGISTER_WINDOW_MS = 60 * 1000;
const MAX_REGISTERS_PER_WINDOW = 10;
const registerAttempts = new Map(); // ip -> { count, resetAt }

function tooManyAttempts(ip) {
  const now = Date.now();
  let entry = registerAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + REGISTER_WINDOW_MS };
    registerAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count > MAX_REGISTERS_PER_WINDOW;
}

function tokenMatches(token) {
  if (!SHARED_TOKEN) return true;
  if (typeof token !== 'string') return false;
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(SHARED_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  // Render (y casi todos los hostings) ponen la IP real en X-Forwarded-For
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  // Los navegadores siempre mandan Origin: solo se acepta el de esta misma
  // pagina. El agente (programa de escritorio) normalmente no lo manda.
  verifyClient: ({ origin, req }) => {
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  },
});

/**
 * rooms = {
 *   "ABC123": { agent: ws|null, agentName: "", parents: Set<ws> }
 * }
 */
const rooms = new Map();

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, { agent: null, agentName: '', parents: new Set() });
  }
  return rooms.get(code);
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastToParents(room, obj) {
  for (const p of room.parents) send(p, obj);
}

function notifyPresence(room) {
  broadcastToParents(room, {
    type: 'presence',
    agentOnline: !!room.agent,
    agentName: room.agentName,
  });
}

// Saca un socket de la sala en la que este (al cerrarse o al re-registrarse)
function leaveRoom(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (room) {
    if (ws.role === 'agent' && room.agent === ws) {
      room.agent = null;
      room.agentName = '';
      notifyPresence(room);
    } else if (ws.role === 'parent') {
      room.parents.delete(ws);
    }
    if (!room.agent && room.parents.size === 0) {
      rooms.delete(ws.room);
    }
  }
  ws.room = null;
  ws.role = null;
}

wss.on('connection', (ws, req) => {
  ws.role = null;
  ws.room = null;
  ws.isAlive = true;
  ws.ip = clientIp(req);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignorar basura
    }
    if (!msg || typeof msg !== 'object') return;

    // --- Registro / emparejamiento ---
    if (msg.type === 'register') {
      if (tooManyAttempts(ws.ip)) {
        send(ws, { type: 'error', code: 'rate_limited', message: 'Demasiados intentos, espera un minuto' });
        ws.close();
        return;
      }
      if (!tokenMatches(msg.token)) {
        send(ws, { type: 'error', code: 'bad_token', message: 'Token invalido' });
        ws.close();
        return;
      }
      const code = String(msg.room || '').trim().toUpperCase();
      if (code.length < MIN_ROOM_LENGTH || code.length > MAX_ROOM_LENGTH) {
        send(ws, {
          type: 'error',
          code: 'bad_room',
          message: `El codigo de familia debe tener entre ${MIN_ROOM_LENGTH} y ${MAX_ROOM_LENGTH} caracteres`,
        });
        return;
      }

      // Si ya estaba registrado (en esta u otra sala), salir primero
      leaveRoom(ws);

      const room = getRoom(code);
      ws.room = code;
      ws.role = msg.role === 'agent' ? 'agent' : 'parent';

      if (ws.role === 'agent') {
        // Solo un agente por sala. Si llega otro, reemplaza al anterior.
        if (room.agent && room.agent !== ws) {
          const old = room.agent;
          send(old, { type: 'error', code: 'replaced', message: 'Reemplazado por otra sesion' });
          old.room = null; // evita que su "close" toque la sala
          old.role = null;
          try { old.close(); } catch {}
        }
        room.agent = ws;
        room.agentName = typeof msg.name === 'string' && msg.name.trim()
          ? msg.name.trim().slice(0, MAX_NAME_LENGTH)
          : 'PC';
        send(ws, { type: 'registered', role: 'agent', room: code });
        notifyPresence(room);
      } else {
        room.parents.add(ws);
        send(ws, { type: 'registered', role: 'parent', room: code });
        // Solo a este padre: los demas ya conocen el estado
        send(ws, { type: 'presence', agentOnline: !!room.agent, agentName: room.agentName });
      }
      return;
    }

    if (!ws.room) return; // no registrado -> ignorar
    const room = rooms.get(ws.room);
    if (!room) return;

    // --- Reenvio de mensajes ---
    if (ws.role === 'parent') {
      // El padre envia comandos -> al agente (solo acciones conocidas)
      if (msg.type === 'command') {
        if (!ALLOWED_ACTIONS.has(msg.action)) {
          send(ws, { type: 'error', message: 'Accion no permitida' });
        } else if (!room.agent) {
          send(ws, { type: 'error', message: 'El PC no esta conectado' });
        } else {
          const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
          send(room.agent, { type: 'command', action: msg.action, payload });
        }
      }
    } else if (ws.role === 'agent') {
      // El agente envia pantalla / estado -> a los padres
      if (msg.type === 'screenshot' || msg.type === 'status' || msg.type === 'ack') {
        broadcastToParents(room, msg);
      }
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => {});
});

// Keep-alive: cierra conexiones muertas (importante en hostings gratis)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
  // Limpiar contadores de intentos vencidos
  const now = Date.now();
  for (const [ip, entry] of registerAttempts) {
    if (entry.resetAt <= now) registerAttempts.delete(ip);
  }
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`Servidor de Control Parental escuchando en puerto ${PORT}`);
});
