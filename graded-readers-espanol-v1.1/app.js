'use strict';
/* Leitor — graded readers com áudio, offline. Sem servidor: tudo fica no dispositivo (IndexedDB). */
const VERSION = '1.1.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => { t = Math.max(0, t | 0); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
const DAY = 864e5;

/* ---------------- IndexedDB ---------------- */
const db = {
  _p: null,
  open() {
    return this._p ||= new Promise((res, rej) => {
      const r = indexedDB.open('leitor', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('episodes', { keyPath: 'id' });
        d.createObjectStore('audio');
        d.createObjectStore('kv');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => res(out && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  get: (st, k) => db.tx(st, 'readonly', s => s.get(k)),
  all: (st) => db.tx(st, 'readonly', s => s.getAll()),
  put: (st, v, k) => db.tx(st, 'readwrite', s => k === undefined ? s.put(v) : s.put(v, k)),
  del: (st, k) => db.tx(st, 'readwrite', s => s.delete(k)),
};

/* ---------------- state ---------------- */
const S = {
  episodes: [],          // metadata + content (sem áudio)
  progress: {},          // epId -> {pos, maxIdx, done, last}
  vocab: {},             // gkey -> {box, due}
  settings: { theme: 'auto', fs: 20, tr: false, listen: false, gloss: true, follow: true, speed: 2, lastTab: 'ler', model: 'claude-sonnet-5-5', variant: 'pt-PT', lastSeries: '' },
};
let saveTimers = {};
function saveKV(key, delay = 400) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => db.put('kv', S[key], key).catch(console.error), delay);
}
async function loadAll() {
  S.episodes = (await db.all('episodes')).sort((a, b) => (a.series || '').localeCompare(b.series || '') || (a.episode || 0) - (b.episode || 0));
  for (const k of ['progress', 'vocab', 'settings']) {
    const v = await db.get('kv', k);
    if (v) S[k] = k === 'settings' ? { ...S.settings, ...v } : v;
  }
}

/* ---------------- helpers ---------------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
}
function applySettings() {
  const r = document.documentElement;
  if (S.settings.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', S.settings.theme);
  r.style.setProperty('--fs', S.settings.fs + 'px');
}
const gkey = (ep, g) => (ep.lang || 'xx') + ':' + g.es.toLowerCase();
function vstate(k) { return S.vocab[k] || { box: -1, due: 0 }; }
const isKnown = k => vstate(k).box >= 5;
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => {
    if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) n.removeAttribute(a.name);
  }));
  return doc.body.firstChild.innerHTML;
}
function epProgress(ep) {
  const p = S.progress[ep.id]; const n = ep.starts.length;
  if (!p) return 0; if (p.done) return 1;
  return Math.min(1, ((p.maxIdx ?? -1) + 1) / n);
}
const icons = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  cards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="14" rx="2"/><path d="M7 3h12a2 2 0 0 1 2 2v12"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
};
function bottomNav(on) {
  return `<nav class="bnav"><div class="wrap">
    <a href="#/" class="${on === 'lib' ? 'on' : ''}">${icons.book}Biblioteca</a>
    <a href="#/vocab" class="${on === 'vocab' ? 'on' : ''}">${icons.cards}Vocabulário</a>
    <a href="#/settings" class="${on === 'set' ? 'on' : ''}">${icons.gear}Definições</a>
  </div></nav>`;
}

/* ---------------- import ---------------- */
function b64ToBlob(b64, mime) {
  const bin = atob(b64); const len = bin.length; const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime || 'audio/mpeg' });
}
async function importFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(await f.text());
      if (data.format === 'leitor-backup/1') { await restoreBackup(data); continue; }
      if (data.format !== 'graded-reader/1' || !data.id || !data.paras || !data.starts) throw new Error('formato desconhecido');
      if (data.audio?.data) await db.put('audio', b64ToBlob(data.audio.data, data.audio.mime), data.id);
      const meta = { ...data, imported: Date.now() }; delete meta.audio;
      await db.put('episodes', meta);
      n++;
    } catch (e) { console.error(e); toast(`Não consegui importar ${f.name}: ${e.message}`, 4000); }
  }
  if (n) {
    try { await navigator.storage?.persist?.(); } catch (e) {}
    await loadAll(); route();
    toast(n === 1 ? 'Episódio importado e guardado offline' : `${n} episódios importados`);
  }
}
$('#fileIn').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });
const pickFiles = () => $('#fileIn').click();
// arrastar ficheiros para a janela (PC)
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]); });

