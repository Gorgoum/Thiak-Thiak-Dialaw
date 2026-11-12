// Temps réel : un Durable Object garde les connexions WebSocket et les « salles »
// (user:<id>, livreurs, admins, suivi:<code>, position:<code>). Remplace Socket.io.
// Protocole : messages JSON { e: événement, d: données }, identique au petit client /socket.io/socket.io.js.

export class Diffusion {
  constructor(state) {
    this.state = state;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/connecter') {
      const salles = JSON.parse(url.searchParams.get('salles') || '[]');
      const paire = new WebSocketPair();
      this.state.acceptWebSocket(paire[1]); // API « hibernation » : pas de coût quand personne ne parle
      paire[1].serializeAttachment({ salles });
      return new Response(null, { status: 101, webSocket: paire[0] });
    }
    if (url.pathname === '/diffuser' && req.method === 'POST') {
      const { salles, e, d } = await req.json();
      const message = JSON.stringify({ e, d });
      for (const ws of this.state.getWebSockets()) {
        const a = ws.deserializeAttachment() || { salles: [] };
        if (a.salles.some((s) => salles.includes(s))) { try { ws.send(message); } catch { /* connexion fermée */ } }
      }
      return new Response('ok');
    }
    return new Response('introuvable', { status: 404 });
  }

  // Le client peut rejoindre une salle de suivi (code secret) ou d'attente de position
  webSocketMessage(ws, brut) {
    let m;
    try { m = JSON.parse(brut); } catch { return; }
    const prefixes = { suivre: 'suivi:', 'attendre-position': 'position:' };
    if (!prefixes[m.e] || typeof m.d !== 'string' || m.d.length > 64) return;
    const a = ws.deserializeAttachment() || { salles: [] };
    const salle = prefixes[m.e] + m.d;
    if (!a.salles.includes(salle) && a.salles.length < 60) {
      a.salles.push(salle);
      ws.serializeAttachment(a);
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code, 'fin'); } catch { /* déjà fermée */ }
  }
}

/** Côté Worker : l'équivalent de « io.to(salles).emit(événement, données) ». */
export function creerIo(env, attendre) {
  const stub = () => env.DIFFUSION.get(env.DIFFUSION.idFromName('global'));
  return {
    to(salles) {
      const liste = [].concat(salles);
      return {
        emit(e, d) {
          attendre(stub().fetch('https://diffusion/diffuser', {
            method: 'POST', body: JSON.stringify({ salles: liste, e, d: d === undefined ? null : d }),
          }).catch((err) => console.error('Diffusion :', err.message)));
        },
      };
    },
    stub,
  };
}
