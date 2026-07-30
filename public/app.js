const state = {
  calls: [],
  selectedId: null,
  paused: false,
  tab: 'summary'
};

const els = {
  totalCalls: document.querySelector('#totalCalls'),
  errorRate: document.querySelector('#errorRate'),
  avgLatency: document.querySelector('#avgLatency'),
  routes: document.querySelector('#routes'),
  search: document.querySelector('#search'),
  statusFilter: document.querySelector('#statusFilter'),
  pauseButton: document.querySelector('#pauseButton'),
  callList: document.querySelector('#callList'),
  emptyState: document.querySelector('#emptyState'),
  detailPanel: document.querySelector('#detailPanel'),
  detailTitle: document.querySelector('#detailTitle'),
  detailSubtitle: document.querySelector('#detailSubtitle'),
  detailStatus: document.querySelector('#detailStatus'),
  detailBody: document.querySelector('#detailBody'),
  tabs: document.querySelectorAll('.tab')
};

await boot();

async function boot() {
  const [logsResponse, configResponse] = await Promise.all([
    fetch('/api/logs?limit=250'),
    fetch('/api/config')
  ]);
  const logs = await logsResponse.json();
  const config = await configResponse.json();

  state.calls = logs.entries ?? [];
  state.selectedId = state.calls[0]?.id ?? null;
  renderRoutes(config);
  render();
  subscribe();
}

function subscribe() {
  const events = new EventSource('/api/logs/stream');
  events.addEventListener('log', (event) => {
    if (state.paused) {
      return;
    }

    const entry = JSON.parse(event.data);
    state.calls = [entry, ...state.calls].slice(0, 500);
    state.selectedId ??= entry.id;
    render();
  });
}

els.search.addEventListener('input', render);
els.statusFilter.addEventListener('change', render);
els.pauseButton.addEventListener('click', () => {
  state.paused = !state.paused;
  els.pauseButton.textContent = state.paused ? 'Resume' : 'Pause';
});

els.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    els.tabs.forEach((item) => item.classList.toggle('active', item === tab));
    renderDetail();
  });
});

function renderRoutes(config) {
  const routes = config.routes?.length
    ? config.routes
    : [{ name: 'default', targetBaseUrl: config.defaultBaseUrl, match: { all: true } }];

  els.routes.innerHTML = routes.map((route) => `
    <div class="route">
      <strong>${escapeHtml(route.name ?? 'default')}</strong>
      <div class="muted">${escapeHtml(route.targetBaseUrl ?? config.defaultBaseUrl)}</div>
    </div>
  `).join('');
}

function render() {
  renderMetrics();
  renderList();
  renderDetail();
}

function renderMetrics() {
  const total = state.calls.length;
  const errors = state.calls.filter((call) => call.status >= 400).length;
  const avg = total
    ? Math.round(state.calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0) / total)
    : 0;

  els.totalCalls.textContent = String(total);
  els.errorRate.textContent = total ? `${Math.round((errors / total) * 100)}%` : '0%';
  els.avgLatency.textContent = `${avg}ms`;
}

function renderList() {
  const calls = filteredCalls();
  els.callList.innerHTML = calls.map((call) => `
    <button class="call-row ${call.id === state.selectedId ? 'active' : ''}" data-id="${call.id}" type="button">
      <div class="call-main">
        <div class="call-title">
          <span class="pill">${escapeHtml(call.method)}</span>
          <span>${escapeHtml(call.model ?? call.path)}</span>
        </div>
        <div class="call-meta">${escapeHtml(call.route)} · ${escapeHtml(call.path)} · ${new Date(call.timestamp).toLocaleTimeString()}</div>
      </div>
      <span class="status ${statusClass(call.status)}">${call.status}</span>
    </button>
  `).join('');

  els.callList.querySelectorAll('.call-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedId = row.dataset.id;
      render();
    });
  });
}

function renderDetail() {
  const call = state.calls.find((item) => item.id === state.selectedId);
  els.emptyState.classList.toggle('hidden', Boolean(call));
  els.detailPanel.classList.toggle('hidden', !call);

  if (!call) {
    return;
  }

  els.detailTitle.textContent = call.model ?? call.path;
  els.detailSubtitle.textContent = `${call.method} ${call.path} · ${call.durationMs}ms · ${call.route}`;
  els.detailStatus.textContent = call.status;
  els.detailStatus.className = `status ${statusClass(call.status)}`;
  els.detailBody.textContent = detailText(call);
}

function detailText(call) {
  if (state.tab === 'request') {
    return formatHttpPayload('Request', call.request);
  }

  if (state.tab === 'response') {
    return formatHttpPayload('Response', call.response, { error: call.error });
  }

  return JSON.stringify({
    id: call.id,
    timestamp: call.timestamp,
    method: call.method,
    path: call.path,
    targetUrl: call.targetUrl,
    route: call.route,
    model: call.model,
    routedModel: call.routedModel,
    status: call.status,
    durationMs: call.durationMs,
    error: call.error ?? null,
    requestBytes: call.request?.body?.bytes ?? 0,
    responseBytes: call.response?.body?.bytes ?? 0
  }, null, 2);
}

