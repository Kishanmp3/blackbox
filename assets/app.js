import { SAMPLES, importTrace, metrics, flags, toMessages, toolDefs, uid } from './trace.js';
import { RUNTIME_TOOLS, runtimeDefs, forkExecutor, runAgent } from './recorder.js';
import { claude, aiStatus, textOf, extractJSON, setupKeyUI } from './ai-client.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } } };
const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('on'), 2800); };
const fmtT = (ms) => { const s = Math.max(0, ms) / 1000; return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString();
const price = () => LS.get('bb.price', { in: 3, out: 15 });
const str = (v) => typeof v === 'string' ? v : JSON.stringify(v, null, 2);

const state = { mine: LS.get('bb.flights', []), cur: null, sel: 0, t: 0, view: [0, 1], playing: false, compare: false, live: false };
const saveMine = () => { if (!LS.set('bb.flights', state.mine)) toast('Browser storage is full. Export and delete old flights.'); };
const all = () => [...SAMPLES, ...state.mine];
const byId = (id) => all().find(f => f.id === id);

/* ---------- library ---------- */
function renderLib() {
  const item = (f, branch) => `<li class="${branch ? 'branch' : ''}"><button data-open="${f.id}" ${state.cur?.id === f.id ? 'aria-current="true"' : ''}>${!f.source || f.source === 'sample' ? '' : `<span class="del" data-del="${f.id}" role="button" aria-label="Delete">Delete</span>`}${esc(f.name)}<small>${f.steps.length} steps${f.forkAt != null ? `, forked at ${f.forkAt + 1}` : ''}${f.source === 'live' ? ', live' : ''}</small></button></li>`;
  const tree = (list, parent) => list.filter(f => (f.parentId || null) === parent).map(f => item(f, !!parent) + tree(state.mine, f.id)).join('');
  $('#libSamples').innerHTML = SAMPLES.map(f => item(f) + tree(state.mine, f.id)).join('');
  const roots = state.mine.filter(f => !f.parentId || !byId(f.parentId));
  $('#libMine').innerHTML = roots.length ? roots.map(f => item(f) + tree(state.mine, f.id)).join('') : '<li class="empty">Import, record or fork a flight and it shows up here.</li>';
  $$('[data-open]').forEach(b => b.onclick = (e) => { if (e.target.dataset.del) { e.stopPropagation(); del(e.target.dataset.del); return; } open(byId(b.dataset.open)); });
}
function del(id) { const kill = new Set([id]); let grew = true; while (grew) { grew = false; for (const f of state.mine) if (kill.has(f.parentId) && !kill.has(f.id)) { kill.add(f.id); grew = true; } } state.mine = state.mine.filter(f => !kill.has(f.id)); saveMine(); if (kill.has(state.cur?.id)) open(SAMPLES[0]); else renderLib(); toast(kill.size > 1 ? `Deleted with ${kill.size - 1} branch${kill.size > 2 ? 'es' : ''}` : 'Deleted'); }

/* ---------- open ---------- */
function open(f) {
  if (!f) return; stop(); state.cur = f; state.sel = Math.min(state.sel, f.steps.length - 1); state.sel = f.steps.findIndex(s => s.type !== 'system'); if (state.sel < 0) state.sel = 0;
  state.compare = false; $('#bCompare').textContent = 'Compare'; state.flags = flags(f); state.m = metrics(f, price()); fit(); state.t = f.steps[state.sel]?.t0 || 0;
  $('#fName').value = f.name; $('#fMeta').textContent = `${f.model || 'model unknown'}, ${f.source || 'sample'}${f.steps.some(s => s.synthetic) ? ', timing estimated' : ''}`;
  $('#bCompare').hidden = !f.parentId || !byId(f.parentId);
  try { history.replaceState(null, '', '#' + (f.source === 'sample' ? f.id : 'flight')); } catch {}
  renderAll();
}
const renderAll = () => { renderLib(); renderGauges(); renderTL(); renderSteps(); renderInsp(); };
$('#fName').onchange = (e) => { const f = state.cur; f.name = e.target.value.trim() || f.name; if (f.source !== 'sample') saveMine(); renderLib(); };

/* ---------- gauges ---------- */
function renderGauges() {
  const m = state.m = metrics(state.cur, price()); const p = state.compare ? metrics(byId(state.cur.parentId), price()) : null;
  const d = (a, b, lowerBetter = true, f = (x) => x) => p ? (() => { const diff = a - b; if (Math.abs(diff) < 1e-9) return ''; return `<span class="delta ${(diff > 0) === lowerBetter ? 'up' : 'down'}">${diff > 0 ? '+' : ''}${f(diff)}</span>`; })() : '';
  const g = [
    ['Duration', fmtT(m.dur), d(m.dur, p?.dur, true, x => (x / 1000).toFixed(1) + 's')], ['Steps', m.steps, d(m.steps, p?.steps)], ['Model calls', m.modelCalls, d(m.modelCalls, p?.modelCalls)], ['Tool calls', m.toolCalls, d(m.toolCalls, p?.toolCalls)],
    ['Tool errors', m.errors, d(m.errors, p?.errors), m.errors > 0], ['Tokens in', fmtN(m.tin), d(m.tin, p?.tin, true, fmtN)], ['Tokens out', fmtN(m.tout), d(m.tout, p?.tout, true, fmtN)], ['Est. cost', '$' + m.cost.toFixed(4), d(m.cost, p?.cost, true, x => '$' + x.toFixed(4))], ['Flags', state.flags.length, p ? d(state.flags.length, flags(byId(state.cur.parentId)).length) : '', state.flags.length > 0],
  ];
  $('#gauges').innerHTML = g.map(([k, v, dd, hot]) => `<div class="gauge ${hot ? 'hot' : ''}"><b>${v}</b><span>${k}${dd}</span></div>`).join('');
  $('#flagCount').textContent = state.flags.length ? `${state.flags.length} flag${state.flags.length > 1 ? 's' : ''}` : '';
}

/* ---------- timeline ---------- */
const span = () => { const S = state.cur.steps; return [S[0].t0, Math.max(S.at(-1).t1, S[0].t0 + 1)]; };
function fit() { const [a, b] = span(); const pad = (b - a) * .02; state.view = [a - pad, b + pad]; }
function renderTL() {
  const f = state.cur, svg = $('#tl'), W = svg.clientWidth || 900, H = svg.clientHeight || 216, L = 64, R = W - 12; const [v0, v1] = state.view; const X = (t) => L + (t - v0) / (v1 - v0) * (R - L);
  const lanes = { user: 36, system: 36, model: 82, tool: 128 }; let h = '';
  // grid
  const stepMs = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 300000].find(s => (v1 - v0) / s < (R - L) / 80) || 600000;
  for (let t = Math.ceil(v0 / stepMs) * stepMs; t <= v1; t += stepMs) h += `<line x1="${X(t)}" x2="${X(t)}" y1="14" y2="${H - 6}" stroke="#222"/><text x="${X(t) + 3}" y="11" fill="#5d5d57" font-size="10" font-family="JetBrains Mono">${fmtT(t)}</text>`;
  h += `<g font-family="JetBrains Mono" font-size="10.5" fill="#6d6c66"><text x="8" y="${lanes.user + 4}">USER</text><text x="8" y="${lanes.model + 4}">MODEL</text><text x="8" y="${lanes.tool + 4}">TOOLS</text><text x="8" y="${H - 22}">CONTEXT</text></g>`;
  for (const y of [36, 82, 128]) h += `<line x1="${L}" x2="${R}" y1="${y}" y2="${y}" stroke="#262626"/>`;
  // ghost of parent
  if (state.compare) { const p = byId(f.parentId); for (const s of p.steps) { const y = lanes[s.type] + 15; h += `<rect x="${X(s.t0)}" y="${y}" width="${Math.max(2, X(s.t1) - X(s.t0))}" height="4" rx="1" fill="${s.type === 'model' ? '#7a3a18' : s.tool?.isError ? '#7a2020' : '#2a6466'}"/>`; } }
  // context area
  const m = state.m; const cH = 46, cY = H - 8; const pts = f.steps.map((s, i) => [X(s.t1), cY - m.series[i] / (m.peak || 1) * cH]);
  h += `<path d="M${X(f.steps[0].t0)} ${cY} ${pts.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')} L${X(f.steps.at(-1).t1)} ${cY} Z" fill="rgba(255,95,21,.13)" stroke="#FF5F15" stroke-width="1.2"/><text x="${R - 4}" y="${cY - cH - 4}" text-anchor="end" fill="#6d6c66" font-size="10" font-family="JetBrains Mono">peak ${fmtN(m.peak)} tokens</text>`;
  // flags
  for (const fl of state.flags) { const s = f.steps[fl.at]; const x = X(s.t0); h += `<g data-i="${fl.at}" class="fl"><line x1="${x}" x2="${x}" y1="18" y2="${lanes.tool + 14}" stroke="#FF3B3B" stroke-dasharray="3 3"/><path d="M${x - 6} 14 h12 l-6 9z" fill="#FF3B3B"><title>${esc(fl.title)}</title></path></g>`; }
  // steps
  f.steps.forEach((s, i) => { const y = lanes[s.type]; const x0 = X(s.t0), w = Math.max(3, X(s.t1) - x0); if (x0 > R || x0 + w < L) return; const c = s.type === 'model' ? '#FF5F15' : s.type === 'tool' ? (s.tool.isError ? '#FF3B3B' : '#5CE1E6') : '#F6F5F0';
    h += `<rect data-i="${i}" x="${x0}" y="${y - 11}" width="${w}" height="22" rx="3" fill="${c}" opacity="${s.forked ? 1 : .9}" ${i === state.sel ? 'stroke="#fff" stroke-width="2"' : ''} ${s.forked ? 'stroke-dasharray="3 2"' : ''}><title>${esc(summary(s))}</title></rect>`;
    if (s.simulated || s.via === 'simulated') h += `<rect x="${x0}" y="${y + 13}" width="${w}" height="3" fill="#B79CFF"/>`; });
  if (state.cur.forkAt != null) { const s = f.steps[state.cur.forkAt]; if (s) h += `<line x1="${X(s.t0)}" x2="${X(s.t0)}" y1="14" y2="${H - 6}" stroke="#5CE1E6" stroke-width="1.5"/><text x="${X(s.t0) + 4}" y="${H - 60}" fill="#5CE1E6" font-size="10.5" font-family="JetBrains Mono">fork</text>`; }
  h += `<line x1="${X(state.t)}" x2="${X(state.t)}" y1="14" y2="${H - 4}" stroke="#fff" stroke-width="1.5"/><path d="M${X(state.t) - 5} 14 h10 l-5 7z" fill="#fff"/>`;
  svg.innerHTML = h; $('#tClock').textContent = fmtT(state.t - span()[0]);
}
const tlX = (e) => { const r = $('#tl').getBoundingClientRect(); const L = 64, R = r.width - 12; const [v0, v1] = state.view; return v0 + (e.clientX - r.left - L) / (R - L) * (v1 - v0); };
let drag = null;
$('#tl').addEventListener('pointerdown', (e) => { const i = e.target.dataset?.i ?? e.target.parentElement?.dataset?.i; if (i != null) { select(+i, true); return; } drag = { x: e.clientX, view: [...state.view], moved: false }; $('#tl').setPointerCapture(e.pointerId); });
$('#tl').addEventListener('pointermove', (e) => { if (!drag) return; const r = $('#tl').getBoundingClientRect(); const dx = e.clientX - drag.x; if (Math.abs(dx) > 3) drag.moved = true; if (drag.moved && e.shiftKey) { const k = (drag.view[1] - drag.view[0]) / (r.width - 76); state.view = [drag.view[0] - dx * k, drag.view[1] - dx * k]; renderTL(); } else if (drag.moved) { seek(tlX(e)); } });
$('#tl').addEventListener('pointerup', (e) => { if (drag && !drag.moved) seek(tlX(e)); drag = null; });
$('#tl').addEventListener('wheel', (e) => { e.preventDefault(); const t = tlX(e); const [v0, v1] = state.view; if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { const k = (v1 - v0) * (e.deltaX || e.deltaY) / 800; state.view = [v0 + k, v1 + k]; } else { const z = Math.exp(e.deltaY * .0015); const nv0 = t - (t - v0) * z, nv1 = t + (v1 - t) * z; if (nv1 - nv0 > 50) state.view = [nv0, nv1]; } renderTL(); }, { passive: false });
$('#tFit').onclick = () => { fit(); renderTL(); };
new ResizeObserver(() => state.cur && renderTL()).observe($('#tlwrap'));
function seek(t) { const [a, b] = span(); state.t = Math.max(a, Math.min(b, t)); let i = 0; state.cur.steps.forEach((s, k) => { if (s.t0 <= state.t) i = k; }); if (i !== state.sel) { state.sel = i; renderSteps(); renderInsp(); } renderTL(); }
function select(i, scroll) { state.sel = Math.max(0, Math.min(state.cur.steps.length - 1, i)); state.t = state.cur.steps[state.sel].t0; const [v0, v1] = state.view; const s = state.cur.steps[state.sel]; if (s.t0 < v0 || s.t1 > v1) { const w = v1 - v0; state.view = [s.t0 - w * .2, s.t0 + w * .8]; } renderTL(); renderSteps(scroll); renderInsp(); }

