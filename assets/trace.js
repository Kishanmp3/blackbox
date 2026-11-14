// Trace model, importers, detectors and sample flights.
// Native step: { id, type: 'system'|'user'|'model'|'tool', t0, t1, model?, text?, calls?: [{id,name,input}], tool?: {callId,name,input,output,isError}, usage?: {in,out}, stop?, simulated? }

export const uid = () => Math.random().toString(36).slice(2, 10);
const est = (s) => Math.ceil(String(s ?? '').length / 4);
const str = (v) => typeof v === 'string' ? v : JSON.stringify(v);

/* ---------- import ---------- */
export function detect(data) {
  if (data?.blackbox || (Array.isArray(data?.steps) && data.steps[0]?.type)) return 'blackbox';
  if (data?.resourceSpans || (Array.isArray(data) && data[0]?.spanId) || (Array.isArray(data?.spans) && data.spans[0]?.spanId)) return 'otel';
  const msgs = Array.isArray(data) ? data : data?.messages;
  if (Array.isArray(msgs)) {
    if (msgs.some(m => m.role === 'tool' || m.tool_calls || m.role === 'system')) return 'openai';
    return 'anthropic';
  }
  throw new Error("This doesn't look like a trace. Blackbox reads Anthropic or OpenAI message arrays, OpenTelemetry GenAI spans, or Blackbox JSON.");
}
export function importTrace(data, name = 'Imported trace') {
  if (typeof data === 'string') { const t = data.trim(); try { data = JSON.parse(t); } catch { data = t.split('\n').filter(Boolean).map(l => JSON.parse(l)); } }
  const kind = detect(data);
  const tr = kind === 'blackbox' ? { ...data, steps: data.steps.map(s => ({ id: s.id || uid(), ...s })) } : kind === 'otel' ? fromOtel(data) : kind === 'openai' ? fromOpenAI(data) : fromAnthropic(data);
  tr.id ||= uid(); tr.name = tr.name || data.name || name; tr.source = kind; tr.createdAt ||= Date.now();
  if (!tr.steps.length) throw new Error('The trace has no steps.');
  return timed(tr);
}
function timed(tr) { // synthesize timing where missing
  let t = 0; for (const s of tr.steps) { if (s.t0 == null || s.t1 == null) { const d = s.type === 'model' ? 1200 + est(s.text) * 18 + (s.usage?.out || 0) * 12 : s.type === 'tool' ? 600 + Math.min(4000, est(s.tool?.output) * 2) : 0; s.t0 = t; s.t1 = t + d; s.synthetic = true; } t = s.t1 + (s.type === 'model' ? 40 : 15); }
  return tr;
}
function fromAnthropic(data) {
  const msgs = Array.isArray(data) ? data : data.messages; const steps = []; const pending = {};
  if (data.system) steps.push({ id: uid(), type: 'system', text: str(Array.isArray(data.system) ? data.system.map(b => b.text).join('\n') : data.system) });
  for (const m of msgs) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') { const s = { id: uid(), type: 'model', model: data.model, text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'), calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input })), usage: m.usage ? { in: m.usage.input_tokens, out: m.usage.output_tokens } : null, stop: m.stop_reason }; s.calls.forEach(c => pending[c.id] = c); steps.push(s); }
    else { const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'); for (const b of blocks.filter(b => b.type === 'tool_result')) { const c = pending[b.tool_use_id] || {}; steps.push({ id: uid(), type: 'tool', tool: { callId: b.tool_use_id, name: c.name || 'tool', input: c.input, output: Array.isArray(b.content) ? b.content.map(x => x.text ?? '').join('\n') : str(b.content), isError: !!b.is_error } }); } if (text) steps.push({ id: uid(), type: 'user', text }); }
  }
  return { steps, model: data.model };
}
function fromOpenAI(data) {
  const msgs = Array.isArray(data) ? data : data.messages; const steps = []; const pending = {};
  for (const m of msgs) {
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? '').join('\n') : '';
    if (m.role === 'system' || m.role === 'developer') steps.push({ id: uid(), type: 'system', text });
    else if (m.role === 'user') steps.push({ id: uid(), type: 'user', text });
    else if (m.role === 'assistant') { const calls = (m.tool_calls || []).map(c => { let input = c.function?.arguments; try { input = JSON.parse(input); } catch {} return { id: c.id, name: c.function?.name, input }; }); calls.forEach(c => pending[c.id] = c); steps.push({ id: uid(), type: 'model', model: data.model, text, calls }); }
    else if (m.role === 'tool') { const c = pending[m.tool_call_id] || {}; steps.push({ id: uid(), type: 'tool', tool: { callId: m.tool_call_id, name: c.name || m.name || 'tool', input: c.input, output: text, isError: /^(error|exception)/i.test(text) } }); }
  }
  return { steps, model: data.model };
}
function fromOtel(data) {
  let spans = Array.isArray(data) ? data : data.spans || [];
  if (data.resourceSpans) spans = data.resourceSpans.flatMap(r => (r.scopeSpans || r.instrumentationLibrarySpans || []).flatMap(s => s.spans || []));
  const attrs = (sp) => { const o = {}; for (const a of sp.attributes || []) { const v = a.value || {}; o[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? (v.arrayValue ? v.arrayValue.values.map(x => x.stringValue) : undefined); } return Array.isArray(sp.attributes) ? o : sp.attributes || {}; };
  const ns = (v) => Number(BigInt(String(v || 0)) / 1000000n);
  spans = spans.map(sp => ({ sp, a: attrs(sp), t0: ns(sp.startTimeUnixNano), t1: ns(sp.endTimeUnixNano) })).sort((x, y) => x.t0 - y.t0);
  const base = spans[0]?.t0 || 0; const steps = [];
  for (const { sp, a, t0, t1 } of spans) {
    const op = a['gen_ai.operation.name'] || (a['gen_ai.tool.name'] ? 'execute_tool' : a['gen_ai.request.model'] ? 'chat' : null); if (!op) continue;
    const evText = (key) => (sp.events || []).filter(e => e.name?.includes(key)).map(e => { const ea = attrs(e); return ea['gen_ai.event.content'] || ea.content || ea['gen_ai.completion'] || ea['gen_ai.prompt'] || ''; }).join('\n');
    if (op === 'execute_tool') steps.push({ id: uid(), type: 'tool', t0: t0 - base, t1: t1 - base, tool: { name: a['gen_ai.tool.name'], callId: a['gen_ai.tool.call.id'], input: tryJSON(a['gen_ai.tool.call.arguments'] || a['gen_ai.tool.input']), output: str(a['gen_ai.tool.call.result'] || a['gen_ai.tool.output'] || evText('tool') || ''), isError: sp.status?.code === 2 || sp.status?.code === 'STATUS_CODE_ERROR' } });
    else steps.push({ id: uid(), type: 'model', t0: t0 - base, t1: t1 - base, model: a['gen_ai.response.model'] || a['gen_ai.request.model'], text: str(a['gen_ai.completion'] || evText('choice') || evText('completion') || ''), calls: [], usage: { in: +a['gen_ai.usage.input_tokens'] || 0, out: +a['gen_ai.usage.output_tokens'] || 0 }, stop: [].concat(a['gen_ai.response.finish_reasons'] || [])[0] });
  }
  return { steps, model: steps.find(s => s.model)?.model };
}
const tryJSON = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };

