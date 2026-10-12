'use strict';
/* Criação automática de episódios: PDF (ou texto) + áudio → episódio.
   1) o Claude lê o PDF e devolve texto em frases, traduções, vocabulário, gramática e perguntas;
   2) o áudio é analisado no próprio dispositivo para encontrar as pausas e sincronizar as frases. */

const MODELS = [
  ['claude-sonnet-5-5', 'Sonnet 5.5 — recomendado'],
  ['claude-haiku-5-5', 'Haiku 5.5 — mais barato'],
  ['claude-opus-5-5', 'Opus 5.5 — o melhor, mais caro'],
];

const EP_TOOL = {
  name: 'save_episode',
  description: 'Guarda o graded reader estruturado a partir da história.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título da história, na língua original' },
      title_pt: { type: 'string', description: 'Tradução do título' },
      series: { type: 'string', description: 'Nome da série ou da história principal, se existir' },
      episode: { type: 'integer', description: 'Número do episódio/capítulo, se existir' },
      level: { type: 'string', enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] },
      focus: { type: 'string', description: 'Tema gramatical, curto, em português' },
      paragraphs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sentences: {
              type: 'array',
              items: { type: 'object', properties: { es: { type: 'string' }, pt: { type: 'string' } }, required: ['es', 'pt'] },
            },
          },
          required: ['sentences'],
        },
      },
      glossary: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            es: { type: 'string' }, pt: { type: 'string' }, note: { type: 'string' },
            forms: { type: 'array', items: { type: 'string' } },
            false_friend: { type: 'boolean' },
          },
          required: ['es', 'pt', 'forms'],
        },
      },
      grammar_html: { type: 'string' },
      quiz: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            q: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
            answer: { type: 'integer' }, why: { type: 'string' },
          },
          required: ['q', 'options', 'answer', 'why'],
        },
      },
    },
    required: ['title', 'title_pt', 'level', 'focus', 'paragraphs', 'glossary', 'grammar_html', 'quiz'],
  },
};

function buildPrompt(variant, hint) {
  const v = variant === 'pt-BR' ? 'português do Brasil' : 'português de Portugal';
  return `És um professor de línguas a preparar um graded reader para um falante nativo de português. O material acima contém uma história (normalmente em espanhol). Usa a ferramenta save_episode com o resultado.

Regras:
1. paragraphs — copia o texto da história EXATAMENTE como está no original: as mesmas palavras, pontuação, acentos e reticências. Não resumas, não corrijas, não acrescentes nada. Deixa de fora cabeçalhos, endereços de sites, números de página, o nome da lição/episódio e títulos traduzidos para inglês. O título da história também fica de fora dos parágrafos. Mantém a divisão em parágrafos do original e divide cada parágrafo em frases; uma exclamação ou pergunta curta (ex.: «¡Cuatro días!») é uma frase própria.
2. pt — tradução natural e fiel, frase a frase, em ${v}.
3. title / title_pt — título da história e a sua tradução. series / episode — se o documento indicar.
4. level — nível CEFR estimado do texto. focus — o tema gramatical (se o documento indicar um, usa-o traduzido para português), em poucas palavras.
5. glossary — 25 a 35 palavras e expressões mais úteis para um aluno deste nível, incluindo expressões de várias palavras. es: forma de dicionário, com artigo nos substantivos (el / la). pt: tradução em ${v}. note: nota curta opcional (conjugação irregular, uso, ou porque é falso amigo). forms: as formas EXATAS em que aparece no texto (mesmos acentos, em minúsculas). false_friend: true se for um falso amigo para quem fala português.
6. grammar_html — explicação curta (300 a 500 palavras), em ${v}, do tema gramatical, com exemplos tirados do texto e armadilhas para quem fala português. Usa só estas etiquetas: <h2>, <h3>, <p>, <ul>, <li>, <table>, <tr>, <th>, <td>, <b>, <i>, <span class="ex"> para exemplos na língua estudada, <div class="box"> para notas importantes e <div class="box ffbox"> para falsos amigos.
7. quiz — 8 perguntas de escolha múltipla em ${v}: 5 ou 6 de compreensão da história e 2 ou 3 de gramática ou vocabulário. 3 ou 4 opções cada; answer é o índice (a começar em 0) da opção correta; why explica em uma frase, citando o texto.${hint ? '\n\nInformação dada pelo utilizador: ' + hint : ''}`;
}