/* ---------- playback ---------- */
let raf, last;
function play() { if (state.playing) return stop(); const [a, b] = span(); if (state.t >= b - 1) state.t = a; state.playing = true; $('#tPlay').textContent = 'Pause'; last = performance.now(); raf = requestAnimationFrame(tick); }
function stop() { state.playing = false; $('#tPlay').textContent = 'Play'; cancelAnimationFrame(raf); }
function tick(now) { const dt = (now - last) * +$('#tSpeed').value; last = now; const [, b] = span(); seek(state.t + dt); const [v0, v1] = state.view; if (state.t > v1 - (v1 - v0) * .1) { const w = v1 - v0; state.view = [state.t - w * .3, state.t + w * .7]; } if (state.t >= b) return stop(); raf = requestAnimationFrame(tick); }
$('#tPlay').onclick = play; $('#tPrev').onclick = () => select(state.sel - 1, true); $('#tNext').onclick = () => select(state.sel + 1, true);
addEventListener('keydown', (e) => { if (e.target.closest('input,textarea,select,dialog')) return; if (e.key === ' ') { e.preventDefault(); play(); } if (e.key === 'ArrowRight') { e.preventDefault(); select(state.sel + 1, true); } if (e.key === 'ArrowLeft') { e.preventDefault(); select(state.sel - 1, true); } if (e.key === 'f') openFork(); });

