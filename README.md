# Claude Code Router

A local Anthropic-compatible proxy for Claude Code. It forwards Claude Code LLM API traffic, applies model-based routing rules, records request/response metadata, and shows the calls in a live web dashboard.

Claude Code can be pointed at the router with `ANTHROPIC_BASE_URL`.

## Quick Start

Install from this repo:

```sh
npm install -g github:patnaikd/claude-code-router
```

Run the CLI:

```sh
ccr
```

The CLI starts the proxy, opens the dashboard, finds the next free port if `8787` is busy, and launches Claude Code with:

```text
ANTHROPIC_BASE_URL=http://localhost:<selected-port>
```

You can pass Claude Code arguments after `--`:

```sh
ccr -- --model claude-sonnet-5
```

For local development without installing globally:

```sh
npm start
```

Open the dashboard:

```text
http://localhost:8787
```

In another terminal, launch Claude Code through the router:

```sh
export ANTHROPIC_BASE_URL=http://localhost:8787
export ANTHROPIC_API_KEY=sk-ant-...
claude
```

Calls should appear in the dashboard as Claude Code talks to Anthropic.

## CLI Options

```sh
ccr --help
```

```text
Usage:
  claude-code-router [options] [-- claude args...]
  ccr [options] [-- claude args...]

Options:
  -p, --port <port>        Preferred router port. Uses the next free port if busy. Default: 8787
      --host <host>        Bind host. Default: 127.0.0.1
  -c, --config <path>      Route config path. Defaults to ./config/routes.json when present
      --log-path <path>    JSONL log path. Default: ./.router-logs/calls.jsonl
      --claude-bin <name>  Claude executable. Default: claude
      --no-open            Do not open the dashboard in a browser
  -h, --help               Show this help
```

Examples:

```sh
ccr
ccr --port 9000 -- --model claude-sonnet-5
ccr --config config/routes.json --no-open
```

## Use A Local Routes File

For day-to-day use, keep secrets out of the shell and put them in the ignored local config:

```sh
cp config/routes.example.json config/routes.json
```

Edit `config/routes.json`:

```json
{
  "default": {
    "baseUrl": "https://api.anthropic.com",
    "apiKey": "sk-ant-..."
  },
  "routes": []
}
```

Start the router with that config:

```sh
ROUTER_CONFIG=config/routes.json npm start
```

Then Claude Code only needs the base URL:

```sh
export ANTHROPIC_BASE_URL=http://localhost:8787
claude
```

`config/routes.json` is ignored by git because it may contain API keys.

## Generate Routes From `api.key`

If you keep your Anthropic API key in a local `api.key` file, you can query Anthropic's model list and generate a local `config/routes.json`.

```sh
node --input-type=module -e "import { readFile, writeFile } from 'node:fs/promises'; const key=(await readFile('api.key','utf8')).trim(); const models=[]; let after=null; for(;;){ const url=new URL('https://api.anthropic.com/v1/models'); url.searchParams.set('limit','100'); if(after) url.searchParams.set('after_id', after); const res=await fetch(url,{headers:{'x-api-key':key,'anthropic-version':'2023-06-01'}}); if(!res.ok){ console.error('Anthropic models request failed:', res.status, await res.text()); process.exit(1); } const json=await res.json(); models.push(...(json.data ?? [])); if(!json.has_more || !json.last_id) break; after=json.last_id; } const exactRoutes=models.map((model)=>({name:'anthropic:'+model.id,description:model.display_name,match:{model:model.id},target:{baseUrl:'https://api.anthropic.com'}})); const families=['opus','sonnet','haiku','fable'].map((family)=>({name:'anthropic:'+family+'-family',description:'Fallback route for Anthropic '+family+' models not yet listed in this config.',match:{modelIncludes:family},target:{baseUrl:'https://api.anthropic.com'}})); const config={generatedAt:new Date().toISOString(),source:'GET https://api.anthropic.com/v1/models',default:{baseUrl:'https://api.anthropic.com',apiKey:key},routes:[...exactRoutes,...families]}; await writeFile('config/routes.json', JSON.stringify(config,null,2)+'\n'); console.log('Wrote config/routes.json with '+models.length+' Anthropic models');"
```

Both `api.key` and `config/routes.json` are ignored by git.

## Routing

Route entries match the request JSON `model` field.

```json
{
  "name": "gateway-sonnet",
  "match": { "model": "claude-sonnet-5" },
  "target": {
    "baseUrl": "https://your-anthropic-compatible-gateway.example.com",
    "apiKeyEnv": "GATEWAY_API_KEY",
    "model": "gateway/sonnet"
  }
}
```

Supported matchers:

- `model`: exact model match.
- `modelIncludes`: substring match.
- `models`: array of exact model names.

Target fields:

- `baseUrl`: upstream Anthropic-compatible API base URL.
- `apiKeyEnv`: environment variable containing the upstream key.
- `apiKey`: inline upstream key for local ignored configs.
- `model`: optional model rewrite before forwarding upstream.

Routes inherit `default.apiKey`, `default.apiKeyEnv`, and `default.baseUrl` unless a route target overrides them.

## Dashboard And Logs

The dashboard shows:

- Method, path, model, routed model, route, target URL, status, and duration.
- Redacted request headers.
- Captured request body.
- Redacted response headers.
- Captured response body preview.
- Live updates over server-sent events.

Logs are persisted as JSONL:

```text
.router-logs/calls.jsonl
```

Useful local endpoints:

```sh
curl http://localhost:8787/api/config
curl 'http://localhost:8787/api/logs?limit=5'
curl -H 'anthropic-version: 2023-06-01' 'http://localhost:8787/v1/models?limit=1'
```

## Environment Variables

- `PORT`: local server port, default `8787`.
- `ROUTER_CONFIG`: path to route config JSON.
- `ROUTER_LOG_PATH`: JSONL log path, default `.router-logs/calls.jsonl`.
- `ANTHROPIC_API_KEY`: default upstream key when `apiKeyEnv` is used.

## Test

```sh
npm test
```

## Security Notes

Authorization, API key, and cookie headers are redacted in stored logs. Request and response bodies are captured because this tool is meant for local inspection. Run it only on a trusted machine, and avoid collecting sensitive traffic unless you intend to inspect it.
