/* Client temps réel minimal pour la version Cloudflare : même interface que Socket.io
   (io({ auth }), socket.on(événement, fn), socket.emit(événement, données)), sur un WebSocket natif.
   Reconnexion automatique ; les pages n'ont rien à changer. */
(function () {
  window.io = function io(options) {
    const auth = (options && options.auth) || {};
    const gestionnaires = {};
    const enAttente = [];
    let ws = null;
    let delai = 1000;

    function declencher(e, d) { (gestionnaires[e] || []).forEach((f) => { try { f(d); } catch (err) { console.error(err); } }); }

    function connecter() {
      const q = new URLSearchParams();
      if (auth.token) q.set('token', auth.token);
      if (auth.suivi) q.set('suivi', [].concat(auth.suivi).join(','));
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
      ws.onopen = () => {
        delai = 1000;
        while (enAttente.length) ws.send(enAttente.shift());
        declencher('connect');
      };
      ws.onmessage = (m) => {
        try { const { e, d } = JSON.parse(m.data); declencher(e, d); } catch { /* message illisible */ }
      };
      ws.onclose = () => {
        declencher('disconnect');
        setTimeout(connecter, delai + Math.random() * 1000);
        delai = Math.min(delai * 2, 30000);
      };
      ws.onerror = () => declencher('connect_error');
    }
    connecter();

    return {
      on(e, f) { (gestionnaires[e] = gestionnaires[e] || []).push(f); return this; },
      emit(e, d) {
        const msg = JSON.stringify({ e, d });
        if (ws && ws.readyState === 1) ws.send(msg); else enAttente.push(msg);
        return this;
      },
    };
  };
}());
