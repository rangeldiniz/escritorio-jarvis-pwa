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
const CASCA = 'escritorio-casca-v6';
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

// REDE PRIMEIRO, cache como rede de segurança.
//
// Antes era cache primeiro, e isso criou uma armadilha SEM SAÍDA: se a troca do
// service worker falhasse uma vez, o aparelho passava a servir o app velho para
// sempre, e nenhuma correção publicada depois chegava nele. Foi exatamente o que
// prendeu o iPhone do dono na versão de 22/09 por um dia inteiro — inclusive nas
// correções feitas PARA resolver o problema que ele estava enfrentando.
//
// Cache primeiro compra milissegundos. Custou um dia. A ordem certa é a inversa:
// tenta a rede, e só cai no cache quando não há rede — que é o caso em que o
// cache existe para servir.
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;   // GitHub passa direto, sempre
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r && r.ok) {
          const copia = r.clone();
          caches.open(CASCA).then((c) => c.put(e.request, copia)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || Promise.reject(new Error('offline')))),
  );
});