class ApiError extends Error {}
function apiError(status, msg = '') {
  const m = msg.toLowerCase();
  if (status === 401) return new ApiError('A chave da API não é válida. Confirma-a nas Definições.');
  if (status === 403) return new ApiError('A chave não tem permissão para este pedido. ' + msg);
  if (m.includes('credit') || m.includes('balance')) return new ApiError('Não há saldo na conta da API. Carrega crédito em console.anthropic.com.');
  if (status === 429) return new ApiError('Demasiados pedidos seguidos. Espera um minuto e tenta outra vez.');
  if (status === 529 || status >= 500) return new ApiError('O serviço está sobrecarregado neste momento. Tenta outra vez daqui a pouco.');
  if (status === 413) return new ApiError('O PDF é demasiado grande.');
  return new ApiError(`Erro da API (${status})${msg ? ': ' + msg : ''}`);
}

async function claudeRequest(key, body, onProgress) {
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key, 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) { throw new ApiError('Sem ligação à internet (ou o pedido foi bloqueado).'); }
  if (!r.ok) { let msg = ''; try { msg = (await r.json()).error?.message || ''; } catch (e) {} throw apiError(r.status, msg); }
  if (!body.stream) return r.json();
  // streaming (SSE): junta o JSON da ferramenta à medida que chega
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '', json = '', stop = null, usage = {};
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'input_json_delta') { json += ev.delta.partial_json; onProgress?.(json.length); }
      else if (ev.type === 'message_delta') { stop = ev.delta?.stop_reason || stop; Object.assign(usage, ev.usage || {}); }
      else if (ev.type === 'message_start') Object.assign(usage, ev.message?.usage || {});
      else if (ev.type === 'error') throw apiError(ev.error?.type === 'overloaded_error' ? 529 : 500, ev.error?.message);
    }
  }
  if (stop === 'max_tokens') throw new ApiError('A resposta ficou cortada porque a história é muito longa. Tenta dividir o texto.');
  if (!json) throw new ApiError('O Claude não devolveu o episódio. Tenta outra vez.');
  try { return { input: JSON.parse(json), usage }; } catch (e) { throw new ApiError('A resposta veio incompleta. Tenta outra vez.'); }
}

async function testKey(key, model) {
  await claudeRequest(key, { model, max_tokens: 5, messages: [{ role: 'user', content: 'Olá' }] });
}

async function askClaude({ key, model, pdfB64, text, variant, hint, onProgress }) {
  const content = pdfB64
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } }]
    : [{ type: 'text', text: 'HISTÓRIA:\n\n' + text }];
  content.push({ type: 'text', text: buildPrompt(variant, hint) });
  return claudeRequest(key, {
    model, max_tokens: 24000, stream: true,
    tools: [EP_TOOL], tool_choice: { type: 'tool', name: 'save_episode' },
    messages: [{ role: 'user', content }],
  }, onProgress);
}

/* ---------- áudio: pausas ---------- */
async function detectSilences(arrayBuffer) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(1, 1, 8000);
  const ab = await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(arrayBuffer, res, rej); if (p && p.then) p.then(res, rej);
  });
  const sr = ab.sampleRate, n = ab.length, chs = [...Array(ab.numberOfChannels)].map((_, i) => ab.getChannelData(i));
  const F = Math.max(1, Math.round(sr * 0.02)); const frames = Math.floor(n / F);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0; const o = f * F;
    for (const c of chs) for (let j = 0; j < F; j++) { const v = c[o + j]; s += v * v; }
    db[f] = 10 * Math.log10(s / (F * chs.length) + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const p10 = sorted[Math.floor(sorted.length * 0.10)], p90 = sorted[Math.floor(sorted.length * 0.90)];
  // limiar entre o ruído de fundo e a voz
  const thr = Math.min(-28, Math.max(p10 + 12, Math.min(-35, p90 - 30)));
  const sil = []; let st = -1;
  for (let f = 0; f <= frames; f++) {
    const quiet = f < frames && db[f] < thr;
    if (quiet && st < 0) st = f;
    if (!quiet && st >= 0) { const a = st * F / sr, b = f * F / sr; if (b - a >= 0.35) sil.push([a, b]); st = -1; }
  }
  return { sil, dur: ab.duration, thr };
}

