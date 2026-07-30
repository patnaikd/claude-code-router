import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { handleProxyRequest } from './proxy.js';

test('handleProxyRequest forwards rewritten body and records response capture', async () => {
  const entries = [];
  const req = Readable.from([
    JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] })
  ]);
  req.method = 'POST';
  req.url = '/v1/messages';
  req.headers = {
    'content-type': 'application/json',
    authorization: 'Bearer local-secret'
  };

  const res = new Writable({
    write(chunk, encoding, callback) {
      responseChunks.push(Buffer.from(chunk));
      callback();
    }
  });
  const responseChunks = [];
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };

  await handleProxyRequest(req, res, {
    config: {
      default: { baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      routes: [
        {
          name: 'sonnet-gateway',
          match: { model: 'claude-sonnet' },
          target: {
            baseUrl: 'https://gateway.example.com/anthropic',
            apiKey: 'upstream-secret',
            model: 'gateway/sonnet'
          }
        }
      ]
    },
    logStore: { append: (entry) => entries.push(entry) },
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://gateway.example.com/anthropic/v1/messages');
      assert.equal(JSON.parse(init.body).model, 'gateway/sonnet');
      assert.equal(init.headers.get('x-api-key'), 'upstream-secret');

      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(Buffer.concat(responseChunks).toString('utf8'), '{"ok":true}');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, 'sonnet-gateway');
  assert.equal(entries[0].request.headers.authorization, '[redacted]');
  assert.equal(entries[0].response.body.text, '{"ok":true}');
});
