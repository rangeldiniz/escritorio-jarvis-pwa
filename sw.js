// sw.js — guarda SÓ a casca do app (html, js, ícone) pra ele abrir offline.
//
// ⚠️ O QUE ESTE SERVICE WORKER NUNCA GUARDA: nada de api.github.com. O estado
// muda de minuto em minuto, e uma resposta guardada faria o app estampar uma
// foto velha como se fosse de agora — que é exatamente o defeito que o campo
// "foto de X min atrás" existe pra denunciar. Dado sempre vem da rede.
// ⚠️ SUBIR ESTE NÚMERO A CADA MUDANÇA EM app.js / cofre.js / index.html.
// O `activate` apaga todo cache com nome diferente — é isso que faz o app já
// instalado no iPhone largar a versão velha. Sem subir, ele serve o arquivo
// antigo para sempre e a correção nunca chega no aparelho.
const CASCA = 'escritorio-casca-v3';
const ARQUIVOS = ['./', 'index.html', 'app.js', 'cofre.js', 'manifest.webmanifest',
                  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CASCA).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ns) => Promise.all(ns.filter((n) => n !== CASCA).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;   // GitHub passa direto, sempre
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
