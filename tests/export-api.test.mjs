import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../scripts/server.mjs';
import { validateOptions } from '../scripts/export-api.mjs';

const validOptions = { mode: 'original-english', aspect: '16:9', quality: '720', clips: [{ start: 0, end: 2 }], cues: [], sourceName: 'test.mp4' };
const fakeWorker = `
import fs from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ready:true,problems:[],capabilities:{original:true,'original-english':true,english:false}}));
} else {
  const job = JSON.parse(await fs.readFile(process.argv[process.argv.indexOf('--job')+1], 'utf8'));
  const source = await fs.readFile(job.source);
  console.log(JSON.stringify({progress:30,message:'Mock audio processing'}));
  if (source.toString().startsWith('SLOW')) await new Promise(resolve => setTimeout(resolve, 60000));
  if (source.toString().startsWith('FAIL')) { console.log(JSON.stringify({error:'The source contains no audible dialogue.'})); process.exit(1); }
  await fs.writeFile(path.join(job.outputDir,'result.mp4'), Buffer.alloc(128, 65));
  await fs.writeFile(path.join(job.outputDir,'english.srt'), '1\\n00:00:00,000 --> 00:00:02,000\\nHello world.\\n');
  console.log(JSON.stringify({done:true,duration:2,language:'zh',subtitleCount:1,audioRmsDb:-18,files:{video:'result.mp4',subtitles:'english.srt'}}));
}
`;

