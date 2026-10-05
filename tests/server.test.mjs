import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, parseRange } from '../scripts/server.mjs';

test('video byte ranges support normal, open and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 });
  assert.deepEqual(parseRange('bytes=5-', 10), { start: 5, end: 9 });
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.equal(parseRange('bytes=10-', 10), false);
  assert.equal(parseRange('bytes=-0', 10), false);
  assert.equal(parseRange('bytes=8-2', 10), false);
  assert.equal(parseRange('bytes=0-1,4-5', 10), false);
});

test('local server serves the app and video while restricting paths and methods', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (url, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, ...options }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
  try {
    const page = await request('/'); assert.equal(page.status, 200); assert.match(page.body.toString(), /CineCut/);
    const video = await request('/assets/big-buck-bunny-30s.mp4', { headers: { Range: 'bytes=0-31' } });
    assert.equal(video.status, 206); assert.equal(video.body.length, 32); assert.match(video.headers['content-range'], /^bytes 0-31\//);
    const head = await request('/assets/big-buck-bunny-30s.mp4', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal((await request('/assets/big-buck-bunny-30s.mp4', { headers: { Range: 'bytes=9999999999-' } })).status, 416);
    assert.equal((await request('/%2e%2e/README.md')).status, 403);
    assert.equal((await request('/.openai/hosting.json')).status, 403);
    assert.equal((await request('/%00')).status, 400);
    assert.equal((await request('/missing.js')).status, 404);
    assert.equal((await request('/', { method: 'POST' })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
