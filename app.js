// app.js — o Escritório no iPhone. Lê o estado cifrado do GitHub, decifra NO
// APARELHO e devolve decisões assinadas. Nada em claro atravessa a rede.
//
// O QUE ESTE APP NÃO SABE: nada sobre o Rangel. Dono, repositório e token são
// digitados no aparelho e ficam no aparelho. Por isso a página pode ser pública
// sem revelar de quem é o escritório.
import * as cofre from './cofre.js';

const CFG = 'escritorio.cfg';         // {dono, repo, token} — fica no aparelho
const TRAVA = 'escritorio.trava';     // {erros, ate} — sobrevive a recarregar
const LIMITE_ERROS = 5;               // decisão do Rangel, 22/09
const ESPERAS_S = [60, 300, 1800];    // 1min, 5min, 30min — nunca trava de vez
const VALIDADE_S = 900;               // decisão do Rangel, 22/09: 15 min
const OCIOSO_MS = 15 * 60 * 1000;     // a chave some da memória depois disso

let chaves = null;      // {cifra, assina} — SÓ em memória, nunca no disco
let estado = null;      // último snapshot decifrado
let ocioso = null;

const $ = (s) => document.querySelector(s);
const minutos = (ms) => {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.ceil(s / 60)} min`;
};
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const lido = (k, p = null) => { try { return JSON.parse(localStorage.getItem(k)) ?? p; } catch { return p; } };

// ── GitHub ────────────────────────────────────────────────────────────────
async function gh(caminho, opcoes = {}) {
  const c = lido(CFG);
  const r = await fetch(`https://api.github.com/repos/${c.dono}/${c.repo}/${caminho}`, {
    ...opcoes,
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', ...opcoes.headers },
  });
  if (!r.ok) {
    const m = await r.json().catch(() => ({}));
    throw new Error(`GitHub ${r.status} — ${m.message || 'sem detalhe'}`);
  }
  return r.json();
}

async function baixar(arquivo, ramo) {
  // cache:'no-store' é essencial: o estado.json muda de minuto em minuto e uma
  // resposta guardada faria o app estampar uma foto velha sem avisar ninguém.
  const d = await gh(`contents/${arquivo}?ref=${ramo}&t=${Date.now()}`, { cache: 'no-store' });
  return JSON.parse(atob(d.content.replace(/\n/g, '')));
}

// ── trava por tentativas ──────────────────────────────────────────────────
function travadoAte() {
  const t = lido(TRAVA, { erros: 0, ate: 0 });
  return t.ate > Date.now() ? t.ate : 0;
}

function contarErro() {
  const t = lido(TRAVA, { erros: 0, ate: 0 });
  t.erros += 1;
  if (t.erros > LIMITE_ERROS) {
    const i = Math.min(t.erros - LIMITE_ERROS - 1, ESPERAS_S.length - 1);
    t.ate = Date.now() + ESPERAS_S[i] * 1000;
  }
  guardar(TRAVA, t);
  return t;
}

const zerarTrava = () => guardar(TRAVA, { erros: 0, ate: 0 });

// ── sessão ────────────────────────────────────────────────────────────────
function adiarTrancamento() {
  clearTimeout(ocioso);
  ocioso = setTimeout(trancar, OCIOSO_MS);
}

function trancar() {
  chaves = null;            // a chave existe só enquanto o app está em uso
  estado = null;
  mostrar('trava');
}

function mostrar(tela) {
  for (const t of ['config', 'trava', 'painel']) $('#' + t).hidden = t !== tela;
}

// ── abrir ─────────────────────────────────────────────────────────────────
async function abrir(senha) {
  const ate = travadoAte();
  if (ate) {
    // Marcado como `espera` pra NÃO virar mais um erro lá no handler: tocar em
    // "abrir" durante a espera não testou senha nenhuma. Sem esta marca, quem
    // fica tentando empurra a própria espera pra frente e nunca sai dela.
    const e = new Error(`espere ${minutos(ate - Date.now())} — tentativas erradas demais`);
    e.espera = true;
    throw e;
  }
  const sal = await baixar('sal.json', 'estado');
  const k = await cofre.derivar(senha, cofre.deb64(sal.sal), sal.iter);
  const env = await baixar('estado.json', 'estado');
  // Se a senha estiver errada, é AQUI que estoura: o GCM recusa, não devolve lixo.
  // MAS ele estoura com mensagem VAZIA (o WebCrypto não conta o motivo, de
  // propósito). Sem esta linha, a falha mais comum seria a que menos explica.
  let snap;
  try {
    snap = await cofre.decifrar(env, k.cifra, cofre.AAD_ESTADO);
  } catch (e) {
    throw new Error(e.message || 'senha errada');
  }
  chaves = k;
  estado = snap;
  zerarTrava();
  adiarTrancamento();
  return snap;
}