/* ---------- steps + inspector ---------- */
function summary(s) { if (s.type === 'tool') return `${s.tool.name}(${JSON.stringify(s.tool.input ?? {}).slice(0, 60)}) → ${String(s.tool.output).split('\n')[0].slice(0, 80)}`; if (s.type === 'model') return (s.text?.split('\n')[0] || '') + (s.calls?.length ? `${s.text ? '  ' : ''}[calls ${s.calls.map(c => c.name).join(', ')}]` : ''); return s.text?.split('\n')[0] || ''; }
function renderSteps(scroll) {
  const fl = {}; for (const f of state.flags) for (const i of f.steps) (fl[i] ||= []).push(f);
  $('#steps').innerHTML = state.cur.steps.map((s, i) => { const k = s.type === 'tool' && s.tool.isError ? 'err' : s.type; return `<li class="${s.forked ? 'forked' : ''}"><button data-s="${i}" ${i === state.sel ? 'aria-current="true"' : ''}><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="k ${k}">${s.type === 'tool' ? 'TOOL' : s.type.toUpperCase()}</span><span class="sum">${esc(summary(s))}</span><span>${s.via ? `<span class="via ${s.via}">${s.via}</span>` : ''}${fl[i] ? `<span class="f" title="${esc(fl[i].map(f => f.title).join('; '))}"> ⚑</span>` : ''}</span></button></li>`; }).join('');
  $$('[data-s]').forEach(b => b.onclick = () => select(+b.dataset.s));
  if (scroll) $(`[data-s="${state.sel}"]`)?.scrollIntoView({ block: 'nearest' });
}
function renderInsp() {
  const s = state.cur.steps[state.sel]; if (!s) { $('#insp').innerHTML = '<p class="empty-insp">No step selected.</p>'; return; }
  const fl = state.flags.filter(f => f.steps.includes(state.sel));
  const d = s.t1 - s.t0; const title = s.type === 'tool' ? s.tool.name : s.type === 'model' ? 'Model call' : s.type === 'user' ? 'User message' : 'System prompt';
  const meta = [`step ${state.sel + 1} of ${state.cur.steps.length}`, `at ${fmtT(s.t0 - span()[0])}`, d ? `${(d / 1000).toFixed(2)}s${s.synthetic ? ' (est.)' : ''}` : '', s.model ? s.model : '', s._in != null && s.type === 'model' ? `${fmtN(s._in)} in / ${fmtN(s._out)} out` : '', s.stop ? `stop: ${s.stop}` : '', s.via ? `tool: ${s.via}` : ''].filter(Boolean);
  let body = '';
  if (s.type === 'model') { if (s.text) body += `<div class="blockh">Said</div><div class="text">${esc(s.text)}</div>`; for (const c of s.calls || []) body += `<div class="blockh">Called ${esc(c.name)}</div><pre>${esc(str(c.input))}</pre>`; }
  else if (s.type === 'tool') { body += `<div class="blockh">Input</div><pre>${esc(str(s.tool.input ?? {}))}</pre><div class="blockh">${s.tool.isError ? 'Error' : 'Output'}</div><pre class="${s.tool.isError ? 'err' : ''}">${esc(s.tool.output)}</pre>`; }
  else body += `<div class="blockh">Text</div><pre>${esc(s.text)}</pre>`;
  const { system, messages } = toMessages(state.cur.steps.slice(0, state.sel + (s.type === 'model' ? 0 : 1)));
  const ctx = `<div class="blockh">Context the model saw ${s.type === 'model' ? 'for this call' : 'after this step'} (${messages.length} messages)</div><div class="ctxlist">${system ? `<div><b>system</b>${esc(system.slice(0, 140))}</div>` : ''}${messages.map(m => `<div><b>${m.role}</b>${esc(m.content.map(c => c.type === 'text' ? c.text : c.type === 'tool_use' ? `→ ${c.name}(${JSON.stringify(c.input).slice(0, 60)})` : `← ${String(c.content).slice(0, 60)}`).join('  ').slice(0, 180))}</div>`).join('')}</div>`;
  $('#insp').innerHTML = `<div class="ih"><div><h3>${esc(title)}</h3><div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div></div><button class="go" id="forkBtn" title="Fork from this step (F)">Fork from here</button></div>${fl.map(f => `<div class="flagcard"><b>${esc(f.title)}</b><span>${esc(f.detail)}</span></div>`).join('')}${body}${ctx}`;
  $('#forkBtn').onclick = openFork;
}

