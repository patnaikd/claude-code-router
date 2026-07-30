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
  els.detailBody.textContent = JSON.stringify(detailPayload(call), null, 2);
}

function detailPayload(call) {
  if (state.tab === 'request') {
    return call.request;
  }

  if (state.tab === 'response') {
    return call.response ?? { error: call.error };
  }

  return {
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
  };
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