/* ---------- alinhamento: frases ↔ pausas ---------- */
function alignSentences(sentLens, paraStart, sil, dur) {
  const n = sentLens.length, S = sentLens.reduce((a, b) => a + b, 0);
  // fim da fala
  let T1 = dur; const lastS = sil[sil.length - 1];
  if (lastS && lastS[1] >= dur - 0.1) T1 = lastS[0];
  // início da história: a pausa mais longa no início (intro/título) ou o início da fala
  let T0 = 0;
  const early = sil.filter(s => s[0] < Math.min(60, dur * 0.25));
  const longest = early.reduce((m, s) => (!m || s[1] - s[0] > m[1] - m[0]) ? s : m, null);
  if (longest && longest[1] - longest[0] >= 1.5) T0 = longest[1];
  else if (sil[0] && sil[0][0] < 0.05) T0 = sil[0][1];
  const rate = (T1 - T0) / S;
  const C = sil.filter(s => s[1] > T0 + 0.8 && s[1] < T1 - 0.5).map(s => ({ t: s[1], d: s[1] - s[0] }));
  const prop = () => { const out = [T0]; let c = 0; for (let i = 1; i < n; i++) { c += sentLens[i - 1]; out.push(T0 + c * rate); } return out; };
  if (n === 1) return { starts: [T0], end: T1 };
  if (C.length < n - 1) return { starts: prop(), end: T1 };
  const seg = (i, a, b) => { const exp = sentLens[i] * rate, d = b - a; if (d < 0.45 * exp) return 1e6; const z = (d - exp) / (0.35 * exp + 1.5); return z * z; };
  const bonus = (i, k) => -(paraStart[i] ? 1.0 : 0.4) * Math.min(C[k].d, 2.5);
  const INF = 1e18;
  let dp = C.map((c, k) => seg(0, T0, c.t) + bonus(1, k));
  const back = [null];
  for (let i = 2; i < n; i++) {
    const nd = new Array(C.length).fill(INF), bk = new Array(C.length).fill(-1);
    for (let k2 = 0; k2 < C.length; k2++) {
      const b = bonus(i, k2);
      for (let k = 0; k < k2; k++) {
        if (dp[k] >= INF) continue;
        const v = dp[k] + seg(i - 1, C[k].t, C[k2].t) + b;
        if (v < nd[k2]) { nd[k2] = v; bk[k2] = k; }
      }
    }
    dp = nd; back.push(bk);
  }
  let best = -1, bv = INF;
  dp.forEach((v, k) => { if (v < INF) { const t = v + seg(n - 1, C[k].t, T1); if (t < bv) { bv = t; best = k; } } });
  if (best < 0) return { starts: prop(), end: T1 };
  const idx = [best];
  for (let i = n - 1; i >= 2; i--) idx.push(back[i - 1][idx[idx.length - 1]]);
  idx.reverse();
  return { starts: [Math.max(0, T0 - 0.1), ...idx.map(k => Math.round((C[k].t - 0.12) * 100) / 100)], end: T1 + 0.3 };
}