function formatHttpPayload(label, payload, extra = {}) {
  if (!payload) {
    return JSON.stringify(extra, null, 2);
  }

  const body = payload.body ?? {};
  const contentType = headerValue(payload.headers, 'content-type');
  const parts = [
    `${label}`,
    '',
    `Headers`,
    JSON.stringify(payload.headers ?? {}, null, 2),
    '',
    `Body (${formatBytes(body.bytes ?? 0)}${body.truncated ? ', truncated' : ''})`
  ];

  if (extra.error) {
    parts.splice(2, 0, `Error: ${extra.error}`, '');
  }

  parts.push(formatBody(body.text ?? '', contentType, body.truncated));
  return parts.join('\n');
}

function formatBody(text, contentType = '', truncated = false) {
  if (!text) {
    return '(empty)';
  }

  if (contentType.includes('text/event-stream') || text.startsWith('event:')) {
    return formatSse(text);
  }

  const parsed = parseJson(text);
  if (parsed.ok) {
    return formatJsonPayload(parsed.value);
  }

  if (truncated) {
    const recovered = recoverPartialJson(text);
    if (recovered) {
      return `${formatJsonPayload(recovered)}\n\n[body was truncated before the full JSON could be captured]`;
    }

    return formatTruncatedJsonText(text);
  }

  return text;
}

function formatJsonPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }

  if (Array.isArray(value.messages) || Array.isArray(value.tools)) {
    return [
      formatAnthropicRequestSummary(value),
      '',
      'Full JSON',
      JSON.stringify(value, null, 2)
    ].join('\n');
  }

  if (Array.isArray(value.content) || value.usage) {
    return [
      formatAnthropicResponseSummary(value),
      '',
      'Full JSON',
      JSON.stringify(value, null, 2)
    ].join('\n');
  }

  return JSON.stringify(value, null, 2);
}

function formatAnthropicRequestSummary(body) {
  const lines = [
    'Claude Request Summary',
    `model: ${body.model ?? '(missing)'}`,
    `stream: ${body.stream === true ? 'true' : body.stream === false ? 'false' : '(default false)'}`,
    `max_tokens: ${body.max_tokens ?? '(missing)'}`,
    `messages: ${Array.isArray(body.messages) ? body.messages.length : 0}`,
    `tools: ${Array.isArray(body.tools) ? body.tools.length : 0}`
  ];

  if (body.thinking) {
    lines.push(`thinking: ${JSON.stringify(body.thinking)}`);
  }

  if (Array.isArray(body.system)) {
    lines.push(`system blocks: ${body.system.length}`);
  } else if (typeof body.system === 'string') {
    lines.push(`system: ${preview(body.system)}`);
  }

  if (Array.isArray(body.messages)) {
    lines.push('', 'Messages');
    body.messages.slice(0, 12).forEach((message, index) => {
      lines.push(`${index + 1}. ${message.role}: ${previewContent(message.content)}`);
    });

    if (body.messages.length > 12) {
      lines.push(`... ${body.messages.length - 12} more messages`);
    }
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    lines.push('', 'Tools');
    body.tools.slice(0, 20).forEach((tool, index) => {
      lines.push(`${index + 1}. ${tool.name ?? '(unnamed)'} — ${preview(tool.description ?? '')}`);
    });

    if (body.tools.length > 20) {
      lines.push(`... ${body.tools.length - 20} more tools`);
    }
  }

  return lines.join('\n');
}

function formatAnthropicResponseSummary(body) {
  const lines = [
    'Claude Response Summary',
    `id: ${body.id ?? '(missing)'}`,
    `model: ${body.model ?? '(missing)'}`,
    `role: ${body.role ?? '(missing)'}`,
    `stop_reason: ${body.stop_reason ?? '(pending)'}`,
    `content blocks: ${Array.isArray(body.content) ? body.content.length : 0}`
  ];

  if (body.usage) {
    lines.push(`usage: ${JSON.stringify(body.usage)}`);
  }

  if (Array.isArray(body.content)) {
    lines.push('', 'Content');
    body.content.forEach((block, index) => {
      lines.push(`${index + 1}. ${block.type}: ${previewContent(block)}`);
    });
  }

  return lines.join('\n');
}

function formatSse(text) {
  const events = parseSse(text);
  const lines = [
    `SSE Stream`,
    `events: ${events.length}`,
    ''
  ];

  events.slice(0, 80).forEach((event, index) => {
    lines.push(`${index + 1}. ${event.event ?? 'message'}`);

    const parsed = parseJson(event.data);
    if (parsed.ok) {
      lines.push(indent(formatSseData(parsed.value), 2));
    } else if (event.data) {
      lines.push(indent(preview(event.data, 500), 2));
    }
  });

  if (events.length > 80) {
    lines.push(`... ${events.length - 80} more events`);
  }

  lines.push('', 'Raw SSE', text);
  return lines.join('\n');
}

