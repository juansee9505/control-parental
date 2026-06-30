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
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// Token compartido opcional (capa extra de seguridad). Se define como
// variable de entorno en el hosting. Si no se define, se omite la validacion.
const SHARED_TOKEN = process.env.SHARED_TOKEN || '';

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

wss.on('connection', (ws) => {
  ws.role = null;
  ws.room = null;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignorar basura
    }

    // --- Registro / emparejamiento ---
    if (msg.type === 'register') {
      if (SHARED_TOKEN && msg.token !== SHARED_TOKEN) {
        send(ws, { type: 'error', message: 'Token invalido' });
        ws.close();
        return;
      }
      const code = String(msg.room || '').trim().toUpperCase();
      if (!code) {
        send(ws, { type: 'error', message: 'Falta el codigo de familia' });
        return;
      }
      const room = getRoom(code);
      ws.room = code;
      ws.role = msg.role === 'agent' ? 'agent' : 'parent';

      if (ws.role === 'agent') {
        // Solo un agente por sala. Si llega otro, reemplaza al anterior.
        if (room.agent && room.agent !== ws) {
          send(room.agent, { type: 'error', message: 'Reemplazado por otra sesion' });
          try { room.agent.close(); } catch {}
        }
        room.agent = ws;
        room.agentName = msg.name || 'PC';
        send(ws, { type: 'registered', role: 'agent', room: code });
      } else {
        room.parents.add(ws);
        send(ws, { type: 'registered', role: 'parent', room: code });
      }
      notifyPresence(room);
      return;
    }

    if (!ws.room) return; // no registrado -> ignorar
    const room = rooms.get(ws.room);
    if (!room) return;

    // --- Reenvio de mensajes ---
    if (ws.role === 'parent') {
      // El padre envia comandos -> al agente
      if (msg.type === 'command') {
        if (!room.agent) {
          send(ws, { type: 'error', message: 'El PC no esta conectado' });
        } else {
          send(room.agent, msg);
        }
      }
    } else if (ws.role === 'agent') {
      // El agente envia pantalla / estado -> a los padres
      if (msg.type === 'screenshot' || msg.type === 'status' || msg.type === 'ack') {
        broadcastToParents(room, msg);
      }
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const room = rooms.get(ws.room);
    if (!room) return;
    if (ws.role === 'agent' && room.agent === ws) {
      room.agent = null;
      room.agentName = '';
      notifyPresence(room);
    } else if (ws.role === 'parent') {
      room.parents.delete(ws);
    }
    // Limpiar salas vacias
    if (!room.agent && room.parents.size === 0) {
      rooms.delete(ws.room);
    }
  });
});

// Keep-alive: cierra conexiones muertas (importante en hostings gratis)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`Servidor de Control Parental escuchando en puerto ${PORT}`);
});