/* ---------- montar o episódio ---------- */
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
function buildEpisode(d, timing, meta) {
  const paras = (d.paragraphs || []).map(p => (p.sentences || []).filter(s => s.es?.trim()).map(s => [s.es.trim(), (s.pt || '').trim()])).filter(p => p.length);
  const full = paras.flat().map(x => x[0]).join(' ').toLowerCase();
  const gloss = (d.glossary || []).map((g, i) => {
    const forms = (g.forms || []).map(f => f.trim().toLowerCase()).filter(f => f && full.includes(f));
    return { key: slug(g.es) || 'g' + i, es: g.es, pt: g.pt, note: g.note || '', forms, ff: !!g.false_friend };
  }).filter(g => g.forms.length);
  const quiz = (d.quiz || []).filter(q => q.options?.length >= 2 && q.answer >= 0 && q.answer < q.options.length)
    .map(q => ({ q: q.q, o: q.options, a: q.answer, why: q.why || '' }));
  const series = meta.series || d.series || '';
  const episode = meta.episode || d.episode || null;
  return {
    format: 'graded-reader/1',
    id: [slug(series), episode, slug(d.title)].filter(Boolean).join('-') + '-' + Date.now().toString(36),
    source: meta.source || '', series, episode, title: d.title, subtitle: d.title_pt || '',
    lang: 'es', level: d.level || '', focus: d.focus || '',
    paras, starts: timing.starts, end: timing.end, gloss, grammar: d.grammar_html || '', quiz,
    created: Date.now(), model: meta.model,
  };
}
const fileToB64 = file => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(file);
});