/* ---------------- backup ---------------- */
function exportBackup() {
  const data = { format: 'leitor-backup/1', exported: new Date().toISOString(), progress: S.progress, vocab: S.vocab, settings: S.settings };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `leitor-progresso-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function restoreBackup(d) {
  // junta: fica com o progresso mais avançado de cada lado
  for (const [k, v] of Object.entries(d.progress || {})) {
    const c = S.progress[k];
    if (!c || (v.done && !c.done) || (v.maxIdx ?? -1) > (c.maxIdx ?? -1)) S.progress[k] = v;
  }
  for (const [k, v] of Object.entries(d.vocab || {})) {
    const c = S.vocab[k];
    if (!c || v.box > c.box) S.vocab[k] = v;
  }
  await db.put('kv', S.progress, 'progress'); await db.put('kv', S.vocab, 'vocab');
  toast('Progresso restaurado'); route();
}

/* ---------------- router ---------------- */
let leaveCurrent = null;
function route() {
  if (leaveCurrent) { leaveCurrent(); leaveCurrent = null; }
  $('#pop').style.display = 'none';
  document.body.className = '';
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  const [a, b] = h.split('/');
  if (a === 'ep' && b) return viewReader(decodeURIComponent(b));
  if (a === 'new') return viewNew();
  if (a === 'vocab') return viewVocab();
  if (a === 'cards') return viewCards();
  if (a === 'settings') return viewSettings();
  return viewLibrary();
}
addEventListener('hashchange', route);

/* ---------------- library ---------------- */
function viewLibrary() {
  document.body.classList.add('has-nav');
  const eps = S.episodes;
  let last = null;
  for (const ep of eps) { const p = S.progress[ep.id]; if (p?.last && !p.done && (!last || p.last > S.progress[last.id].last)) last = ep; }
  const due = dueCards().length;
  let body;
  if (!eps.length) {
    body = `<div class="card empty">
      <div class="big">A tua biblioteca está vazia</div>
      <p class="muted">Importa um ficheiro de episódio (.json). Fica guardado neste dispositivo e funciona sem internet.</p>
      <p style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><a class="btn primary" href="#/new">${icons.plus} Novo episódio (PDF + MP3)</a><button class="btn" data-act="import">Importar .json</button></p>
      <p class="muted" style="font-size:13px">No PC também podes arrastar o ficheiro para esta janela.</p>
    </div>`;
  } else {
    const groups = {};
    eps.forEach(e => (groups[e.series || 'Outros'] ||= []).push(e));
    body = (last ? `<button class="resume" data-ep="${esc(last.id)}">${icons.play}<div><div class="k">Continuar</div><div class="t">${esc(last.title)}</div><div style="font-size:13px;opacity:.85">${esc(last.series || '')} · ${Math.round(epProgress(last) * 100)}%</div></div></button>` : '')
      + (due ? `<p style="margin:12px 0 0"><a class="btn" href="#/cards">${icons.cards} Rever ${due} palavra${due > 1 ? 's' : ''}</a></p>` : '')
      + Object.entries(groups).map(([g, list]) => `<div class="sec">${esc(g)}</div><div class="lib">` + list.map(ep => {
        const pr = epProgress(ep);
        return `<button class="ep" data-ep="${esc(ep.id)}">
          <div class="num">${esc(ep.episode ?? '•')}</div>
          <div class="info"><div class="t">${esc(ep.title)}</div>
            <div class="s2">${esc([ep.level, ep.focus].filter(Boolean).join(' · '))} ${pr >= 1 ? '· <span class="done">Lido ✓</span>' : ''}</div>
            <div class="bar"><i style="width:${Math.round(pr * 100)}%"></i></div></div>
        </button>`;
      }).join('') + '</div>').join('');
  }
  $('#app').innerHTML = `<div class="wrap">
    <div class="top"><div><div class="kicker">Graded readers</div><h1>Biblioteca</h1></div>
    ${eps.length ? `<div style="display:flex;gap:8px"><a class="btn primary" href="#/new">${icons.plus} Novo</a><button class="btn" data-act="import">Importar</button></div>` : ''}</div>
    ${body}</div>${bottomNav('lib')}`;
  $('#app').onclick = e => {
    const ep = e.target.closest('[data-ep]'); if (ep) location.hash = '#/ep/' + encodeURIComponent(ep.dataset.ep);
    if (e.target.closest('[data-act=import]')) pickFiles();
  };
}

/* ---------------- reader ---------------- */
const au = $('#au');
const speeds = [0.75, 0.9, 1, 1.15];
async function viewReader(id) {
  const ep = S.episodes.find(e => e.id === id);
  if (!ep) { location.hash = '#/'; return; }
  const blob = await db.get('audio', id);
  const url = blob ? URL.createObjectURL(blob) : '';
  document.body.classList.add('has-player');
  const st = S.settings;
  ['tr', 'listen'].forEach(k => document.body.classList.toggle(k === 'tr' ? 'show-tr' : 'listen', st[k]));
  document.body.classList.toggle('hide-gloss', !st.gloss);

  // glossário -> regex
  const formMap = {};
  ep.gloss.forEach(g => (g.forms || [g.es]).forEach(f => formMap[f.toLowerCase()] = g));
  const forms = Object.keys(formMap).sort((a, b) => b.length - a.length).map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = forms.length ? new RegExp('(?<![\\p{L}])(' + forms.join('|') + ')(?![\\p{L}])', 'giu') : null;
  const markup = text => {
    if (!re) return esc(text);
    let out = '', last = 0;
    text.replace(re, (m, _g, off) => {
      out += esc(text.slice(last, off));
      const g = formMap[m.toLowerCase()]; const k = gkey(ep, g);
      out += `<span class="w${g.ff ? ' ff' : ''}${isKnown(k) ? ' known' : ''}" data-k="${esc(k)}">${esc(m)}</span>`;
      last = off + m.length; return m;
    });
    return out + esc(text.slice(last));
  };
  let i = 0, story = '';
  for (const p of ep.paras) {
    story += '<p>' + p.map(([es, pt]) => `<span class="s" data-i="${i++}">${markup(es)}</span> <span class="tr">${esc(pt)}</span>`).join('') + '</p>';
  }
  const gByKey = Object.fromEntries(ep.gloss.map(g => [gkey(ep, g), g]));
  const tabs = [['ler', 'Ler e ouvir'], ['vocab', 'Vocabulário'], ep.grammar ? ['gram', 'Gramática'] : null, ep.quiz?.length ? ['quiz', 'Perguntas'] : null].filter(Boolean);

  $('#app').innerHTML = `
  <div class="rtop"><div class="wrap">
    <div class="row"><a class="iconbtn" href="#/" aria-label="Voltar">${icons.back}</a><div class="ttl">${esc(ep.title)}</div></div>
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-t="${k}" aria-selected="false">${l}</button>`).join('')}</nav>
  </div></div>
  <div class="wrap">
    <div class="panel" data-p="ler">
      <div style="margin-bottom:16px"><div class="kicker">${esc(ep.series || '')}${ep.episode ? ' · Episódio ' + esc(ep.episode) : ''}</div>
        <h1>${esc(ep.title)}</h1>${ep.subtitle ? `<p class="sub">${esc(ep.subtitle)}</p>` : ''}
        <div class="meta">${[ep.level && 'Nível ' + ep.level, ep.focus && 'Foco: ' + ep.focus, ep.source].filter(Boolean).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div></div>
      <div class="toolbar">
        <button class="tg" data-s="tr">Tradução</button>
        <button class="tg" data-s="listen">Só ouvir</button>
        <button class="tg" data-s="gloss">Sublinhados</button>
        <button class="tg" data-s="follow">Seguir áudio</button>
        <button class="tg" id="bAdjust">Ajustar tempos</button>
      </div>
      <div class="adjbar" id="adjbar" hidden>
        <p><b>Ajustar tempos.</b> Põe o áudio a tocar e toca em cada frase no momento em que ela começa. Podes recuar no áudio e repetir. No fim, guarda.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="adjSave">Guardar</button><button class="btn" id="adjCancel">Cancelar</button><button class="btn" id="adjStart">Ouvir do início</button></div>
      </div>
      <div class="card"><div class="story">${story}</div></div>
      <p class="hint">Toca numa frase para ouvir a partir daí. Toca numa palavra sublinhada para ver o significado (roxo = falso amigo).</p>
    </div>
    <div class="panel" data-p="vocab"><div class="vhead"><p class="muted" style="margin:0">${ep.gloss.length} palavras e expressões deste episódio.</p>
      <a class="btn" href="#/cards?ep=${encodeURIComponent(ep.id)}">${icons.cards} Praticar</a></div><div class="vgrid" id="epv"></div></div>
    <div class="panel" data-p="gram"><div class="card">${sanitize(ep.grammar)}</div></div>
    <div class="panel" data-p="quiz"><div id="qbox"></div><p class="score" id="score"></p><button class="tg" id="bReset">Recomeçar</button></div>
  </div>`;

  // tabs
  const showTab = t => {
    $$('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.t === t));
    $$('.panel').forEach(p => p.hidden = p.dataset.p !== t);
    $('#pop').style.display = 'none';
  };
  $$('nav.tabs button').forEach(b => b.onclick = () => { showTab(b.dataset.t); scrollTo(0, 0); });
  showTab('ler');

  // toggles
  const tgMap = { tr: ['show-tr', false], listen: ['listen', false], gloss: ['hide-gloss', true], follow: [null] };
  $$('.tg[data-s]').forEach(b => {
    const k = b.dataset.s; const [cls, inv] = tgMap[k];
    const apply = () => { b.setAttribute('aria-pressed', !!st[k]); if (cls) document.body.classList.toggle(cls, inv ? !st[k] : st[k]); };
    b.onclick = () => { st[k] = !st[k]; saveKV('settings'); apply(); };
    apply();
  });

  // vocab (episódio)
  const renderEpVocab = () => {
    $('#epv').innerHTML = ep.gloss.map(g => {
      const k = gkey(ep, g);
      return `<div class="v${g.ff ? ' ffc' : ''}${isKnown(k) ? ' known' : ''}"><div class="es">${esc(g.es)}${g.ff ? '<span class="tag">falso amigo</span>' : ''}</div>
      <div class="pt">${esc(g.pt)}</div>${g.note ? `<div class="n">${esc(g.note)}</div>` : ''}
      <button class="act" data-k="${esc(k)}">${isKnown(k) ? 'Voltar a aprender' : 'Já sei'}</button></div>`;
    }).join('');
  };
  renderEpVocab();
  const toggleKnown = k => {
    if (isKnown(k)) S.vocab[k] = { box: 0, due: Date.now() }; else S.vocab[k] = { box: 5, due: Date.now() + 365 * DAY };
    saveKV('vocab');
    $$(`.w[data-k="${CSS.escape(k)}"]`).forEach(w => w.classList.toggle('known', isKnown(k)));
    renderEpVocab();
  };
  $('#epv').onclick = e => { const b = e.target.closest('.act'); if (b) toggleKnown(b.dataset.k); };

  // quiz
  let answered = {};
  const renderQuiz = () => {
    if (!ep.quiz?.length) return;
    $('#qbox').innerHTML = ep.quiz.map((q, n) => `<div class="card q" data-q="${n}"><div class="qt">${n + 1}. ${esc(q.q)}</div>
      ${q.o.map((o, j) => `<button class="opt" data-j="${j}">${esc(o)}</button>`).join('')}<div class="why">${esc(q.why || '')}</div></div>`).join('');
    $('#score').textContent = '';
  };
  $('#qbox').onclick = e => {
    const b = e.target.closest('.opt'); if (!b) return;
    const qe = b.closest('.q'), n = +qe.dataset.q, j = +b.dataset.j, q = ep.quiz[n];
    if (n in answered) return;
    answered[n] = j === q.a;
    $$('.opt', qe).forEach((o, k) => { o.disabled = true; if (k === q.a) o.classList.add('right'); else if (k === j) o.classList.add('wrong'); });
    qe.classList.add('done');
    if (Object.keys(answered).length === ep.quiz.length) $('#score').textContent = `Resultado: ${Object.values(answered).filter(Boolean).length} de ${ep.quiz.length}`;
  };
  $('#bReset').onclick = () => { answered = {}; renderQuiz(); };
  renderQuiz();

  // ---- player ----
  const starts = ep.starts;
  const ends = starts.map((t, k) => k < starts.length - 1 ? starts[k + 1] : (ep.end || 1e9));
  const sEls = $$('.s');
  let cur = -1, loop = false;
  const prog = S.progress[id] ||= { pos: 0, maxIdx: -1, done: false, last: Date.now() };
  prog.last = Date.now(); saveKV('progress');

  const player = $('#player'); player.hidden = false;
  $('#pLoop').classList.remove('on');
  const setSpeed = () => { au.playbackRate = speeds[st.speed] || 1; $('#pSpeed').textContent = (speeds[st.speed] || 1) + '×'; };
  au.src = url; setSpeed();
  const idxAt = t => { let k = -1; for (let n = 0; n < starts.length; n++) if (t >= starts[n] - 0.05) k = n; return k; };
  const setCur = k => {
    if (k === cur) return;
    if (cur === -2) sEls.forEach(x => x.classList.remove('cur'));
    else if (cur >= 0 && sEls[cur]) sEls[cur].classList.remove('cur');
    cur = k;
    if (k >= 0 && sEls[k]) {
      sEls[k].classList.add('cur');
      if (st.follow && !au.paused && !$('.panel[data-p=ler]').hidden) {
        const r = sEls[k].getBoundingClientRect();
        if (r.top < 120 || r.bottom > innerHeight - 150) sEls[k].scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      if (k > prog.maxIdx) prog.maxIdx = k;
    }
  };
  const persist = () => { prog.pos = au.currentTime || prog.pos; prog.last = Date.now(); saveKV('progress', 0); };
  let lastSave = 0;
  const onTime = () => {
    const t = au.currentTime;
    if (loop && cur >= 0 && t >= ends[cur] - 0.1) { au.currentTime = starts[cur]; return; }
    setCur(idxAt(t));
    $('#seek').value = t; $('#tCur').textContent = fmt(t);
    if (Date.now() - lastSave > 4000) { lastSave = Date.now(); persist(); }
  };
  const onMeta = () => {
    $('#seek').max = au.duration; $('#tDur').textContent = fmt(au.duration);
    if (prog.pos && !prog.done && prog.pos < au.duration - 2) {
      const k = idxAt(prog.pos); au.currentTime = k >= 0 ? starts[k] : prog.pos; setCur(k);
      if (k > 0) setTimeout(() => sEls[k]?.scrollIntoView({ block: 'center' }), 50);
    }
  };
  const onEnded = () => { prog.done = true; prog.maxIdx = starts.length - 1; prog.pos = 0; saveKV('progress', 0); toast('Episódio concluído ✓'); };
  const onPlay = () => { $('#icPlay').innerHTML = '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'; $('#pPlay').setAttribute('aria-label', 'Pausa'); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; };
  const onPause = () => { $('#icPlay').innerHTML = '<path d="M7 4v16l13-8z"/>'; $('#pPlay').setAttribute('aria-label', 'Tocar'); persist(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; };
  au.addEventListener('timeupdate', onTime); au.addEventListener('loadedmetadata', onMeta);
  au.addEventListener('ended', onEnded); au.addEventListener('play', onPlay); au.addEventListener('pause', onPause);
  onPause();

  const playFrom = k => { k = Math.max(0, Math.min(starts.length - 1, k)); au.currentTime = starts[k]; setCur(k); au.play(); };
  const prev = () => { const t = au.currentTime; let k = idxAt(t); if (k >= 0 && t - starts[k] < 1.5) k--; playFrom(Math.max(k, 0)); };
  const next = () => playFrom(idxAt(au.currentTime) + 1);
  $('#pPlay').onclick = () => au.paused ? au.play() : au.pause();
  $('#pPrev').onclick = prev; $('#pNext').onclick = next;
  $('#pLoop').onclick = function () { loop = !loop; this.classList.toggle('on', loop); if (loop && cur < 0) playFrom(0); };
  $('#pSpeed').onclick = () => { st.speed = (st.speed + 1) % speeds.length; setSpeed(); saveKV('settings'); };
  $('#seek').oninput = e => { au.currentTime = +e.target.value; };

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.title, artist: [ep.series, ep.episode && 'Ep. ' + ep.episode].filter(Boolean).join(' · '), album: 'Graded Readers Español',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    const h = { play: () => au.play(), pause: () => au.pause(), previoustrack: prev, nexttrack: next,
      seekbackward: () => { au.currentTime = Math.max(0, au.currentTime - 5); }, seekforward: () => { au.currentTime += 5; } };
    for (const [a, f] of Object.entries(h)) try { navigator.mediaSession.setActionHandler(a, f); } catch (e) {}
  }

  // ajustar tempos
  let adjust = false, backup = null;
  const setAdjust = on => {
    adjust = on; document.body.classList.toggle('adjusting', on);
    $('#adjbar').hidden = !on; $('#bAdjust').setAttribute('aria-pressed', on);
    if (on) { backup = starts.slice(); loop = false; $('#pLoop').classList.remove('on'); }
  };
  $('#bAdjust').onclick = () => setAdjust(!adjust);
  $('#adjCancel').onclick = () => { starts.splice(0, starts.length, ...backup); for (let k = 0; k < starts.length; k++) ends[k] = k < starts.length - 1 ? starts[k + 1] : (ep.end || 1e9); setAdjust(false); toast('Alterações descartadas'); };
  $('#adjStart').onclick = () => { au.currentTime = 0; au.play(); };
  $('#adjSave').onclick = async () => {
    ep.starts = starts.slice(); await db.put('episodes', ep);
    setAdjust(false); toast('Tempos guardados');
  };
  const markStart = i => {
    let t = Math.max(0, au.currentTime - 0.2);
    if (i > 0) t = Math.max(t, starts[i - 1] + 0.3);
    starts[i] = Math.round(t * 100) / 100;
    for (let k = i + 1; k < starts.length; k++) if (starts[k] <= starts[k - 1]) starts[k] = starts[k - 1] + 0.3;
    for (let k = 0; k < starts.length; k++) ends[k] = k < starts.length - 1 ? starts[k + 1] : (ep.end || 1e9);
    sEls[i].classList.add('marked'); setTimeout(() => sEls[i].classList.remove('marked'), 600);
    cur = -2; setCur(idxAt(au.currentTime));
  };

  // cliques: frase / palavra
  const pop = $('#pop');
  const showPop = el => {
    const g = gByKey[el.dataset.k]; if (!g) return;
    const k = el.dataset.k;
    pop.innerHTML = `<b>${esc(g.es)}</b> — ${esc(g.pt)}${g.note ? `<div class="n">${esc(g.note)}</div>` : ''}<button data-k="${esc(k)}">${isKnown(k) ? 'Voltar a aprender' : 'Já sei esta'}</button>`;
    pop.style.display = 'block';
    const r = el.getBoundingClientRect(); const w = pop.offsetWidth;
    let x = r.left + scrollX + r.width / 2 - w / 2;
    x = Math.max(8, Math.min(x, document.documentElement.clientWidth - w - 8));
    let y = r.top + scrollY - pop.offsetHeight - 8;
    if (r.top - pop.offsetHeight < 120) y = r.bottom + scrollY + 8;
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  };
  const onClick = e => {
    const pb = e.target.closest('#pop button');
    if (pb) { toggleKnown(pb.dataset.k); pop.style.display = 'none'; return; }
    const w = e.target.closest('.w');
    if (w && st.gloss && !adjust) { e.stopPropagation(); showPop(w); return; }
    if (!e.target.closest('#pop')) pop.style.display = 'none';
    const s = e.target.closest('.s');
    if (s && adjust) { markStart(+s.dataset.i); return; }
    if (s) { if (st.listen) s.classList.toggle('peek'); playFrom(+s.dataset.i); }
  };
  document.addEventListener('click', onClick, true);
  const onKey = e => {
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); au.paused ? au.play() : au.pause(); }
    if (e.code === 'ArrowLeft') prev();
    if (e.code === 'ArrowRight') next();
  };
  document.addEventListener('keydown', onKey);
  const onHide = () => { if (document.visibilityState === 'hidden') persist(); };
  document.addEventListener('visibilitychange', onHide);

  leaveCurrent = () => {
    if (adjust && backup) { starts.splice(0, starts.length, ...backup); ep.starts = backup; }
    persist(); au.pause();
    au.removeEventListener('timeupdate', onTime); au.removeEventListener('loadedmetadata', onMeta);
    au.removeEventListener('ended', onEnded); au.removeEventListener('play', onPlay); au.removeEventListener('pause', onPause);
    document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onHide);
    au.removeAttribute('src'); au.load(); if (url) URL.revokeObjectURL(url);
    player.hidden = true;
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  };
}