/* ---------- import ---------- */
function addFlight(f, openIt = true) { state.mine.unshift(f); saveMine(); if (openIt) open(f); else renderLib(); }
$('#bImport').onclick = () => { $('#impErr').hidden = true; $('#dImport').showModal(); };
$('#impGo').onclick = (e) => { try { const f = importTrace($('#impText').value, 'Imported flight'); f.source = f.source || 'import'; addFlight(f); toast(`Imported ${f.steps.length} steps`); } catch (err) { e.preventDefault(); $('#impErr').hidden = false; $('#impErr').textContent = err.message; } };
async function importFile(file) { try { const f = importTrace(await file.text(), file.name.replace(/\.\w+$/, '')); addFlight(f); toast(`Imported ${f.steps.length} steps from ${file.name}`); } catch (e) { toast(e.message); } }
$('#file').onchange = (e) => e.target.files[0] && importFile(e.target.files[0]);
const drop = $('#drop'); for (const ev of ['dragenter', 'dragover']) addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }); addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); }); addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) importFile(f); });

/* ---------- live recording ---------- */
$('#recTools').innerHTML = RUNTIME_TOOLS.map(t => `<label><input type="checkbox" value="${t.name}" checked><span><code>${t.name}</code><small>${esc(t.description)}</small></span></label>`).join('');
$('#bRecord').onclick = () => { $('#recErr').hidden = true; $('#dRecord').showModal(); };
$('#recGo').onclick = async (e) => {
  e.preventDefault(); const st = await aiStatus(); if (!st.ready) { $('#dRecord').close(); keyUI.open('Live recording runs on your own Anthropic API key. Add it, then start the recording again.'); return; }
  const task = $('#recTask').value.trim(), sys = $('#recSys').value.trim(); if (!task) return;
  const names = $$('#recTools input:checked').map(i => i.value); const tools = runtimeDefs().filter(t => names.includes(t.name));
  $('#dRecord').close();
  const f = { id: uid(), name: task.slice(0, 60), source: 'live', model: $('#recModel').value.trim() || st.model, createdAt: Date.now(), steps: [...(sys ? [{ id: uid(), type: 'system', text: sys, t0: 0, t1: 0 }] : []), { id: uid(), type: 'user', text: task, t0: 0, t1: 0 }] };
  state.mine.unshift(f); open(f); $('#fMeta').innerHTML = '<span class="live-dot"></span>Recording';
  const exec = async (name, input) => { const t = RUNTIME_TOOLS.find(x => x.name === name); return t ? { ...(await t.run(input || {})), via: 'live' } : { output: `Unknown tool ${name}`, isError: true }; };
  try {
    await runAgent({ system: sys, messages: [{ role: 'user', content: task }], tools, exec, model: $('#recModel').value.trim() || undefined, maxTurns: +$('#recTurns').value || 10,
      onStep: (s) => { delete s.via; f.steps.push(s); state.flags = flags(f); fit(); state.sel = f.steps.length - 1; state.t = s.t0; renderGauges(); renderTL(); renderSteps(true); renderInsp(); } });
    toast('Recording saved');
  } catch (err) { toast(`Recording stopped: ${err.message}`); }
  saveMine(); open(f);
};