/* ---------- ecrã "Novo episódio" ---------- */
async function viewNew() {
  const key = await db.get('kv', 'apikey');
  const st = S.settings;
  const lastSeries = st.lastSeries || '';
  $('#app').innerHTML = `
  <div class="rtop"><div class="wrap"><div class="row"><a class="iconbtn" href="#/" aria-label="Voltar">${icons.back}</a><div class="ttl">Novo episódio</div></div></div></div>
  <div class="wrap" style="padding:8px 16px 32px">
    ${key ? '' : `<div class="box" style="margin-top:8px"><b>Falta a chave da API.</b> A criação automática usa o Claude. Vai a <a href="#/settings">Definições</a> e cola a tua chave. Fica guardada só neste dispositivo.</div>`}
    <div class="card" id="nForm">
      <label class="field"><b>1. Texto da história (PDF)</b>
        <input type="file" id="nPdf" accept="application/pdf,.pdf"></label>
      <details class="field"><summary>Não tens PDF? Cola o texto</summary>
        <textarea id="nText" rows="7" placeholder="Cola aqui o texto da história…"></textarea></details>
      <label class="field"><b>2. Áudio (MP3)</b>
        <input type="file" id="nAudio" accept="audio/*,.mp3,.m4a,.wav"></label>
      <div class="two">
        <label class="field"><b>Série</b><input type="text" id="nSeries" value="${esc(lastSeries)}" placeholder="opcional"></label>
        <label class="field"><b>Episódio nº</b><input type="number" id="nNum" min="1" placeholder="opcional"></label>
      </div>
      <button class="btn primary" id="nGo" ${key ? '' : 'disabled'} style="width:100%;justify-content:center;margin-top:6px">Criar episódio</button>
      <p class="hint">Demora cerca de um minuto. Mantém a app aberta até terminar. Cada episódio custa uns cêntimos de crédito da API.</p>
    </div>
    <div class="card" id="nRun" hidden>
      <ol class="run">
        <li data-s="audio"><i></i><span>Analisar o áudio e encontrar as pausas</span></li>
        <li data-s="ai"><i></i><span>Preparar texto, traduções e vocabulário <em id="nProg"></em></span></li>
        <li data-s="sync"><i></i><span>Sincronizar frases com o áudio</span></li>
        <li data-s="save"><i></i><span>Guardar no dispositivo</span></li>
      </ol>
      <p id="nErr" class="err" hidden></p>
      <div id="nAgain" hidden><button class="btn" id="nRetry">Tentar outra vez</button></div>
    </div>
  </div>`;
  const numFrom = name => { const m = /^(\d{1,3})[\s._-]/.exec(name || ''); return m ? +m[1] : ''; };
  $('#nPdf').onchange = e => { const f = e.target.files[0]; if (f && !$('#nNum').value) $('#nNum').value = numFrom(f.name); };
  $('#nAudio').onchange = e => { const f = e.target.files[0]; if (f && !$('#nNum').value) $('#nNum').value = numFrom(f.name); };
  const setStep = (s, state) => { const li = $(`.run li[data-s="${s}"]`); if (li) li.className = state; };
  const run = async () => {
    const pdf = $('#nPdf').files[0], text = $('#nText').value.trim(), audio = $('#nAudio').files[0];
    if (!pdf && !text) return toast('Escolhe o PDF ou cola o texto');
    if (!audio) return toast('Escolhe o ficheiro de áudio');
    const meta = { series: $('#nSeries').value.trim(), episode: +$('#nNum').value || null, model: st.model || MODELS[0][0] };
    st.lastSeries = meta.series; saveKV('settings');
    $('#nForm').hidden = true; $('#nRun').hidden = false; $('#nErr').hidden = true; $('#nAgain').hidden = true;
    ['audio', 'ai', 'sync', 'save'].forEach(s => setStep(s, ''));
    let lock = null; try { lock = await navigator.wakeLock?.request('screen'); } catch (e) {}
    try {
      setStep('audio', 'doing'); setStep('ai', 'doing');
      const audioBuf = await audio.arrayBuffer();
      const audioBlob = new Blob([audioBuf.slice(0)], { type: audio.type || 'audio/mpeg' });
      const hint = [meta.series && 'série: ' + meta.series, meta.episode && 'episódio: ' + meta.episode].filter(Boolean).join(', ');
      const pAudio = detectSilences(audioBuf).then(r => { setStep('audio', 'ok'); return r; }, e => { setStep('audio', 'fail'); throw new ApiError('Não consegui ler o ficheiro de áudio.'); });
      const pAi = (async () => {
        const pdfB64 = pdf ? await fileToB64(pdf) : null;
        const r = await askClaude({ key, model: meta.model, pdfB64, text, variant: st.variant || 'pt-PT', hint,
          onProgress: n => { $('#nProg').textContent = `(${Math.round(n / 1000)} KB recebidos)`; } });
        setStep('ai', 'ok'); $('#nProg').textContent = ''; return r;
      })().catch(e => { setStep('ai', 'fail'); throw e; });
      const [aud, ai] = await Promise.all([pAudio, pAi]);
      setStep('sync', 'doing');
      const d = ai.input;
      const paras = (d.paragraphs || []).map(p => (p.sentences || []).filter(s => s.es?.trim()));
      const lens = [], pstart = [];
      paras.forEach(p => p.forEach((s, j) => { lens.push(s.es.trim().length); pstart.push(j === 0); }));
      if (!lens.length) throw new ApiError('Não encontrei o texto da história no documento.');
      const timing = alignSentences(lens, pstart, aud.sil, aud.dur);
      setStep('sync', 'ok');
      setStep('save', 'doing');
      const ep = buildEpisode(d, timing, meta);
      await db.put('audio', audioBlob, ep.id);
      await db.put('episodes', ep);
      try { await navigator.storage?.persist?.(); } catch (e) {}
      setStep('save', 'ok');
      await loadAll();
      toast('Episódio criado. Se o áudio estiver desfasado, usa «Ajustar tempos».', 4500);
      location.hash = '#/ep/' + encodeURIComponent(ep.id);
    } catch (e) {
      console.error(e);
      $('#nErr').textContent = e instanceof ApiError ? e.message : 'Algo correu mal: ' + (e.message || e);
      $('#nErr').hidden = false; $('#nAgain').hidden = false;
      $$('.run li.doing').forEach(li => li.className = 'fail');
    } finally { try { await lock?.release(); } catch (e) {} }
  };
  $('#nGo').onclick = run;
  $('#app').addEventListener('click', e => { if (e.target.closest('#nRetry')) { $('#nForm').hidden = false; $('#nRun').hidden = true; } });
}