/* ---------------- global vocab ---------------- */
function allWords(epFilter) {
  const map = new Map();
  for (const ep of S.episodes) {
    if (epFilter && ep.id !== epFilter) continue;
    const sents = ep.paras.flat().map(x => x[0]);
    for (const g of ep.gloss) {
      const k = gkey(ep, g);
      if (map.has(k)) { map.get(k).src.add(ep.title); continue; }
      const forms = (g.forms || [g.es]);
      let ctx = '';
      for (const s of sents) {
        const f = forms.find(f => new RegExp('(?<![\\p{L}])' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}])', 'iu').test(s));
        if (f) { ctx = esc(s).replace(new RegExp('(?<![\\p{L}])(' + esc(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?![\\p{L}])', 'iu'), '<b>$1</b>'); break; }
      }
      map.set(k, { k, g, ctx, src: new Set([ep.title]) });
    }
  }
  return [...map.values()];
}
const sortKey = s => s.replace(/^(el|la|los|las|el \/ la)\s+/i, '');
function dueCards(epFilter) {
  const now = Date.now();
  const words = allWords(epFilter);
  const reviews = words.filter(w => { const v = S.vocab[w.k]; return v && v.box >= 0 && v.box < 5 && v.due <= now; }).sort((a, b) => S.vocab[a.k].due - S.vocab[b.k].due);
  const fresh = words.filter(w => !S.vocab[w.k]);
  return [...reviews, ...fresh];
}
function viewVocab() {
  document.body.classList.add('has-nav');
  let filter = 'all';
  const render = () => {
    const words = allWords().sort((a, b) => sortKey(a.g.es).localeCompare(sortKey(b.g.es), 'es'));
    const known = words.filter(w => isKnown(w.k)).length;
    const learning = words.filter(w => { const v = S.vocab[w.k]; return v && v.box >= 0 && v.box < 5; }).length;
    const due = dueCards().length;
    const list = words.filter(w => filter === 'all' || (filter === 'known' ? isKnown(w.k) : !isKnown(w.k)));
    $('#app').innerHTML = `<div class="wrap">
      <div class="top"><div><div class="kicker">Todas as histórias</div><h1>Vocabulário</h1></div>
      ${due ? `<a class="btn primary" href="#/cards">${icons.cards} Rever ${Math.min(due, 20)}</a>` : ''}</div>
      ${words.length ? `<div class="stats"><div class="stat"><b>${words.length}</b><span>palavras</span></div><div class="stat"><b>${learning}</b><span>a aprender</span></div><div class="stat"><b>${known}</b><span>já sabes</span></div></div>
      <div class="vhead"><div class="seg">
        <button data-f="all" aria-pressed="${filter === 'all'}">Todas</button><button data-f="learn" aria-pressed="${filter === 'learn'}">Por saber</button><button data-f="known" aria-pressed="${filter === 'known'}">Sei</button></div></div>
      <div class="vgrid">${list.map(w => `<div class="v${w.g.ff ? ' ffc' : ''}${isKnown(w.k) ? ' known' : ''}">
        <div class="es">${esc(w.g.es)}${w.g.ff ? '<span class="tag">falso amigo</span>' : ''}</div><div class="pt">${esc(w.g.pt)}</div>
        ${w.g.note ? `<div class="n">${esc(w.g.note)}</div>` : ''}<div class="src">${esc([...w.src].join(', '))}</div>
        <button class="act" data-k="${esc(w.k)}">${isKnown(w.k) ? 'Voltar a aprender' : 'Já sei'}</button></div>`).join('')}</div>`
        : `<div class="card empty"><div class="big">Ainda não há palavras</div><p class="muted">O vocabulário aparece aqui quando importares episódios.</p></div>`}
      </div>${bottomNav('vocab')}`;
  };
  render();
  $('#app').onclick = e => {
    const f = e.target.closest('[data-f]'); if (f) { filter = f.dataset.f; render(); return; }
    const b = e.target.closest('.act');
    if (b) { const k = b.dataset.k; S.vocab[k] = isKnown(k) ? { box: 0, due: Date.now() } : { box: 5, due: Date.now() + 365 * DAY }; saveKV('vocab'); render(); }
  };
}

/* ---------------- flashcards (repetição espaçada simples) ---------------- */
const INTERVALS = [0, 1, 2, 4, 8, 16]; // dias por caixa
function viewCards() {
  const epFilter = new URLSearchParams(location.hash.split('?')[1] || '').get('ep');
  let queue = dueCards(epFilter).slice(0, 20);
  const total = queue.length; let done = 0, right = 0, shown = false;
  const backHref = epFilter ? '#/ep/' + encodeURIComponent(epFilter) : '#/vocab';
  const render = () => {
    const w = queue[0];
    $('#app').innerHTML = `<div class="rtop"><div class="wrap"><div class="row"><a class="iconbtn" href="${backHref}" aria-label="Voltar">${icons.back}</a><div class="ttl">Praticar vocabulário</div></div></div></div>
    <div class="wrap" style="padding-top:12px">${w ? `
      <p class="fcprog">${done + 1} de ${total}${queue.length > total - done ? ' (+ repetições)' : ''}</p>
      <div class="card fc" id="fc">
        <div class="front">${esc(w.g.es)}</div>
        ${w.ctx ? `<div class="ctx">«${w.ctx}»</div>` : ''}
        ${shown ? `<div class="back"><div class="pt">${esc(w.g.pt)}</div>${w.g.note ? `<div class="n">${esc(w.g.note)}</div>` : ''}${w.g.ff ? '<div style="margin-top:8px"><span class="tag">falso amigo</span></div>' : ''}</div>`
          : '<div class="tap">Toca para ver a tradução</div>'}
      </div>
      ${shown ? `<div class="fcbtns"><button class="btn no" data-a="0">Não sabia</button><button class="btn yes" data-a="1">Sabia</button></div>` : ''}
    ` : `<div class="card empty"><div class="big">${total ? 'Sessão concluída' : 'Nada para rever agora'}</div>
      <p class="muted">${total ? `Acertaste ${right} de ${done}. As palavras voltam quando for altura de as rever.` : 'Volta mais tarde ou importa um episódio novo.'}</p>
      <p><a class="btn primary" href="${backHref}">Voltar</a></p></div>`}</div>`;
  };
  render();
  $('#app').onclick = e => {
    if (e.target.closest('#fc') && !shown) { shown = true; render(); return; }
    const a = e.target.closest('[data-a]'); if (!a) return;
    const w = queue.shift(); const v = S.vocab[w.k] || { box: -1, due: 0 };
    if (a.dataset.a === '1') {
      const box = Math.min(5, Math.max(0, v.box) + 1);
      S.vocab[w.k] = { box, due: Date.now() + INTERVALS[Math.min(box, 5)] * DAY };
      if (!w._again) right++;
      if (!w._again) done++;
    } else {
      S.vocab[w.k] = { box: 0, due: Date.now() };
      if (!w._again) done++;
      w._again = true; queue.push(w);
    }
    saveKV('vocab'); shown = false; render();
  };
}

/* ---------------- settings ---------------- */
async function exportEpisode(id) {
  const ep = S.episodes.find(e => e.id === id); const blob = await db.get('audio', id);
  if (!ep) return;
  toast('A preparar o ficheiro…');
  const data = { ...ep, audio: blob ? { mime: blob.type || 'audio/mpeg', data: await fileToB64(blob) } : undefined };
  delete data.imported;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `${(ep.episode ? String(ep.episode).padStart(2, '0') + '-' : '') + slug(ep.title) || 'episodio'}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function viewSettings() {
  document.body.classList.add('has-nav');
  let est = '';
  try { const e = await navigator.storage.estimate(); est = `${(e.usage / 1e6).toFixed(1)} MB usados`; } catch (e) {}
  let persisted = false; try { persisted = await navigator.storage.persisted(); } catch (e) {}
  const st = S.settings;
  const hasKey = !!(await db.get('kv', 'apikey'));
  $('#app').innerHTML = `<div class="wrap">
    <div class="top"><div><div class="kicker">Graded Readers Español · ${VERSION}</div><h1>Definições</h1></div></div>
    <div class="card">
      <div class="set"><div class="l"><b>Tema</b><span>Claro, escuro ou igual ao sistema</span></div>
        <div class="seg">${[['auto', 'Auto'], ['light', 'Claro'], ['dark', 'Escuro']].map(([k, l]) => `<button data-theme="${k}" aria-pressed="${st.theme === k}">${l}</button>`).join('')}</div></div>
      <div class="set"><div class="l"><b>Tamanho do texto</b><span id="fsv">${st.fs}px</span></div>
        <div class="fsz"><button data-fs="-1" aria-label="Diminuir">A−</button><button data-fs="1" aria-label="Aumentar">A+</button></div></div>
    </div>
    <div class="sec">Criação automática (Claude API)</div>
    <div class="card" style="margin-top:10px">
      <label class="field"><b>Chave da API</b><span class="muted" style="font-size:13px">Cria-a em console.anthropic.com → API Keys. Fica guardada só neste dispositivo.</span>
        <div class="keyrow"><input type="password" id="kIn" placeholder="${hasKey ? 'Chave guardada ✓' : 'sk-ant-…'}" autocomplete="off"><button class="btn" data-act="savekey">Guardar</button></div></label>
      ${hasKey ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px"><button class="btn" data-act="testkey">Testar chave</button><button class="btn danger" data-act="delkey">Apagar chave</button></div>` : ''}
      <div class="set" style="margin-top:8px"><div class="l"><b>Modelo</b><span>Quem prepara os episódios</span></div>
        <select id="mSel">${MODELS.map(([v, l]) => `<option value="${v}" ${st.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="set"><div class="l"><b>Traduções em</b></div>
        <div class="seg">${[['pt-PT', 'Português PT'], ['pt-BR', 'Português BR']].map(([k, l]) => `<button data-variant="${k}" aria-pressed="${(st.variant || 'pt-PT') === k}">${l}</button>`).join('')}</div></div>
    </div>
    <div class="sec">Episódios neste dispositivo</div>
    <div class="card" style="margin-top:10px">
      ${S.episodes.length ? S.episodes.map(ep => `<div class="set"><div class="l"><b>${esc(ep.title)}</b><span>${esc(ep.series || '')}</span></div><div style="display:flex;gap:6px"><button class="btn" data-exp="${esc(ep.id)}">Exportar</button><button class="btn danger" data-del="${esc(ep.id)}">Apagar</button></div></div>`).join('') : '<p class="muted" style="margin:0">Ainda não importaste nenhum.</p>'}
      <div class="set"><div class="l"><b>Armazenamento</b><span>${esc(est)}${persisted ? ' · protegido contra limpeza automática' : ''}</span></div><button class="btn" data-act="import">${icons.plus} Importar</button></div>
    </div>
    <div class="sec">Sincronizar entre PC e telemóvel</div>
    <div class="card" style="margin-top:10px">
      <p style="margin-top:0" class="muted">Tudo fica só neste dispositivo. Para passar um episódio criado no PC para o telemóvel, usa «Exportar» ao lado do episódio e importa o ficheiro no outro dispositivo. Para o progresso (onde ficaste, palavras que sabes), usa o botão abaixo.</p>
      <button class="btn" data-act="backup">Exportar progresso</button>
    </div>
    <div class="sec">Instalar como app</div>
    <div class="card" style="margin-top:10px">
      <ol class="steps">
        <li><b>iPhone:</b> no Safari, botão Partilhar → «Adicionar ao ecrã principal».</li>
        <li><b>Android:</b> no Chrome, menu ⋮ → «Instalar app».</li>
        <li><b>PC:</b> no Chrome ou Edge, ícone de instalar na barra de endereço.</li>
      </ol>
      <p class="muted" style="margin-bottom:0">Depois de instalada, abre sem internet. Importa os episódios dentro da app instalada (no iPhone a app e o Safari guardam dados em separado).</p>
    </div>
    <div style="height:24px"></div></div>${bottomNav('set')}`;
  $('#mSel').onchange = e => { st.model = e.target.value; saveKV('settings'); };
  $('#app').onclick = async e => {
    const t = e.target.closest('[data-theme]'); if (t) { st.theme = t.dataset.theme; applySettings(); saveKV('settings'); viewSettings(); return; }
    const f = e.target.closest('[data-fs]'); if (f) { st.fs = Math.max(15, Math.min(28, st.fs + +f.dataset.fs)); applySettings(); saveKV('settings'); $('#fsv').textContent = st.fs + 'px'; return; }
    const d = e.target.closest('[data-del]');
    if (d && confirm('Apagar este episódio deste dispositivo?')) {
      await db.del('episodes', d.dataset.del); await db.del('audio', d.dataset.del); delete S.progress[d.dataset.del]; saveKV('progress', 0);
      await loadAll(); viewSettings(); toast('Episódio apagado'); return;
    }
    if (e.target.closest('[data-act=import]')) pickFiles();
    if (e.target.closest('[data-act=backup]')) exportBackup();
    const x = e.target.closest('[data-exp]'); if (x) { exportEpisode(x.dataset.exp); return; }
    const vb = e.target.closest('[data-variant]'); if (vb) { st.variant = vb.dataset.variant; saveKV('settings'); viewSettings(); return; }
    if (e.target.closest('[data-act=savekey]')) {
      const v = $('#kIn').value.trim(); if (!v) return toast('Cola a chave primeiro');
      if (!v.startsWith('sk-')) return toast('Isto não parece uma chave da API (começa por sk-ant-)');
      await db.put('kv', v, 'apikey'); toast('Chave guardada'); viewSettings(); return;
    }
    if (e.target.closest('[data-act=delkey]') && confirm('Apagar a chave deste dispositivo?')) { await db.del('kv', 'apikey'); viewSettings(); return; }
    if (e.target.closest('[data-act=testkey]')) {
      toast('A testar…');
      try { await testKey(await db.get('kv', 'apikey'), st.model); toast('A chave funciona ✓'); } catch (err) { toast(err.message, 5000); }
    }
  };
}

/* ---------------- boot ---------------- */
(async () => {
  try { await loadAll(); } catch (e) { console.error(e); toast('Erro a abrir a base de dados local'); }
  applySettings(); route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
})();
