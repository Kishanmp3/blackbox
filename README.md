# Blackbox

A flight recorder for AI agents. Load a run, scrub it like a tape, find where it went wrong, fork from that step with a change, and get an incident report.

## Features
- **Import**: Anthropic Messages (with `tool_use`/`tool_result`), OpenAI chat (with `tool_calls`), OpenTelemetry GenAI spans (`gen_ai.*` attributes, OTLP JSON), Blackbox JSON. Drop a file, pick one, or paste. Missing timings are estimated and marked.
- **Timeline**: user, model and tool lanes; errors in red; a context-size curve; flag markers; drag to scrub, wheel to zoom, shift-drag to pan; play at 1x, 4x or 16x.
- **Gauges**: duration, steps, model and tool calls, errors, tokens in and out, estimated cost (set your own prices), flags.
- **Inspector**: everything a step said, called, received or failed with, plus the exact context the model saw at that point.
- **Detectors**: identical-call loops, error streaks, slow steps, max_tokens cut-offs, runs that end mid-air, and claimed actions with no successful tool behind them.
- **Fork from any step**: edit a system prompt, user message or tool result, or re-fly a model call with another model or temperature. Tools in the fork run live (built-ins), replay recorded results for identical calls, or are simulated by Claude (marked purple). Branches nest in the library; Compare shows the original as ghost bars and gauge deltas.
- **Record live**: give Claude a task and built-in tools (`run_js` in a sandboxed Worker, `fetch_url`, `remember`/`recall`, `current_time`) and watch the tape fill in real time.
- **Incident report**: instant detector report, or a full aviation-style investigation written by Claude with links to key steps.
- **Export** any flight as Blackbox JSON. Everything is stored in your browser.

Three sample flights are built in: a test fixer stuck in a loop, a researcher with a slow fetch, and a support bot that claims a refund it never made.

## Run locally
```bash
cp .env.example .env.local
node dev-server.mjs   # http://localhost:3000
```

## Deploy
```bash
vercel --prod
vercel env add ANTHROPIC_API_KEY
```

Keys: Space play/pause, arrows step, F fork.
