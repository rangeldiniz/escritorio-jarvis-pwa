// app.js — o Escritório no iPhone. Lê o estado cifrado do GitHub, decifra NO
// APARELHO e devolve decisões assinadas. Nada em claro atravessa a rede.
//
// O QUE ESTE APP NÃO SABE: nada sobre o dono. Dono, repositório e token são
// digitados no aparelho e ficam no aparelho. Por isso a página pode ser pública
// sem revelar de quem é o escritório.
import * as cofre from './cofre.js';

const CFG = 'escritorio.cfg';         // {dono, repo, token} — fica no aparelho
const TRAVA = 'escritorio.trava';     // {erros, ate} — sobrevive a recarregar
const LIMITE_ERROS = 5;               // decisão do dono, 22/09
const ESPERAS_S = [60, 300, 1800];    // 1min, 5min, 30min — nunca trava de vez
const VALIDADE_S = 900;               // decisão do dono, 22/09: 15 min
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
// Tem de subir JUNTO com o CASCA do sw.js. É este carimbo que aparece na tela:
// serve pra responder "o aparelho está rodando o código novo?" com leitura, não fé.
const VERSAO_APP = 'v9';

async function gh(caminho, opcoes = {}) {
  const c = lido(CFG);
  const r = await fetch(`https://api.github.com/repos/${c.dono}/${c.repo}/${caminho}`, {
    ...opcoes,
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', ...opcoes.headers },
  });
  if (!r.ok) {
    const m = await r.json().catch(() => ({}));
    // Marcado como `github` pra NÃO virar tentativa de senha lá no handler: o
    // app nem chegou a testar senha nenhuma, ele não conseguiu BAIXAR o arquivo.
    // Sem esta marca, um token sem permissão aparece como "senha errada" e leva
    // horas de caça no lugar errado — foi o que aconteceu em 22/09.
    const e = new Error(`GitHub ${r.status} — ${m.message || 'sem detalhe'}`);
    e.github = r.status;
    if (r.status === 401) {
      e.dica = 'O token não foi aceito: ou está digitado errado, ou expirou. '
             + 'Toque em "trocar repositório ou token" e cole de novo.';
    }
    // 403 e 404 NÃO são o mesmo defeito, e tratá-los juntos mandou o dono
    // conferir a permissão errada. Um token fine-grained responde 404 — não 403 —
    // para repositório que ele NÃO ENXERGA, de propósito: assim ninguém usa um
    // token para descobrir se um repositório privado existe. Então:
    //   403 = o token VÊ o repositório, mas não tem a permissão certa.
    //   404 = o token NÃO VÊ o repositório (ou o nome abaixo está errado).
    if (r.status === 403) {
      e.dica = 'O token alcança o repositório, mas falta permissão. Em github.com '
             + '→ Settings → Developer settings → Fine-grained tokens, ponha '
             + 'Permissions → Contents em "Read and write" (só Metadata não basta).';
    }
    if (r.status === 404) {
      e.dica = `Este token não enxerga ${c.dono}/${c.repo}. Um token fine-grained `
             + 'responde 404 (e não 403) para repositório fora da lista dele. '
             + 'Confira as DUAS coisas: (1) o nome acima está escrito certo? '
             + '(2) em Repository access, o repositório está selecionado? '
             + 'Toque em "trocar repositório ou token" para corrigir.';
    }
    throw e;
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

// ── organograma (02/11) ───────────────────────────────────────────────────
// Dono → J.A.R.V.I.S. → setor → cadeira (diretor titular) → equipe. A fonte é a
// DIRETORIA.tsv (colunas 4 e 8) e a lista REAL de agentes em ~/.claude/agents.
// Todo agente ganha cadeira: quem não está na tabela aparece no setor que a ficha
// dele declara, marcado "sem cargo" e respondendo ao J.A.R.V.I.S. — o desenho não
// inventa um chefe que a tabela não deu.
const SETOR = {
  comercial: 'Comercial', producao: 'Produção — alunos', conteudo: 'Conteúdo',
  financeiro: 'Financeiro', qualidade: 'Qualidade', conhecimento: 'Conhecimento',
  infra: 'Infraestrutura', mercado: 'Mercado', geral: 'Gabinete do CEO',
};
const ORDEM_SETOR = Object.keys(SETOR);

function cadeira(nome, papel, cls = '') {
  return `<div class="cadeira ${cls}"><i>🪑</i><span><b>${esc(nome)}</b><small>${esc(papel)}</small></span></div>`;
}

function organograma(e) {
  const dir = e.diretoria || [];
  const ags = e.agentes || [];
  if (!dir.length && !ags.length) return '<p class="vazio">SEM LEITURA da diretoria</p>';
  const sentados = new Set();
  const setores = {};
  const setor = (k) => (setores[SETOR[k] ? k : 'geral'] ??= { cargos: [], soltos: [] });

  for (const c of dir) {
    if (c.agente && c.agente !== '-') sentados.add(c.agente);
    for (const x of c.equipe || []) sentados.add(x);
    setor(c.dep).cargos.push(c);
  }
  for (const a of ags) if (!sentados.has(a.nome)) setor(a.dep).soltos.push(a);

  let n = 0;
  const html = ORDEM_SETOR.filter((k) => setores[k]).map((k) => {
    const s = setores[k];
    const cargos = s.cargos.map((c) => {
      const vago = !c.agente || c.agente === '-';
      const st = c.mudo === true ? 'mudo' : c.mudo === false ? 'ok' : '';
      n += vago ? 0 : 1;
      const equipe = (c.equipe || []).map((x) => {
        n++;
        return `<li>${cadeira(x, 'responde a ' + c.agente)}</li>`;
      }).join('');
      return `<li>${cadeira(vago ? 'VAGA' : c.agente, c.nome + ' · responde ao J.A.R.V.I.S.', 'diretor ' + st + (vago ? ' vaga' : ''))}
        ${equipe ? `<ul>${equipe}</ul>` : ''}</li>`;
    }).join('');
    const soltos = s.soltos.map((a) => {
      n++;
      return `<li>${cadeira(a.nome, 'sem cargo na diretoria · responde ao J.A.R.V.I.S.', 'solto')}</li>`;
    }).join('');
    return `<li class="setor"><p class="nome-setor">${esc(SETOR[k])}</p><ul>${cargos}${soltos}</ul></li>`;
  }).join('');

  return `<div class="organo">
    ${cadeira('Dono', 'dono da empresa', 'topo')}
    <ul><li>${cadeira('J.A.R.V.I.S.', 'CEO · responde ao dono', 'topo')}
      <ul>${html}</ul></li></ul>
    <p class="vazio">${n} cadeira(s) ocupada(s) · ${ags.length} agente(s) na frota</p></div>`;
}

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

  $('#organo').innerHTML = organograma(e);
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
      $('#medida').hidden = true;
      pintar();
      mostrar('painel');
      aviso('');
    } catch (err) {
      campo.value = '';
      $('#medida').hidden = true;   // a medida é da tentativa ATUAL; velha mente
      // Nem espera nem falha de rede são tentativa de senha: o app não testou
      // senha nenhuma nesses casos, então não podem gastar tentativa.
      if (err.espera) return aviso(err.message, 'ruim');
      if (err.github) {
        $('#dica').textContent = err.dica || '';
        $('#dica').hidden = !err.dica;
        return aviso(err.message, 'ruim');
      }
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

  // ── o campo que se explica ──────────────────────────────────────────────
  // Só o TAMANHO e a FORMA de chegada, nunca o conteúdo. Um salto de vários
  // caracteres num único evento não é digitação humana: é o iOS preenchendo por
  // cima com a senha que ele guardou antes — a causa mais provável de uma senha
  // certa ser recusada, e invisível sem esta medida.
  const campoSenha = $('#senha');
  const medida = $('#medida');
  let anterior = 0;
  campoSenha.addEventListener('input', () => {
    const n = campoSenha.value.length;
    const salto = n - anterior;
    anterior = n;
    medida.hidden = n === 0;
    medida.textContent = n === 0 ? ''
      : salto > 1 ? `${n} caractere(s) — preenchido de uma vez, não digitado. `
                  + 'Se você não colou, foi o iOS: apague a senha guardada em '
                  + 'Ajustes > Apps > Senhas e digite de novo.'
                  : `${n} caractere(s)`;
  });
  campoSenha.addEventListener('focus', () => { anterior = campoSenha.value.length; });

  const cfgAtual = lido(CFG);
  $('#versao').textContent = cfgAtual
    ? `app ${VERSAO_APP} — lendo ${cfgAtual.dono}/${cfgAtual.repo}`
    : `app ${VERSAO_APP}`;

  if ('serviceWorker' in navigator) {
    // Casca nova assumiu → recarrega UMA vez para mostrar a versão nova já nesta abertura.
    // Só com o painel fechado: a chave vive na memória, recarregar com ele aberto
    // obrigaria a digitar a senha de novo no meio de uma decisão.
    const tinha = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (tinha && $('#painel').hidden) location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((r) => r.update()).catch(() => {});
  }
});
