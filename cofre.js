// cofre.js — espelho exato do ponte/cofre.py, em WebCrypto.
//
// ⚠️ QUALQUER MUDANÇA AQUI TEM DE SAIR TAMBÉM NO cofre.py, E VICE-VERSA.
// Os dois lados derivam a MESMA chave da MESMA senha e precisam gerar os MESMOS
// bytes canônicos — um espaço a mais na serialização e o HMAC para de bater.
//
// Provado em 22/09 nos dois sentidos: o navegador decifrou o envelope do Python
// (com acento) e o Python aceitou o HMAC feito pelo navegador.

export const VERSAO = 1;
export const AAD_ESTADO = 'escritorio/estado.v1';
export const AAD_DECISAO = 'escritorio/decisao.v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const deb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64 = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** senha + sal -> {cifra, assina}. Os 64 bytes do PBKDF2 viram duas chaves de 32:
 *  cifrar e assinar são trabalhos diferentes e nunca dividem a mesma chave. */
export async function derivar(senha, sal, iteracoes) {
  const base = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: sal, iterations: iteracoes, hash: 'SHA-256' }, base, 512));
  return {
    cifra: await crypto.subtle.importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['decrypt', 'encrypt']),
    assina: await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  };
}

export async function decifrar(env, chave, aad) {
  if (env.v !== VERSAO || env.alg !== 'AES-256-GCM') throw new Error('envelope desconhecido');
  if (env.aad !== aad) throw new Error('propósito errado');
  let claro = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: deb64(env.iv), additionalData: enc.encode(aad) }, chave, deb64(env.ct));
  if (env.comp === 'gzip') {
    claro = await new Response(new Blob([claro]).stream()
      .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  return JSON.parse(dec.decode(claro));
}

export async function cifrar(obj, chave, aad) {
  const cru = enc.encode(JSON.stringify(obj));
  const gz = await new Response(new Blob([cru]).stream()
    .pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, chave, gz);
  return { v: VERSAO, alg: 'AES-256-GCM', comp: 'gzip', aad, iv: b64(iv), ct: b64(ct) };
}

/** Bytes estáveis do envelope: chaves ordenadas, sem espaço, sem o campo `hmac`.
 *  Tem de bater com json.dumps(sort_keys=True, separators=(",",":")) do Python. */
function canonico(env) {
  const o = {};
  for (const k of Object.keys(env).filter((k) => k !== 'hmac').sort()) o[k] = env[k];
  return enc.encode(JSON.stringify(o));
}

export async function assinar(env, chave) {
  return hex(await crypto.subtle.sign('HMAC', chave, canonico(env)));
}