/* ---------- fork ---------- */
let forkCfg = null;
function openFork() {
  const f = state.cur, i = state.sel, s = f.steps[i]; if (!s) return; $('#forkErr').hidden = true; $('#forkN').textContent = i + 1;
  const what = { system: ['Edit the system prompt. The run restarts from the first user message.', s.text], user: ['Edit this message. Everything after it is flown again.', s.text], tool: ['Edit what this tool returned. The model continues from the new result.', s.tool?.output], model: ["Re-fly this model call. Change the model or temperature to see if it decides differently.", null] }[s.type];
  $('#forkWhat').textContent = what[0]; $('#forkEditL').hidden = what[1] == null; $('#forkEdit').value = what[1] ?? ''; $('#forkModel').value = ''; $('#forkTemp').value = '';
  forkCfg = { f, i }; $('#dFork').showModal();
}
$('#forkGo').onclick = async (e) => {
  e.preventDefault(); const st = await aiStatus(); if (!st.ready) { $('#dFork').close(); keyUI.open('Forks are flown by Claude on your own Anthropic API key. Add it, then fork again.'); return; }
  const { f, i } = forkCfg; const s = f.steps[i]; const edited = $('#forkEdit').value;
  let base;
  if (s.type === 'system') { const firstModel = f.steps.findIndex(x => x.type === 'model'); base = f.steps.slice(0, firstModel < 0 ? f.steps.length : firstModel).map(x => x === s ? { ...x, text: edited, id: uid(), forked: true } : x); }
  else if (s.type === 'model') base = f.steps.slice(0, i);
  else { let end = i + 1; if (s.type === 'tool') while (f.steps[end]?.type === 'tool') end++; base = f.steps.slice(0, end).map(x => x === s ? (s.type === 'tool' ? { ...x, id: uid(), forked: true, tool: { ...x.tool, output: edited, isError: /^error\b/i.test(edited) } } : { ...x, id: uid(), forked: true, text: edited }) : x); }
  const forkAt = s.type === 'system' ? f.steps.indexOf(s) : s.type === 'model' ? i : i;
  const nf = { id: uid(), name: `${f.name} (fork at ${i + 1})`, parentId: f.id, forkAt, source: 'fork', model: $('#forkModel').value.trim() || f.model, createdAt: Date.now(), steps: base.map(x => ({ ...x })) };
  $('#dFork').close(); state.mine.unshift(nf); open(nf); $('#fMeta').innerHTML = '<span class="live-dot"></span>Flying the fork';
  const { system, messages } = toMessages(base); const tools = toolDefs(f); for (const d of runtimeDefs()) if (!tools.some(t => t.name === d.name) && f.steps.some(x => x.tool?.name === d.name)) tools.push(d);
  const offset = (base.at(-1)?.t1 || 0) + 30;
  try {
    if (messages.at(-1)?.role !== 'user') throw new Error('There is nothing for the model to answer at this point. Pick a user or tool step, or a model call.');
    await runAgent({ system, messages, tools, exec: forkExecutor(f, $('#forkMode').value), model: $('#forkModel').value.trim() || undefined, temperature: $('#forkTemp').value === '' ? undefined : +$('#forkTemp').value, maxTurns: +$('#forkTurns').value || 8, clock: performance.now() - offset,
      onStep: (x) => { x.forked = true; nf.steps.push(x); state.flags = flags(nf); fit(); state.sel = nf.steps.length - 1; state.t = x.t0; renderGauges(); renderTL(); renderSteps(true); renderInsp(); } });
    toast('Fork landed. Use Compare to line it up with the original.');
  } catch (err) { toast(`Fork stopped: ${err.message}`); }
  saveMine(); open(nf); state.compare = true; $('#bCompare').textContent = 'Hide compare'; renderAll();
};
$('#bCompare').onclick = () => { state.compare = !state.compare; $('#bCompare').textContent = state.compare ? 'Hide compare' : 'Compare'; renderGauges(); renderTL(); toast(state.compare ? 'Original run shown as thin bars, gauges show the difference' : 'Compare off'); };

