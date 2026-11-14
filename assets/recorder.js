// Runs Claude agent loops while recording every step, for live flights and forks.
import { claude, textOf } from './ai-client.js';
import { uid, sameInput } from './trace.js';

const workerSrc = `self.onmessage = (e) => { const logs = []; const fmt = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch { return String(v); } };
  const console = { log: (...a) => logs.push(a.map(fmt).join(' ')), error: (...a) => logs.push('error: ' + a.map(fmt).join(' ')) };
  try { const r = (new Function('console', '"use strict";\\n' + e.data))(console); postMessage({ ok: true, out: logs.join('\\n') + (r !== undefined ? (logs.length ? '\\n' : '') + '=> ' + fmt(r) : '') }); }
  catch (err) { postMessage({ ok: false, out: logs.join('\\n') + (logs.length ? '\\n' : '') + err.name + ': ' + err.message }); } };`;
const memory = new Map();
export const RUNTIME_TOOLS = [
  { name: 'run_js', description: 'Run a JavaScript snippet in a sandbox (no network, no DOM, 3 second limit). Use console.log or return a value.', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    run: ({ code }) => new Promise((res) => { const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }))); const t = setTimeout(() => { w.terminate(); res({ output: 'Timed out after 3 seconds', isError: true }); }, 3000); w.onmessage = (e) => { clearTimeout(t); w.terminate(); res({ output: e.data.out || '(no output)', isError: !e.data.ok }); }; w.postMessage(String(code)); }) },
  { name: 'fetch_url', description: 'Fetch a public web page and return readable text (first 5000 characters).', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => { const r = await fetch('/api/fetch?url=' + encodeURIComponent(url)); const j = await r.json(); if (j.error) return { output: j.error, isError: true }; return { output: `${j.title ? j.title + '\n' : ''}${j.text.slice(0, 5000)}` }; } },
  { name: 'remember', description: 'Save a value under a key for later in this session.', input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] },
    run: ({ key, value }) => { memory.set(key, value); return { output: `Saved "${key}"` }; } },
  { name: 'recall', description: 'Read a value saved with remember.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: ({ key }) => memory.has(key) ? { output: memory.get(key) } : { output: `Nothing saved under "${key}"`, isError: true } },
  { name: 'current_time', description: 'The current date and time in a time zone.', input_schema: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA zone, e.g. Europe/Paris' } } },
    run: ({ timezone }) => { try { return { output: new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'long', timeZone: timezone || undefined }).format(new Date()) }; } catch { return { output: `Unknown time zone ${timezone}`, isError: true }; } } },
];
export const runtimeDefs = () => RUNTIME_TOOLS.map(({ run, ...d }) => d);

/** Tool executor for forks: real runtime tool, else replay a recorded identical call, else simulate with Claude. */
export function forkExecutor(trace, mode = 'auto') {
  const recorded = trace.steps.filter(s => s.type === 'tool');
  return async (name, input) => {
    const rt = RUNTIME_TOOLS.find(t => t.name === name);
    if (rt && mode !== 'simulate') return { ...(await rt.run(input || {})), via: 'live' };
    const hit = recorded.find(s => s.tool.name === name && sameInput(s.tool.input, input));
    if (hit && mode !== 'simulate') return { output: hit.tool.output, isError: hit.tool.isError, via: 'replay' };
    const examples = recorded.filter(s => s.tool.name === name).slice(0, 4).map(s => `input: ${JSON.stringify(s.tool.input)}\noutput: ${String(s.tool.output).slice(0, 600)}${s.tool.isError ? ' (error)' : ''}`).join('\n\n');
    const res = await claude({ system: 'You simulate a software tool during a what-if replay of an AI agent run. Return ONLY the raw tool output the real tool would most plausibly return, matching the style of the recorded examples. If the recorded examples show the service failing, keep failing unless the input differs in a way that would fix it. No commentary.', messages: [{ role: 'user', content: `Tool: ${name}\n\nRecorded calls:\n${examples || '(none)'}\n\nNew input: ${JSON.stringify(input)}` }], max_tokens: 800, temperature: .3 });
    const out = textOf(res).trim(); return { output: out, isError: /^error\b/i.test(out), via: 'simulated' };
  };
}

/** Agent loop. Calls onStep(step) for every recorded step. Returns final steps. */
export async function runAgent({ system, messages, tools, exec, model, temperature, maxTurns = 12, onStep, signal, clock }) {
  const t0 = clock ?? performance.now(); const now = () => Math.round(performance.now() - t0); const steps = []; const msgs = structuredClone(messages);
  const push = (s) => { steps.push(s); onStep?.(s, steps); };
  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) break;
    const st = now(); const res = await claude({ system, messages: msgs, tools: tools.length ? tools : undefined, max_tokens: 3000, ...(model ? { model } : {}), ...(temperature != null ? { temperature } : {}) });
    const calls = res.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
    push({ id: uid(), type: 'model', t0: st, t1: now(), model: res.model, text: textOf(res), calls, usage: { in: res.usage?.input_tokens, out: res.usage?.output_tokens }, stop: res.stop_reason });
    msgs.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use' || !calls.length) break;
    const results = [];
    for (const c of calls) {
      if (signal?.aborted) break;
      const ts = now(); let r; try { r = await exec(c.name, c.input); } catch (e) { r = { output: e.message, isError: true }; }
      push({ id: uid(), type: 'tool', t0: ts, t1: Math.max(now(), ts + 1), tool: { callId: c.id, name: c.name, input: c.input, output: String(r.output ?? ''), isError: !!r.isError }, via: r.via });
      results.push({ type: 'tool_result', tool_use_id: c.id, content: String(r.output ?? '').slice(0, 20000), is_error: !!r.isError });
    }
    msgs.push({ role: 'user', content: results });
  }
  return steps;
}
