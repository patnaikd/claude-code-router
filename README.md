# Claude Code Router

A local Anthropic-compatible proxy for Claude Code that routes model calls, logs request/response traffic, and shows a live web dashboard.

Claude Code supports `ANTHROPIC_BASE_URL`, so you can point it at this proxy:

```sh
npm start
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=sk-ant-...
claude
```

Open `http://localhost:8787` to inspect captured calls.

## What It Does

- Proxies Claude Code API calls to Anthropic or another Anthropic-compatible gateway.
- Routes by requested model using `config/routes.example.json` as the template.
- Logs redacted headers, request bodies, response bodies, status, duration, route, model, and target URL.
- Keeps streaming responses streaming while capturing a bounded preview.
- Persists logs as JSONL at `.router-logs/calls.jsonl` by default.
- Streams new log entries to the dashboard with server-sent events.

## Configuration

Copy the example and point `ROUTER_CONFIG` at it:

```sh
cp config/routes.example.json config/routes.json
ROUTER_CONFIG=config/routes.json npm start
```

Route entries match the request JSON `model` field:

```json
{
  "name": "gateway-sonnet",
  "match": { "model": "claude-sonnet-4-20250514" },
  "target": {
    "baseUrl": "https://your-anthropic-compatible-gateway.example.com",
    "apiKeyEnv": "GATEWAY_API_KEY",
    "model": "gateway/sonnet"
  }
}
```

You can put the upstream API key directly in `routes.json` instead of using an environment variable:

```json
{
  "default": {
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-..."
  },
  "routes": []
}
```

Route-specific keys work the same way:

```json
{
  "name": "gateway-sonnet",
  "match": { "model": "claude-sonnet-4-20250514" },
  "target": {
    "baseUrl": "https://your-anthropic-compatible-gateway.example.com",
    "apiKey": "gateway-key-here"
  }
}
```

`config/routes.json` is ignored by git because it may contain secrets. Keep using `apiKeyEnv` for shared examples and committed config.

Supported matchers:

- `model`: exact model match.
- `modelIncludes`: substring match.
- `models`: array of exact model names.

Useful environment variables:

- `PORT`: local server port, default `8787`.
- `ROUTER_CONFIG`: path to route config JSON.
- `ROUTER_LOG_PATH`: JSONL log path, default `.router-logs/calls.jsonl`.
- `ANTHROPIC_API_KEY`: default upstream key when `apiKeyEnv` is unchanged.

## Security Notes

Authorization, API key, and cookie headers are redacted in stored logs. Request and response bodies are captured because the dashboard is meant for inspection; use this only on a trusted local machine or adjust `MAX_CAPTURE_BYTES` in `src/proxy.js` before collecting sensitive traffic.