/* ---------- report ---------- */
function reportForm(r, f) {
  const sev = (r.severity || 'medium').toLowerCase();
  return `<div class="form"><div class="fh"><div><small>Flight</small><b>${esc(f.name)}</b></div><div><small>Steps</small><b>${f.steps.length}</b></div><div><small>Duration</small><b>${fmtT(state.m.dur)}</b></div><div><small>Severity</small><span class="sev ${sev}">${sev[0].toUpperCase() + sev.slice(1)}</span></div></div>
    <div class="fr"><div>Summary</div><div>${esc(r.summary)}</div></div>
    <div class="fr"><div>Probable cause</div><div>${esc(r.probable_cause)}</div></div>
    ${r.contributing?.length ? `<div class="fr"><div>Contributing factors</div><div><ol>${r.contributing.map(c => `<li>${esc(c)}</li>`).join('')}</ol></div></div>` : ''}
    ${r.timeline?.length ? `<div class="fr"><div>Key moments</div><div><ul>${r.timeline.map(t => `<li><a href="#" data-goto="${(t.step || 1) - 1}">Step ${t.step}</a>: ${esc(t.note)}</li>`).join('')}</ul></div></div>` : ''}
    ${r.recommendations?.length ? `<div class="fr"><div>Recommendations</div><div><ol>${r.recommendations.map(c => `<li>${esc(c)}</li>`).join('')}</ol></div></div>` : ''}
    <div class="fr"><div>Prepared by</div><div>${esc(r.by)}</div></div></div>`;
}
function localReport(f) {
  const F = state.flags; const m = state.m; const worst = F.find(x => x.severity === 'high') || F[0];
  return { severity: F.some(x => x.severity === 'high') ? 'high' : F.length ? 'medium' : 'low',
    summary: `${m.modelCalls} model calls and ${m.toolCalls} tool calls over ${fmtT(m.dur)}, about ${fmtN(m.tin + m.tout)} tokens ($${m.cost.toFixed(4)} estimated). ${F.length ? `${F.length} issue${F.length > 1 ? 's' : ''} flagged.` : 'No issues flagged.'}`,
    probable_cause: worst ? `${worst.title}. ${worst.detail}` : 'Nothing went obviously wrong. Check the final answer against what the user asked.',
    contributing: F.filter(x => x !== worst).map(x => `${x.title} (step ${x.at + 1})`),
    timeline: F.map(x => ({ step: x.at + 1, note: x.title })),
    recommendations: [...new Set(F.map(x => ({ loop: 'Detect repeated identical tool calls and force a change of approach after two.', errors: 'Back off between retries and hand off after two failures.', error: 'Surface tool errors to the model with a clear next step.', slow: 'Add a timeout or cache for the slow step.', truncated: 'Raise max_tokens or ask for shorter answers.', unfinished: 'Make sure the loop always ends with a final model message.', claim: 'Verify claimed actions against successful tool results before replying.' }[x.kind])))],
    by: 'Blackbox detectors. Ask Claude for the full investigation.' };
}
$('#bReport').onclick = () => { $('#repBody').innerHTML = reportForm(localReport(state.cur), state.cur); bindGoto(); $('#repAI').disabled = false; $('#dReport').showModal(); };
$('#repClose').onclick = () => $('#dReport').close();
function bindGoto() { $$('[data-goto]').forEach(a => a.onclick = (e) => { e.preventDefault(); $('#dReport').close(); select(+a.dataset.goto, true); }); }
$('#repAI').onclick = async () => {
  const st = await aiStatus(); if (!st.ready) { $('#dReport').close(); keyUI.open('The full report is written by Claude on your own Anthropic API key. Add it, then open the report again.'); return; }
  $('#repAI').disabled = true; $('#repAI').textContent = 'Investigating';
  const f = state.cur; const tape = f.steps.map((s, i) => `#${i + 1} ${s.type.toUpperCase()} t=${fmtT(s.t0)} d=${((s.t1 - s.t0) / 1000).toFixed(1)}s ${s.type === 'tool' ? `${s.tool.name} input=${JSON.stringify(s.tool.input).slice(0, 300)} ${s.tool.isError ? 'ERROR' : 'output'}=${String(s.tool.output).slice(0, 400)}` : s.type === 'model' ? `${(s.text || '').slice(0, 600)}${s.calls?.length ? ` CALLS ${s.calls.map(c => c.name + JSON.stringify(c.input).slice(0, 160)).join('; ')}` : ''}${s.stop ? ` stop=${s.stop}` : ''}` : (s.text || '').slice(0, 600)}`).join('\n');
  try {
    const res = await claude({ system: 'You are an incident investigator for AI agent runs, writing like an aviation accident report: factual, specific, step-referenced, no blame. Reply only with JSON: {"severity": "high"|"medium"|"low", "summary": 1-2 sentences, "probable_cause": 1-3 sentences, "contributing": [strings], "timeline": [{"step": number, "note": string}] (3-6 key moments), "recommendations": [concrete engineering fixes, 2-5]}. If the run went fine, say so and keep severity low.', messages: [{ role: 'user', content: `Flight: ${f.name}\nDetector flags: ${JSON.stringify(state.flags.map(x => ({ step: x.at + 1, title: x.title })))}\n\nTape:\n${tape.slice(0, 60000)}` }], max_tokens: 1600 });
    const r = extractJSON(textOf(res)); r.by = `Claude (${res.model}), with Blackbox detectors`;
    $('#repBody').innerHTML = reportForm(r, f); bindGoto();
  } catch (e) { toast(`Report failed: ${e.message}`); }
  $('#repAI').disabled = false; $('#repAI').textContent = 'Write the full report with Claude';
};

/* ---------- export & settings ---------- */
$('#bExport').onclick = () => { const f = state.cur; const blob = new Blob([JSON.stringify({ blackbox: 1, ...f }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${f.name.replace(/\W+/g, '-').toLowerCase().slice(0, 50)}.blackbox.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); toast('Flight exported'); };
const keyUI = setupKeyUI({ dialog: '#dSettings', button: '#bSettings', labels: ['Add API key', 'API key added'], toast });
$('#bSettings').addEventListener('click', () => { const p = price(); $('#sPin').value = p.in; $('#sPout').value = p.out; });
$('#sSave').addEventListener('click', () => { LS.set('bb.price', { in: +$('#sPin').value || 0, out: +$('#sPout').value || 0 }); renderGauges(); });

/* ---------- boot ---------- */
const h = location.hash.slice(1);
open(byId(h) || (h === 'record' ? SAMPLES[0] : SAMPLES[0]));
if (h === 'record') $('#bRecord').click();
window.__bb = { state, open, select };