// ── decidir ───────────────────────────────────────────────────────────────
async function decidir(acao, ids, motivo = '') {
  const id = crypto.randomUUID();
  const agora = Math.floor(Date.now() / 1000);
  // `id` de uso único e `vale_ate` são o par que impede repetição: o Mac recusa
  // id já visto E recusa decisão vencida. Sem os dois, um arquivo capturado
  // poderia ser reenviado depois e aplicado de novo.
  const corpo = { id, acao, ids, motivo, feito_em: agora, vale_ate: agora + VALIDADE_S, de: 'iphone' };
  const env = await cofre.cifrar(corpo, chaves.cifra, cofre.AAD_DECISAO);
  env.hmac = await cofre.assinar(env, chaves.assina);
  await gh(`contents/decisoes/${id}.json`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `decisão do iPhone — ${acao}`,
      content: cofre.b64(new TextEncoder().encode(JSON.stringify(env))),
      branch: 'decisoes',
    }),
  });
  return id;
}

// ── tela ──────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function pintar() {
  const e = estado.escritorio || {};
  const pendentes = (estado.acoes || []).filter((a) => a.estado === 'simulada');
  const acesos = (e.alarmes && e.alarmes.acesos) || [];
  const idade = Math.round((Date.now() / 1000 - (estado.publicado_em || 0)) / 60);

  $('#idade').textContent = `foto de ${idade} min atrás`;
  $('#idade').className = idade > 10 ? 'idade velha' : 'idade';

  $('#resumo').innerHTML = [
    ['sessões', (estado.sessoes || []).length],
    ['agentes', (estado.capacidades || []).length],
    ['alarmes', acesos.length],
    ['na fila', pendentes.length],
  ].map(([r, n]) => `<div class="cartao"><b>${n}</b><span>${r}</span></div>`).join('');

  $('#alarmes').innerHTML = acesos.length
    ? acesos.map((a) => `<div class="alarme"><b>${esc(a.id)}</b><p>${esc(a.texto)}</p>
        <small>aceso há ${esc(a.idade_h)}h · nível ${esc(a.nivel)}</small></div>`).join('')
    : '<p class="vazio">nenhum alarme aceso</p>';

  $('#fila').innerHTML = pendentes.length
    ? pendentes.map((a) => `<div class="acao" data-id="${esc(a.id)}">
        <b>${esc(a.titulo)}</b>
        <p>${esc(a.tarefa)}</p>
        <dl><dt>se aprovar</dt><dd>${esc(a.simulado) || '—'}</dd>
            <dt>pra desfazer</dt><dd>${esc(a.reversao) || '—'}</dd></dl>
        <small>${esc(a.autor)} · ${esc(a.cargo)} · ${esc(a.quando)}</small>
        <div class="botoes">
          <button class="sim" data-acao="aprovar">aprovar</button>
          <button class="nao" data-acao="rejeitar">rejeitar</button>
        </div></div>`).join('')
    : '<p class="vazio">nada esperando decisão</p>';
}

function aviso(txt, tipo = '') {
  $('#aviso').textContent = txt;
  $('#aviso').className = 'aviso ' + tipo;
}

// ── amarração ─────────────────────────────────────────────────────────────
addEventListener('DOMContentLoaded', () => {
  mostrar(lido(CFG) ? 'trava' : 'config');

  $('#form-config').addEventListener('submit', (ev) => {
    ev.preventDefault();
    guardar(CFG, { dono: $('#dono').value.trim(), repo: $('#repo').value.trim(), token: $('#token').value.trim() });
    zerarTrava();   // saída de emergência de uma espera longa: custa redigitar o token

    $('#token').value = '';
    mostrar('trava');
  });

  $('#form-trava').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const campo = $('#senha');
    aviso('abrindo…');
    try {
      await abrir(campo.value);
      campo.value = '';
      pintar();
      mostrar('painel');
      aviso('');
    } catch (err) {
      campo.value = '';
      if (err.espera) return aviso(err.message, 'ruim');   // não testou senha: não conta
      const t = contarErro();
      const restam = LIMITE_ERROS - t.erros;
      aviso(restam > 0 ? `${err.message} — ${restam} tentativa(s) antes da espera`
                       : err.message, 'ruim');
    }
  });

  $('#fila').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-acao]');
    if (!b) return;
    const cartao = b.closest('.acao');
    const acao = b.dataset.acao;
    let motivo = '';
    if (acao === 'rejeitar') {
      motivo = prompt('motivo da rejeição (o Mac registra isso):') ?? '';
      if (motivo === '') return;
    }
    adiarTrancamento();
    cartao.querySelectorAll('button').forEach((x) => (x.disabled = true));
    try {
      await decidir(acao, [cartao.dataset.id], motivo);
      cartao.classList.add('enviada');
      aviso(`${acao} enviada — o Mac aplica em até 1 min (vale por 15)`, 'bom');
    } catch (err) {
      cartao.querySelectorAll('button').forEach((x) => (x.disabled = false));
      aviso('não consegui enviar: ' + err.message, 'ruim');
    }
  });

  $('#recarregar').addEventListener('click', async () => {
    if (!chaves) return trancar();
    adiarTrancamento();
    aviso('buscando…');
    try {
      estado = await cofre.decifrar(await baixar('estado.json', 'estado'), chaves.cifra, cofre.AAD_ESTADO);
      pintar();
      aviso('');
    } catch (err) { aviso(err.message, 'ruim'); }
  });

  $('#trancar').addEventListener('click', trancar);
  $('#reconfigurar').addEventListener('click', () => mostrar('config'));
  for (const ev of ['click', 'keydown']) addEventListener(ev, () => chaves && adiarTrancamento());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
});
