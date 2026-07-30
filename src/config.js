import { readFile } from 'node:fs/promises';

const DEFAULT_CONFIG = {
  default: {
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY'
  },
  routes: []
};

export async function loadRouterConfig(configPath = process.env.ROUTER_CONFIG) {
  if (!configPath) {
    return DEFAULT_CONFIG;
  }

  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    default: {
      ...DEFAULT_CONFIG.default,
      ...(parsed.default ?? {})
    },
    routes: Array.isArray(parsed.routes) ? parsed.routes : []
  };
}

export function selectRoute(config, requestBody) {
  const model = typeof requestBody?.model === 'string' ? requestBody.model : '';
  const route = config.routes.find((candidate) => routeMatches(candidate.match, model));
  const target = route?.target ?? config.default;

  return {
    name: route?.name ?? 'default',
    baseUrl: target.baseUrl ?? config.default.baseUrl,
    apiKeyEnv: target.apiKeyEnv ?? config.default.apiKeyEnv,
    apiKey: target.apiKey ?? config.default.apiKey,
    model: target.model ?? undefined
  };
}

function routeMatches(match = {}, model) {
  if (match.model && match.model !== model) {
    return false;
  }

  if (match.modelIncludes && !model.includes(match.modelIncludes)) {
    return false;
  }

  if (Array.isArray(match.models) && !match.models.includes(model)) {
    return false;
  }

  return Boolean(match.model || match.modelIncludes || match.models);
}

export function rewriteBodyForRoute(body, route) {
  if (!route.model || !body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  return {
    ...body,
    model: route.model
  };
}