function formatSseData(data) {
  if (!data || typeof data !== 'object') {
    return JSON.stringify(data);
  }

  if (data.type === 'content_block_delta') {
    const delta = data.delta ?? {};
    if (delta.text) {
      return `${data.type}[${data.index}] ${delta.type}: ${JSON.stringify(delta.text)}`;
    }
    if (delta.partial_json) {
      return `${data.type}[${data.index}] ${delta.type}: ${JSON.stringify(delta.partial_json)}`;
    }
    if (delta.thinking !== undefined) {
      return `${data.type}[${data.index}] ${delta.type}: ${delta.estimated_tokens ?? 0} estimated thinking tokens`;
    }
    if (delta.signature) {
      return `${data.type}[${data.index}] signature_delta: ${delta.signature.length} chars`;
    }
  }

  if (data.type === 'content_block_start') {
    return `${data.type}[${data.index}] ${data.content_block?.type ?? ''}`;
  }

  if (data.type === 'message_start') {
    return `${data.type}: ${data.message?.model ?? ''} ${data.message?.id ?? ''}`;
  }

  if (data.type === 'message_delta') {
    return `${data.type}: stop_reason=${data.delta?.stop_reason ?? '(pending)'} usage=${JSON.stringify(data.usage ?? {})}`;
  }

  return JSON.stringify(data, null, 2);
}

function parseSse(text) {
  return text.split(/\n\n+/)
    .map((block) => {
      const event = {};
      const data = [];

      block.split('\n').forEach((line) => {
        if (line.startsWith('event:')) {
          event.event = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice('data:'.length).trimStart());
        }
      });

      event.data = data.join('\n');
      return event;
    })
    .filter((event) => event.event || event.data);
}

function previewContent(content) {
  if (typeof content === 'string') {
    return preview(content);
  }

  if (Array.isArray(content)) {
    return content.map((block) => previewContent(block)).join(' | ');
  }

  if (!content || typeof content !== 'object') {
    return String(content ?? '');
  }

  if (content.type === 'text') {
    return preview(content.text ?? '');
  }

  if (content.type === 'tool_use') {
    return `${content.name ?? 'tool'} input=${preview(JSON.stringify(content.input ?? {}), 240)}`;
  }

  if (content.type === 'tool_result') {
    return `tool_result ${content.tool_use_id ?? ''}: ${previewContent(content.content)}`;
  }

  if (content.type === 'thinking') {
    return `thinking ${preview(content.thinking ?? '')}`;
  }

  return preview(JSON.stringify(content), 240);
}

function recoverPartialJson(text) {
  const lastObjectEnd = text.lastIndexOf('}');
  const lastArrayEnd = text.lastIndexOf(']');
  const end = Math.max(lastObjectEnd, lastArrayEnd);

  if (end < 0) {
    return null;
  }

  const parsed = parseJson(text.slice(0, end + 1));
  return parsed.ok ? parsed.value : null;
}

function formatTruncatedJsonText(text) {
  const lines = [
    'Partial JSON Summary',
    'body was truncated before the full JSON could be parsed'
  ];
  const model = matchStringField(text, 'model');
  const stream = matchLiteralField(text, 'stream');
  const maxTokens = matchLiteralField(text, 'max_tokens');
  const roles = [...text.matchAll(/"role"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
  const toolNames = [...text.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);

  if (model) {
    lines.push(`model: ${model}`);
  }

  if (stream) {
    lines.push(`stream: ${stream}`);
  }

  if (maxTokens) {
    lines.push(`max_tokens: ${maxTokens}`);
  }

  if (roles.length) {
    lines.push(`message role markers captured: ${roles.length} (${countValues(roles)})`);
  }

  if (toolNames.length) {
    const uniqueTools = [...new Set(toolNames)].slice(0, 30);
    lines.push(`tool names captured: ${uniqueTools.length}`);
    uniqueTools.forEach((name, index) => {
      lines.push(`${index + 1}. ${name}`);
    });
  }

  lines.push('', 'Captured Preview', preview(text, 4000));
  return lines.join('\n');
}

function matchStringField(text, field) {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`));
  return match?.[1];
}

function matchLiteralField(text, field) {
  const match = text.match(new RegExp(`"${field}"\\s*:\\s*([^,}\\]]+)`));
  return match?.[1]?.trim();
}

function countValues(values) {
  const counts = values.reduce((map, value) => {
    map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  }, new Map());

  return [...counts.entries()].map(([value, count]) => `${value}: ${count}`).join(', ');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function headerValue(headers = {}, name) {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ?? '';
}

function preview(value, limit = 360) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit)}...`;
}

function indent(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return String(text).split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function filteredCalls() {
  const query = els.search.value.trim().toLowerCase();
  const status = els.statusFilter.value;

  return state.calls.filter((call) => {
    const haystack = [
      call.model,
      call.routedModel,
      call.route,
      call.path,
      call.status,
      call.targetUrl
    ].join(' ').toLowerCase();

    return (!query || haystack.includes(query))
      && (!status || String(call.status).startsWith(status));
  });
}

function statusClass(status) {
  if (status >= 500) {
    return 'error';
  }

  if (status >= 400) {
    return 'warn';
  }

  return 'ok';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
