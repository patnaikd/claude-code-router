import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTargetUrl, redactHeaders } from './proxy.js';
import { rewriteBodyForRoute, selectRoute } from './config.js';

test('selectRoute picks the first matching model route', () => {
  const config = {
    default: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    routes: [
      {
        name: 'haiku',
        match: { modelIncludes: 'haiku' },
        target: { baseUrl: 'https://gateway.example.com', apiKeyEnv: 'GATEWAY_API_KEY' }
      }
    ]
  };

  assert.deepEqual(selectRoute(config, { model: 'claude-3-5-haiku-20241022' }), {
    name: 'haiku',
    baseUrl: 'https://gateway.example.com',
    apiKeyEnv: 'GATEWAY_API_KEY',
    apiKey: undefined,
    model: undefined
  });
});

test('selectRoute falls back to default route', () => {
  const config = {
    default: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    routes: []
  };

  assert.equal(selectRoute(config, { model: 'claude-sonnet' }).name, 'default');
});

test('selectRoute inherits default inline apiKey for matched routes', () => {
  const config = {
    default: { baseUrl: 'https://api.anthropic.com', apiKey: 'secret' },
    routes: [
      {
        name: 'sonnet',
        match: { modelIncludes: 'sonnet' },
        target: { baseUrl: 'https://api.anthropic.com' }
      }
    ]
  };

  assert.equal(selectRoute(config, { model: 'claude-sonnet-5' }).apiKey, 'secret');
});

test('rewriteBodyForRoute replaces model only when configured', () => {
  const body = { model: 'claude-sonnet', messages: [] };

  assert.deepEqual(rewriteBodyForRoute(body, { model: 'gateway/sonnet' }), {
    model: 'gateway/sonnet',
    messages: []
  });
  assert.equal(rewriteBodyForRoute(body, {}), body);
});

test('buildTargetUrl preserves request path and query on target host', () => {
  assert.equal(
    buildTargetUrl('https://api.anthropic.com', '/v1/messages?beta=true'),
    'https://api.anthropic.com/v1/messages?beta=true'
  );
});

test('buildTargetUrl preserves base path prefixes for gateways', () => {
  assert.equal(
    buildTargetUrl('https://gateway.example.com/anthropic', '/v1/messages?beta=true'),
    'https://gateway.example.com/anthropic/v1/messages?beta=true'
  );
});

test('redactHeaders hides credentials and removes hop by hop headers', () => {
  assert.deepEqual(redactHeaders({
    authorization: 'Bearer secret',
    'x-api-key': 'secret',
    connection: 'keep-alive',
    'anthropic-version': '2023-06-01'
  }), {
    authorization: '[redacted]',
    'x-api-key': '[redacted]',
    'anthropic-version': '2023-06-01'
  });
});
