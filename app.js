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
const VERSAO_APP = 'v14';
const DADO_VELHO_MIN = 60;            // decisão do dono, 02/11: dado com mais de 1h fica vermelho

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
// v13: o aparelho é MEDIDO, não declarado. Até a v12 toda decisão saía como 'iphone', e
// depois que o token do iPhone venceu ninguém conseguia dizer de onde vinham as decisões
// que seguiam chegando. O iPad novo se apresenta como Mac — o toque é o que o separa.
function aparelho() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipad';
  return /Macintosh/.test(ua) ? 'mac' : 'outro';
}

async function decidir(acao, ids, motivo = '', extra = {}) {
  const id = crypto.randomUUID();
  const agora = Math.floor(Date.now() / 1000);
  // `id` de uso único e `vale_ate` são o par que impede repetição: o Mac recusa
  // id já visto E recusa decisão vencida. Sem os dois, um arquivo capturado
  // poderia ser reenviado depois e aplicado de novo.
  const corpo = { ...extra, id, acao, ids, motivo, feito_em: agora, vale_ate: agora + VALIDADE_S, de: aparelho() };
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

// ── organograma (02/11, v10) ──────────────────────────────────────────────
// Dono → J.A.R.V.I.S. → setor → cadeira (diretor titular) → equipe. A fonte é a
// tabela da diretoria (colunas 4 e 8) e a lista REAL de agentes em ~/.claude/agents.
// Todo agente ganha cadeira: quem não está na tabela aparece no setor que a ficha
// dele declara, marcado "sem cargo" e respondendo ao J.A.R.V.I.S. — o desenho não
// inventa um chefe que a tabela não deu.
// v10: tocar na cadeira abre a ficha; setor recolhe; problema vem ESCRITO no topo
// (cor sozinha não conta: borda vermelha no fim da rolagem ninguém vê).
const SETOR = {
  comercial: 'Comercial', producao: 'Produção — alunos', conteudo: 'Conteúdo',
  financeiro: 'Financeiro', qualidade: 'Qualidade', conhecimento: 'Conhecimento',
  infra: 'Infraestrutura', mercado: 'Mercado', geral: 'Gabinete do CEO',
};
const ORDEM_SETOR = Object.keys(SETOR);
// O nome técnico vem sem acento (é nome de arquivo); a tela devolve o acento.
const ACENTO = {
  trafego: 'Tráfego', midia: 'Mídia', aquisicao: 'Aquisição', aperfeicoamento: 'Aperfeiçoamento',
  jarvis: 'J.A.R.V.I.S.', followup: 'Follow-up', nutricao: 'Nutrição', conteudo: 'Conteúdo',
};
const legivel = (n) => String(n).split('-')
  .map((p) => ACENTO[p] ?? (p.charAt(0).toUpperCase() + p.slice(1)))
  .join(' ');
// Nome do cargo também vem da tabela sem acento ("Diretor de Nutricao").
const cargo = (n) => String(n).split(' ').map((p) => ACENTO[p.toLowerCase()] ?? p).join(' ');

const horas = (h) => h == null ? 'sem registro' : h < 1 ? 'há menos de 1h'
  : h < 48 ? `há ${h}h` : `há ${Math.round(h / 24)} dias`;

function ficha(linhas) {
  return `<dl class="ficha">${linhas.filter(([, v]) => v !== '' && v != null)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

function cadeira(titulo, papel, cls = '', corpo = '', selo = '') {
  // v12: selos numa linha própria — com dois selos ao lado, o título virava "Diretor / de / Alunos".
  const cara = `<i>🪑</i><span class="txt"><b>${esc(titulo)}</b><small>${esc(papel)}</small></span>`
    + (selo ? `<span class="selos">${selo}</span>` : '');
  return corpo
    ? `<details class="cadeira ${cls}"><summary>${cara}</summary>${corpo}</details>`
    : `<div class="cadeira ${cls}">${cara}</div>`;
}

// v12: produção de UM agente (as rodadas creditadas a ele por nome). Fraca, para julgar e
// bloqueada são fatos diferentes — cada um no seu número.
function producao(p) {
  if (!p) return 'nenhuma rodada registrada em nome dele';
  return [`${p.rodadas} rodada(s)`, `${p.creditadas} creditada(s)`,
    p.fracas && `${p.fracas} fraca(s)`, p.aguardando && `${p.aguardando} para o dono julgar`,
    p.bloqueado && `${p.bloqueado} bloqueada(s) esperando o dono`,
    `última ${horas(p.ult_h)}`].filter(Boolean).join(' · ');
}

// v12: a fila da mesa na cadeira. A tarefa tem dono por cargo OU por agente; quem depende
// do dono aparece como "espera o dono", o resto como "com o setor".
function filaDe(tarefas, nomes) {
  const t = tarefas.filter((x) => nomes.includes(x.dono));
  return {
    n: t.length,
    dono: t.filter((x) => x.depende === 'dono').length,
    txt: t.map((x) => `${x.id} (${x.depende === 'dono' ? 'espera o dono' : 'com o setor'}, ${x.dias ?? '?'} dias)`).join(', '),
  };
}

function poderes(a) {
  if (!a) return '';
  if (a.so_relatorio) return 'só relatório — não altera nada';
  return a.pode_editar ? 'pode editar arquivo' : 'escreve arquivo novo, não edita';
}

// v13: decidir NA cadeira do J.A.R.V.I.S. O botão leva só o NÚMERO da opção; o Mac relê o
// texto na própria mesa e grava com `mesa.py decidir` — o app não consegue registrar uma
// escolha que não estava entre as opções.
const letra = (o, i) => (/^([A-Z])\)/.exec(o) || [])[1] || String(i + 1);

function decisoes(ds) {
  return ds.map((d) => `<div class="decisao" data-mesa="${esc(d.id)}">
    <b>${esc(d.id)} · ${esc(d.assunto)}</b>
    ${d.vencida_dias ? `<small>prazo vencido há ${esc(d.vencida_dias)} dias</small>` : ''}
    <ol>${(d.opcoes || []).map((o) => `<li>${esc(o)}</li>`).join('')}</ol>
    ${d.recomendacao ? `<p class="reco">recomendação do J.A.R.V.I.S.: ${esc(d.recomendacao)}</p>` : ''}
    ${(d.opcoes || []).length ? `<div class="botoes">${d.opcoes.map((o, i) =>
      `<button class="sim" data-opcao="${i}">decidir ${esc(letra(o, i))}</button>`).join('')}</div>`
      : '<p class="reco">sem opções legíveis — decida no Mac</p>'}
  </div>`).join('');
}

// v13: o que a régua MEDIU por semana, da mais velha para a de agora. Minuto é minuto; as
// outras moedas ficam numa linha própria (um campo, um fato — somar defeito com minuto não
// significa nada).
const BARRA = '▁▂▃▄▅▆▇█';
const UNIDADE = { pessoa: 'pessoa(s)', defeito: 'defeito(s)', dinheiro: 'R$' };
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function semanas(ss) {
  if (!ss || !ss.some((s) => s.n)) return { min: 'nenhuma rodada medida nas últimas 6 semanas', outras: '' };
  const teto = Math.max(...ss.map((s) => s.minutos), 1);
  const linha = ss.map((s) => BARRA[Math.round((s.minutos / teto) * (BARRA.length - 1))]).join('');
  const min = ss.some((s) => s.minutos)
    ? `${linha}  ${ss.map((s) => `${ddmm(s.inicio)}: ${s.minutos}`).join(' · ')} (min)`
    : 'nenhum minuto medido (as medidas deste cargo são em outra moeda)';
  const outras = ss.filter((s) => Object.keys(s.outras).length).map((s) => `${ddmm(s.inicio)}: ${
    Object.entries(s.outras).map(([m, v]) => m === 'dinheiro'
      ? `R$ ${v.toLocaleString('pt-BR')}` : `${v} ${UNIDADE[m] || m}`).join(', ')}`).join(' · ');
  return { min, outras };
}

// v13: fila REAL de rascunhos de treino sem julgamento. O "N para o dono julgar" das rodadas
// é histórico; julgado é a linha que o lançador grava no placar. É ESTADO, pode ir na faixa.
function filaReal(f) {
  if (!f) return 'SEM LEITURA do placar do treino';
  if (!f.parados.length) return `nenhum — os ${f.aguardando} rascunho(s) entregues já têm linha no placar`;
  return `${f.parados.length} sem linha no placar (de ${f.aguardando} entregues: ${f.julgados} julgados pelo placar`
    + (f.fechados ? `, ${f.fechados} fechados à mão como trocados ou descartados` : '') + ') · '
    + `idades em dias: ${f.parados.map((p) => p.dias ?? '?').join(', ')} · premissa: casamento por tipo `
    + 'e data; versão substituída (v2 trocada pela v3) segue contando como parada';
}

function organograma(e) {
  const dir = e.diretoria || [];
  const ags = e.agentes || [];
  if (!dir.length && !ags.length) return '<p class="vazio">SEM LEITURA da diretoria</p>';
  const ficheiro = Object.fromEntries(ags.map((a) => [a.nome, a]));
  const mesa = e.mesa || null;               // null = SEM LEITURA, nunca "mesa limpa"
  const tarefas = mesa?.tarefas || [];
  // v12: a ficha do agente DECLARA um setor; a tabela da diretoria o SENTA em outro. Só
  // acusa quando a ficha declarou (dep_origem) — setor inferido não é contradição.
  const divergentes = [];
  const diverge = (x, c) => {
    const a = ficheiro[x];
    if (!a || a.dep_origem !== 'declarado' || !a.dep || a.dep === c.dep) return '';
    divergentes.push(`${legivel(x)} (ficha: ${SETOR[a.dep] || a.dep} · tabela: ${SETOR[c.dep] || c.dep})`);
    return `<em class="selo ruim">ficha diz ${esc(SETOR[a.dep] || a.dep)}</em>`;
  };
  const sentados = new Set();
  const setores = {};
  const setor = (k) => (setores[SETOR[k] ? k : 'geral'] ??= { cargos: [], soltos: [] });

  for (const c of dir) {
    if (c.agente && c.agente !== '-') sentados.add(c.agente);
    for (const x of c.equipe || []) sentados.add(x);
    setor(c.dep).cargos.push(c);
  }
  for (const a of ags) if (!sentados.has(a.nome)) setor(a.dep).soltos.push(a);

  const mudos = dir.filter((c) => c.mudo === true);
  const vagas = dir.filter((c) => !c.agente || c.agente === '-');
  const soltos = Object.values(setores).flatMap((s) => s.soltos);

  let total = 0;
  const html = ORDEM_SETOR.filter((k) => setores[k]).map((k) => {
    const s = setores[k];
    let n = 0, ruim = 0;
    const cargos = s.cargos.map((c) => {
      const vago = !c.agente || c.agente === '-';
      const fila = filaDe(tarefas, [c.id, c.agente, ...(c.equipe || [])]);
      const st = c.mudo === true ? 'mudo' : c.mudo === false ? 'ok' : '';
      if (c.mudo === true) ruim++;
      n += vago ? 0 : 1;
      const sem = semanas(c.semanas);
      const corpo = ficha([
        ['função', c.funcao],
        ['pode sozinho', c.alcada],
        ['cadência', c.cadencia],
        ['última rodada', horas(c.idade_h) + (c.tol_h ? ` · tolera ${c.tol_h}h` : '')],
        // v11: entrega que foi para o dono julgar não é fraca — um campo, um fato. É
        // HISTÓRICO (a rodada não sabe se já foi julgada), por isso fica na ficha e não na
        // faixa, que só mostra o estado de agora.
        ['rodadas', `${c.rodadas ?? 0} no total · ${c.fracas ?? 0} fraca(s)`
          + (c.aguardando ? ` · ${c.aguardando} entregue(s) para o dono julgar (histórico)` : '')
          + (c.bloqueado ? ` · ${c.bloqueado} bloqueada(s) esperando o dono decidir` : '')],
        ['para julgar agora', c.id === 'treino' ? filaReal(e.fila_julgar) : ''],
        ['minutos medidos por semana', sem.min],
        ['outras medidas por semana', sem.outras],
        ['o titular', vago ? '' : producao(c.por_agente?.[c.agente])],
        ['na mesa', fila.n ? fila.txt : (mesa ? 'nada aberto' : 'SEM LEITURA da mesa')],
        ['entrega', c.moeda],
        ['equipe', (c.equipe || []).map(legivel).join(', ') || 'nenhuma'],
        ['acesso', poderes(ficheiro[c.agente])],
        ['agente', vago ? '' : c.agente],
      ]);
      const selo = (c.mudo === true ? '<em class="selo ruim">mudo</em>'
        : c.mudo == null && !vago ? '<em class="selo">sem régua</em>' : '')
        + (fila.dono ? `<em class="selo espera">${fila.dono} na mesa do dono</em>`
          : fila.n ? `<em class="selo">${fila.n} na mesa</em>` : '')
        + (vago ? '' : diverge(c.agente, c));
      const equipe = (c.equipe || []).map((x) => {
        n++;
        const p = c.por_agente?.[x];
        const fx = filaDe(tarefas, [x]);
        const sx = (p ? '' : '<em class="selo">sem rodada</em>')
          + (fx.n ? `<em class="selo${fx.dono ? ' espera' : ''}">${fx.n} na mesa</em>` : '')
          + diverge(x, c);
        return `<li>${cadeira(legivel(x), 'responde a ' + legivel(c.agente), '', ficha([
          ['chefe', `${legivel(c.agente)} · ${cargo(c.nome)}`],
          ['setor faz', c.funcao],
          ['produção', producao(p)],
          ['na mesa', fx.n ? fx.txt : ''],
          ['acesso', poderes(ficheiro[x])],
          ['agente', x],
        ]), sx)}</li>`;
      }).join('');
      return `<li>${cadeira(cargo(c.nome), (vago ? 'VAGA' : legivel(c.agente)) + ' · responde ao J.A.R.V.I.S.',
        'diretor ' + st + (vago ? ' vaga' : ''), corpo, selo)}
        ${equipe ? `<ul>${equipe}</ul>` : ''}</li>`;
    }).join('');
    const sol = s.soltos.map((a) => {
      n++;
      return `<li>${cadeira(legivel(a.nome), 'sem cargo na diretoria · responde ao J.A.R.V.I.S.', 'solto', ficha([
        ['chefe', 'J.A.R.V.I.S. (sem cargo na diretoria)'],
        ['acesso', poderes(a)],
        ['agente', a.nome],
      ]))}</li>`;
    }).join('');
    total += n;
    return `<li class="setor"><details${ruim ? ' open' : ''}><summary class="nome-setor">${esc(SETOR[k])}
      <span>${n} cadeira(s)${ruim ? ` · <em class="selo ruim">${ruim} mudo(s)</em>` : ''}</span></summary>
      <ul>${cargos}${sol}</ul></details></li>`;
  }).join('');

  const decis = mesa?.decisoes || [];
  const doDono = tarefas.filter((x) => x.depende === 'dono');
  const fila = e.fila_julgar;                // null = SEM LEITURA
  const fc = e.feedback_clinico;             // null = SEM LEITURA (cache > 2h ou nunca medido)
  const velho = idadeMin() > DADO_VELHO_MIN;
  const alertas = [
    velho && `<b class="ruim">Dado de ${idadeMin()} min:</b> o Mac pode ter parado de publicar — o que está abaixo é foto velha`,
    fc?.parados?.length && `<b class="ruim">${fc.parados.length} feedback(s) CLÍNICO(s) com análise pronta e sem tratar há mais de 24h:</b> `
      + esc(fc.parados.map((p) => `resposta ${p.resposta} (${p.idade_h}h)`).join(', ')),
    !fc && '<b>SEM LEITURA do feedback clínico</b>',
    fila?.parados?.length && `<b class="espera">${fila.parados.length} rascunho(s) de treino sem julgamento no placar</b> · `
      + `o mais velho há ${esc(fila.parados[0].dias ?? '?')} dias`,
    !fila && '<b>SEM LEITURA do placar do treino</b>',
    (decis.length || doDono.length) && `<b class="espera">Esperando o dono decidir:</b> ${[
      decis.length && `${decis.length} decisão(ões) na mesa (${esc(decis.map((d) => d.id).join(', '))})`,
      doDono.length && `${doDono.length} tarefa(s) que dependem dele (${esc(doDono.map((t) => t.id).join(', '))})`,
    ].filter(Boolean).join(' · ')}`,
    !mesa && '<b>SEM LEITURA da mesa de decisões</b>',
    divergentes.length && `<b class="ruim">${divergentes.length} agente(s) com setor divergente:</b> ${esc(divergentes.join('; '))}`,
    mudos.length && `<b class="ruim">${mudos.length} diretor(es) mudo(s):</b> ${esc(mudos.map((c) => legivel(c.agente)).join(', '))}`,
    vagas.length && `<b class="ruim">${vagas.length} cadeira(s) vaga(s):</b> ${esc(vagas.map((c) => cargo(c.nome)).join(', '))}`,
    soltos.length && `<b>${soltos.length} agente(s) sem cargo:</b> ${esc(soltos.map((a) => legivel(a.nome)).join(', '))}`,
  ].filter(Boolean);
  const faixa = `<div class="faixa ${mudos.length || vagas.length || divergentes.length || velho || fc?.parados?.length ? 'ruim' : 'bom'}">
    ${alertas.map((x) => `<p>${x}</p>`).join('')}
    ${mudos.length || vagas.length ? '' : '<p class="ok">✓ nenhum diretor mudo, nenhuma cadeira vaga</p>'}
    <small>${total} cadeira(s) ocupada(s) · ${ags.length} agente(s) na frota · toque numa cadeira para ver a ficha</small></div>`;

  return `${faixa}<div class="organo">
    ${cadeira('Dono', 'dono da empresa', 'topo')}
    <ul><li>${cadeira('J.A.R.V.I.S.', 'CEO · responde ao dono', 'topo',
      decis.length ? `<div class="ficha">${decisoes(decis)}</div>` : '',
      decis.length ? `<em class="selo espera">${decis.length} decisão(ões) paradas</em>` : '')}
      <ul>${html}</ul></li></ul></div>`;
}

// v13: idade do DADO na tela, contada do momento em que o Mac publicou. Anda sozinha com o
// painel aberto — um número congelado no momento da abertura mentiria justamente quando o
// dono deixa o app aberto e o Mac para de publicar.
const idadeMin = () => Math.round((Date.now() / 1000 - (estado?.publicado_em || 0)) / 60);

function pintarIdade() {
  if (!estado) return;
  const n = idadeMin();
  $('#idade').textContent = n < 120 ? `dado de ${n} min` : `dado de ${Math.round(n / 60)}h`;
  $('#idade').className = n > DADO_VELHO_MIN ? 'idade velha' : 'idade';
}

function pintar() {
  const e = estado.escritorio || {};
  const pendentes = (estado.acoes || []).filter((a) => a.estado === 'simulada');
  const acesos = (e.alarmes && e.alarmes.acesos) || [];

  pintarIdade();

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

  $('#organo').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-opcao]');
    if (!b) return;
    const caixa = b.closest('.decisao');
    const d = (estado?.escritorio?.mesa?.decisoes || []).find((x) => x.id === caixa.dataset.mesa);
    const i = Number(b.dataset.opcao);
    if (!d || !d.opcoes[i]) return aviso('essa decisão não está mais na foto — toque em atualizar', 'ruim');
    if (!confirm(`Decidir ${d.id} pela opção ${letra(d.opcoes[i], i)}?\n\n${d.opcoes[i]}`)) return;
    adiarTrancamento();
    caixa.querySelectorAll('button').forEach((x) => (x.disabled = true));
    try {
      await decidir('mesa_decidir', [], '', { mesa_id: d.id, opcao: i });
      caixa.classList.add('enviada');
      aviso(`${d.id} → ${letra(d.opcoes[i], i)} enviada — o Mac grava na mesa em até 1 min (vale por 15)`, 'bom');
    } catch (err) {
      caixa.querySelectorAll('button').forEach((x) => (x.disabled = false));
      aviso('não consegui enviar: ' + err.message, 'ruim');
    }
  });
  setInterval(pintarIdade, 30000);

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