async function fixture(t, extra = {}) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cinecut-api-'));
  const workerFile = path.join(runtimeRoot, 'fake-worker.mjs');
  await fs.writeFile(workerFile, fakeWorker);
  const server = createServer({ exportApi: { runtimeRoot, workerFile, python: process.execPath, maxUploadBytes: 1024, ...extra } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.closeExports(); await new Promise(resolve => server.close(resolve)); await fs.rm(runtimeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const port = server.address().port;
  const request = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); let data; try { data = JSON.parse(raw.toString()); } catch {} resolve({ status: res.statusCode, headers: res.headers, raw, data }); });
    });
    req.on('error', reject); req.end(body);
  });
  const capability = await request('/api/capabilities');
  assert.equal(capability.status, 200); assert.equal(capability.data.subtitleReady, true); assert.equal(capability.data.englishReady, false); assert.equal(capability.data.originalReady, true);
  const headers = { 'X-CineCut-Token': capability.data.token };
  const create = (settings = validOptions) => request('/api/jobs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
  const poll = async (id, predicate = job => ['completed', 'failed', 'cancelled'].includes(job.state)) => {
    for (let n = 0; n < 100; n++) {
      const response = await request(`/api/jobs/${id}`);
      if (predicate(response.data)) return response.data;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Job did not reach its expected state.');
  };
  return { request, create, poll, headers, runtimeRoot, port };
}

test('job validation rejects path injection fields, invalid ranges, excessive duration and unsupported settings', () => {
  const clean = validateOptions({ ...validOptions, source: 'C:/secret', outputDir: 'C:/secret', clips: [{ start: 1, end: 5, path: 'bad' }] });
  assert.equal(clean.source, undefined); assert.equal(clean.outputDir, undefined); assert.deepEqual(clean.clips, [{ start: 1, end: 5 }]);
  for (const update of [{ clips: [{ start: 5, end: 1 }] }, { clips: [{ start: 0, end: Infinity }] }, { clips: [{ start: 0, end: 601 }] }, { clips: [] }, { mode: 'shell' }, { aspect: '../' }, { quality: '999' }, { cues: [{ start: 0, end: 1, text: null }] }]) assert.throws(() => validateOptions({ ...validOptions, ...update }));
});

test('local API rejects cross-origin requests, hostile hosts and missing CSRF tokens', async t => {
  const { request, headers, port } = await fixture(t);
  assert.equal((await request('/api/capabilities', { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request('/api/capabilities', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/capabilities', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const body = JSON.stringify(validOptions);
  assert.equal((await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await request('/api/jobs', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body })).status, 403);
  assert.equal((await request('/api/jobs/../../README.md', { headers })).status, 404);
});

test('streamed upload completes with downloadable video, English subtitles, ranges and source cleanup', async t => {
  const { request, create, poll, headers, runtimeRoot } = await fixture(t);
  const created = await create(); assert.equal(created.status, 201);
  assert.equal((await create()).status, 409);
  const { id, uploadUrl } = created.data;
  assert.equal((await request(uploadUrl, { method: 'PUT', headers, body: Buffer.from('VIDEO INPUT') })).status, 202);
  const result = await poll(id); assert.equal(result.state, 'completed'); assert.equal(result.progress, 100);
  assert.equal(result.result.audioRmsDb, -18);
  const video = await request(result.result.videoUrl, { headers: { Range: 'bytes=10-19' } });
  assert.equal(video.status, 206); assert.equal(video.raw.length, 10); assert.equal(video.headers['content-range'], 'bytes 10-19/128');
  assert.equal((await request(result.result.videoUrl, { headers: { Range: 'bytes=1000-' } })).status, 416);
  const suffix = await request(result.result.videoUrl, { headers: { Range: 'bytes=-7' } }); assert.equal(suffix.raw.length, 7);
  assert.match((await request(result.result.subtitlesUrl)).raw.toString(), /Hello world/);
  assert.equal((await request(`/api/jobs/${id}/files/job.json`)).status, 404);
  assert.equal((await request(uploadUrl, { method: 'PUT', headers, body: 'replacement' })).status, 409);
  await assert.rejects(fs.stat(path.join(runtimeRoot, 'jobs', id, 'source.media')), { code: 'ENOENT' });
});

test('oversized and empty uploads fail explicitly and release the active job', async t => {
  const { request, create, headers, poll } = await fixture(t);
  const { id, uploadUrl } = (await create()).data;
  const rejected = await request(uploadUrl, { method: 'PUT', headers, body: Buffer.alloc(1025) });
  assert.equal(rejected.status, 413); assert.equal((await poll(id)).state, 'failed');
  const next = await create(); assert.equal(next.status, 201);
  assert.equal((await request(next.data.uploadUrl, { method: 'PUT', headers, body: '' })).status, 400);
});

test('worker errors are exposed and cancellation terminates running work', async t => {
  const { request, create, headers, poll, runtimeRoot } = await fixture(t);
  const failure = (await create()).data;
  await request(failure.uploadUrl, { method: 'PUT', headers, body: 'FAIL' });
  const failed = await poll(failure.id); assert.equal(failed.state, 'failed'); assert.match(failed.message, /no audible dialogue/);
  const slow = (await create()).data;
  await request(slow.uploadUrl, { method: 'PUT', headers, body: 'SLOW' });
  await poll(slow.id, job => job.progress === 30);
  const cancelled = await request(`/api/jobs/${slow.id}`, { method: 'DELETE', headers });
  assert.equal(cancelled.status, 200); assert.equal(cancelled.data.state, 'cancelled');
  await assert.rejects(fs.stat(path.join(runtimeRoot, 'jobs', slow.id, 'source.media')), { code: 'ENOENT' });
  assert.equal((await create()).status, 201);
});

test('concurrent creation reserves one worker and interrupted uploads are cleaned up', async t => {
  const { request, create, headers, poll, port, runtimeRoot } = await fixture(t);
  const attempts = await Promise.all([create(), create()]);
  assert.deepEqual(attempts.map(a => a.status).sort(), [201, 409]);
  const { id, uploadUrl } = attempts.find(a => a.status === 201).data;
  const interrupted = http.request({ hostname: '127.0.0.1', port, path: uploadUrl, method: 'PUT', headers: { ...headers, 'Content-Length': '1000' } });
  interrupted.on('error', () => {}); interrupted.write('PARTIAL');
  await poll(id, job => job.state === 'uploading');
  interrupted.destroy();
  assert.equal((await poll(id)).state, 'failed');
  for (let i = 0; i < 20; i++) {
    const exists = await fs.stat(path.join(runtimeRoot, 'jobs', id, 'source.upload')).then(() => true).catch(() => false);
    if (!exists) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await assert.rejects(fs.stat(path.join(runtimeRoot, 'jobs', id, 'source.upload')), { code: 'ENOENT' });
  assert.equal((await request(`/api/jobs/${id}/files/result.mp4`)).status, 409);
  assert.equal((await create()).status, 201);
});