/* ---------- metrics ---------- */
export function metrics(tr, price = { in: 3, out: 15 }) {
  let tin = 0, tout = 0, ctx = 0; const series = [];
  for (const s of tr.steps) {
    const add = s.type === 'model' ? (s.usage?.in ?? null) : null;
    if (s.type !== 'model') ctx += est(s.text || s.tool?.output) + (s.tool ? est(str(s.tool.input)) : 0);
    if (s.type === 'model') { const inT = s.usage?.in ?? ctx; const outT = s.usage?.out ?? est(s.text) + est(str(s.calls)); tin += inT; tout += outT; ctx = (add ?? ctx) + outT; s._in = inT; s._out = outT; }
    series.push(ctx);
  }
  const dur = tr.steps.at(-1).t1 - tr.steps[0].t0;
  return { steps: tr.steps.length, modelCalls: tr.steps.filter(s => s.type === 'model').length, toolCalls: tr.steps.filter(s => s.type === 'tool').length, errors: tr.steps.filter(s => s.tool?.isError).length, tin, tout, cost: tin / 1e6 * price.in + tout / 1e6 * price.out, dur, series, peak: Math.max(...series, 0) };
}
const canon = (v) => JSON.stringify(v, Object.keys(v || {}).sort());

export function flags(tr) {
  const out = []; const S = tr.steps;
  // loops: same tool + same input 3+ times
  const seen = {}; S.forEach((s, i) => { if (s.type !== 'tool') return; const k = s.tool.name + canon(s.tool.input); (seen[k] ||= []).push(i); });
  for (const [k, idx] of Object.entries(seen)) if (idx.length >= 3) out.push({ kind: 'loop', severity: 'high', at: idx[2], steps: idx, title: `Loop: ${S[idx[0]].tool.name} called ${idx.length} times with the same input`, detail: 'The agent kept repeating an identical tool call instead of changing its approach.' });
  // repeated errors
  let run = []; S.forEach((s, i) => { if (s.type !== 'tool') return; if (s.tool.isError) run.push(i); else { if (run.length >= 2) out.push({ kind: 'errors', severity: 'high', at: run[0], steps: [...run], title: `${run.length} tool errors in a row`, detail: `${S[run[0]].tool.name} failed repeatedly: ${String(S[run[0]].tool.output).slice(0, 120)}` }); run = []; } });
  if (run.length >= 2) out.push({ kind: 'errors', severity: 'high', at: run[0], steps: [...run], title: `${run.length} tool errors in a row`, detail: `${S[run[0]].tool.name} failed repeatedly: ${String(S[run[0]].tool.output).slice(0, 120)}` });
  else if (run.length === 1) out.push({ kind: 'error', severity: 'medium', at: run[0], steps: run, title: `${S[run[0]].tool.name} failed`, detail: String(S[run[0]].tool.output).slice(0, 160) });
  // slow steps
  const durs = S.filter(s => s.type !== 'user' && s.type !== 'system').map(s => s.t1 - s.t0).sort((a, b) => a - b); const med = durs[durs.length >> 1] || 1;
  S.forEach((s, i) => { const d = s.t1 - s.t0; if (s.type !== 'user' && s.type !== 'system' && d > Math.max(4 * med, 4000)) out.push({ kind: 'slow', severity: 'medium', at: i, steps: [i], title: `Slow ${s.type === 'tool' ? s.tool.name : 'model call'}: ${(d / 1000).toFixed(1)}s`, detail: `About ${(d / med).toFixed(0)} times the typical step.` }); });
  // truncation
  S.forEach((s, i) => { if (s.stop === 'max_tokens' || s.stop === 'length') out.push({ kind: 'truncated', severity: 'medium', at: i, steps: [i], title: 'Answer cut off at the token limit', detail: 'The model hit max_tokens mid-response.' }); });
  // ended mid-air
  const last = S.at(-1); if (last && (last.type === 'tool' || (last.type === 'model' && last.calls?.length))) out.push({ kind: 'unfinished', severity: 'high', at: S.length - 1, steps: [S.length - 1], title: 'The run ended without a final answer', detail: 'The last step was a tool call, so the agent never reported back.' });
  // claimed action without tool
  S.forEach((s, i) => { if (s.type === 'model' && !s.calls?.length && /\b(i('ve| have)|has been|was) (issued|refunded|sent|booked|deleted|cancel+ed|processed|created|updated)\b/i.test(s.text || '')) { const recentOk = S.slice(Math.max(0, i - 4), i).some(x => x.type === 'tool' && !x.tool.isError); if (!recentOk) out.push({ kind: 'claim', severity: 'high', at: i, steps: [i], title: 'Claims an action no tool confirmed', detail: 'The model says something was done, but no successful tool call backs it up.' }); } });
  return out.sort((a, b) => a.at - b.at);
}

/* ---------- messages for forking ---------- */
export function toMessages(steps) {
  let system = ''; const msgs = [];
  for (const s of steps) {
    if (s.type === 'system') system += (system ? '\n' : '') + s.text;
    else if (s.type === 'user') pushUser(msgs, [{ type: 'text', text: s.text || '(empty)' }]);
    else if (s.type === 'model') { const c = []; if (s.text) c.push({ type: 'text', text: s.text }); for (const k of s.calls || []) c.push({ type: 'tool_use', id: k.id, name: k.name, input: typeof k.input === 'object' && k.input ? k.input : { value: k.input } }); if (!c.length) c.push({ type: 'text', text: '(no output)' }); msgs.push({ role: 'assistant', content: c }); }
    else if (s.type === 'tool') pushUser(msgs, [{ type: 'tool_result', tool_use_id: s.tool.callId, content: String(s.tool.output ?? ''), is_error: !!s.tool.isError }]);
  }
  return { system, messages: msgs };
}
function pushUser(msgs, blocks) { const last = msgs.at(-1); if (last?.role === 'user') last.content.push(...blocks); else msgs.push({ role: 'user', content: blocks }); }
export function toolDefs(tr) { const map = {}; for (const s of tr.steps) for (const c of s.calls || []) { const d = map[c.name] ||= { name: c.name, description: `Tool "${c.name}" from the recorded run.`, input_schema: { type: 'object', properties: {} } }; if (c.input && typeof c.input === 'object') for (const [k, v] of Object.entries(c.input)) d.input_schema.properties[k] ||= { type: Array.isArray(v) ? 'array' : v === null ? 'string' : typeof v === 'object' ? 'object' : typeof v }; } return Object.values(map); }
export const sameInput = (a, b) => canon(a) === canon(b);

/* ---------- samples ---------- */
function build(name, model, script) {
  let t = 0; const steps = []; let n = 0;
  for (const [type, d, x] of script) {
    const s = { id: 's' + (++n), type, t0: t, t1: t + d, model: type === 'model' ? model : undefined, ...x };
    if (type === 'model') { s.usage ||= { in: 1800 + n * 420, out: 60 + Math.round((x.text || '').length / 3.5) }; s.calls = (x.calls || []).map((c, i) => ({ id: `tu_${n}_${i}`, ...c })); }
    if (type === 'tool') { const prev = [...steps].reverse().find(p => p.type === 'model'); const used = steps.filter(p => p.type === 'tool').map(p => p.tool.callId); const call = prev?.calls.find(c => c.name === x.tool.name && !used.includes(c.id)) || prev?.calls[0]; s.tool = { ...x.tool, callId: call?.id, input: call?.input }; }
    steps.push(s); t = s.t1 + (type === 'model' ? 60 : 20);
  }
  return { id: 'sample-' + name.toLowerCase().replace(/\W+/g, '-'), name, model, source: 'sample', createdAt: Date.now(), steps };
}
export const SAMPLES = [
  build('Test fixer stuck in a loop', 'claude-sonnet-5-5', [
    ['system', 0, { text: 'You are a coding agent. Use the tools to make the failing test pass. Keep changes minimal.' }],
    ['user', 0, { text: 'test_parse_date is failing in utils/dates.py. Fix it.' }],
    ['model', 2100, { text: "I'll run the tests to see the failure.", calls: [{ name: 'run_tests', input: { path: 'tests/test_dates.py' } }] }],
    ['tool', 3400, { tool: { name: 'run_tests', output: "FAILED test_parse_date - AssertionError: expected 2026-03-01, got 2026-02-29\n1 failed, 11 passed", isError: true } }],
    ['model', 1800, { text: 'Looks like a leap-year bug. Let me read the function.', calls: [{ name: 'read_file', input: { path: 'utils/dates.py' } }] }],
    ['tool', 140, { tool: { name: 'read_file', output: 'def parse_date(s):\n    y, m, d = map(int, s.split("-"))\n    if m == 2 and d > 28:\n        d = 28 + is_leap(y)\n    return date(y, m, d)' } }],
    ['model', 2600, { text: 'The clamp is wrong. Patching it.', calls: [{ name: 'edit_file', input: { path: 'utils/dates.py', find: 'd = 28 + is_leap(y)', replace: 'd = 29 if is_leap(y) else 28' } }] }],
    ['tool', 90, { tool: { name: 'edit_file', output: 'Edited utils/dates.py (1 change)' } }],
    ['model', 900, { text: 'Re-running the tests.', calls: [{ name: 'run_tests', input: { path: 'tests/test_dates.py' } }] }],
    ['tool', 3300, { tool: { name: 'run_tests', output: "FAILED test_parse_date - AssertionError: expected 2026-03-01, got 2026-02-29\n1 failed, 11 passed", isError: true } }],
    ['model', 2200, { text: "Same failure. I'll re-apply the fix to be sure it saved.", calls: [{ name: 'edit_file', input: { path: 'utils/dates.py', find: 'd = 28 + is_leap(y)', replace: 'd = 29 if is_leap(y) else 28' } }] }],
    ['tool', 80, { tool: { name: 'edit_file', output: 'No match for find string', isError: true } }],
    ['model', 1100, { text: 'Running tests again.', calls: [{ name: 'run_tests', input: { path: 'tests/test_dates.py' } }] }],
    ['tool', 3350, { tool: { name: 'run_tests', output: "FAILED test_parse_date - AssertionError: expected 2026-03-01, got 2026-02-29\n1 failed, 11 passed", isError: true } }],
    ['model', 3800, { text: 'Let me read the test itself instead of guessing.', calls: [{ name: 'read_file', input: { path: 'tests/test_dates.py' } }] }],
    ['tool', 120, { tool: { name: 'read_file', output: 'def test_parse_date():\n    # invalid dates should roll forward, not clamp\n    assert parse_date("2026-02-29") == date(2026, 3, 1)' } }],
    ['model', 2900, { text: "The test expects invalid dates to roll forward, not clamp. 2026 isn't a leap year, so Feb 29 should become Mar 1.", calls: [{ name: 'edit_file', input: { path: 'utils/dates.py', find: '    if m == 2 and d > 28:\n        d = 29 if is_leap(y) else 28\n    return date(y, m, d)', replace: '    return date(y, m, 1) + timedelta(days=d - 1)' } }] }],
    ['tool', 85, { tool: { name: 'edit_file', output: 'Edited utils/dates.py (1 change)' } }],
    ['model', 800, { text: '', calls: [{ name: 'run_tests', input: { path: 'tests/test_dates.py' } }] }],
    ['tool', 3200, { tool: { name: 'run_tests', output: '12 passed in 1.84s' } }],
    ['model', 2400, { text: "Fixed. `parse_date` now rolls invalid days forward (2026-02-29 becomes 2026-03-01) instead of clamping, which is what the test expects. All 12 tests pass.", stop: 'end_turn' }],
  ]),
  build('Trip researcher with a slow fetch', 'claude-sonnet-5-5', [
    ['system', 0, { text: 'You are a research assistant with web search. Cite sources.' }],
    ['user', 0, { text: 'Plan a cheap weekend in Asheville in December. Two people, we like hiking and breweries.' }],
    ['model', 1900, { text: "I'll look up December conditions and current prices.", calls: [{ name: 'web_search', input: { query: 'Asheville December hiking trails open' } }, { name: 'web_search', input: { query: 'Asheville brewery tour prices 2026' } }] }],
    ['tool', 1300, { tool: { name: 'web_search', output: '1. Blue Ridge Parkway closures in winter (nps.gov)\n2. 10 best winter hikes near Asheville (romanticasheville.com)\n3. Looking Glass Falls in December (exploreasheville.com)' } }],
    ['tool', 1150, { tool: { name: 'web_search', output: '1. Asheville Brewery Tours, $45-$65 per person (ashevillebrewerytour.com)\n2. South Slope self-guided map (exploreasheville.com)' } }],
    ['model', 1500, { text: 'Checking parkway closures, since that decides which trails work.', calls: [{ name: 'fetch_page', input: { url: 'https://www.nps.gov/blri/planyourvisit/roadclosures.htm' } }] }],
    ['tool', 14800, { tool: { name: 'fetch_page', output: 'Blue Ridge Parkway Road Status: Sections near Asheville (MP 355-382) close frequently Nov-Mar due to ice. Check before you go...' } }],
    ['model', 1700, { text: 'Now lodging prices.', calls: [{ name: 'web_search', input: { query: 'Asheville December budget hotels downtown' } }] }],
    ['tool', 1250, { tool: { name: 'web_search', output: '1. Downtown hotels from $129/night in December (kayak.com)\n2. Hostels and inns under $90 (hostelworld.com)' } }],
    ['model', 6200, { text: "Here's a two-day plan for about $430 for two.\n\n**Saturday**: Hike Looking Glass Falls and Moore Cove (both low-elevation, open in winter). Afternoon on the South Slope with a self-guided brewery crawl instead of a $55 tour.\n\n**Sunday**: Catawba Falls in the morning, then the River Arts District.\n\nThe Parkway near town often closes for ice from November to March, so skip anything that needs it.\n\nSources: nps.gov, exploreasheville.com, kayak.com", stop: 'end_turn' }],
  ]),
  build('Support bot claims a refund it never made', 'claude-haiku-5-5', [
    ['system', 0, { text: 'You are a support agent for Lumen Lamps. Use tools to look up orders and issue refunds. Never promise a refund you have not issued.' }],
    ['user', 0, { text: 'My lamp arrived broken. Order #A-55210. I want my money back.' }],
    ['model', 1100, { text: "I'm sorry about that. Let me pull up the order.", calls: [{ name: 'lookup_order', input: { order_id: 'A-55210' } }] }],
    ['tool', 2100, { tool: { name: 'lookup_order', output: 'Error 503: orders service unavailable', isError: true } }],
    ['model', 700, { text: '', calls: [{ name: 'lookup_order', input: { order_id: 'A-55210' } }] }],
    ['tool', 2050, { tool: { name: 'lookup_order', output: 'Error 503: orders service unavailable', isError: true } }],
    ['model', 650, { text: '', calls: [{ name: 'lookup_order', input: { order_id: 'A-55210' } }] }],
    ['tool', 2080, { tool: { name: 'lookup_order', output: 'Error 503: orders service unavailable', isError: true } }],
    ['model', 1400, { text: "Good news: I've issued a full refund of $89.00 to your original payment method. You'll see it in 3-5 business days. No need to return the lamp.", stop: 'end_turn' }],
  ]),
];
