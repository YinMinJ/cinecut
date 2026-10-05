import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const defaultProject = fileURLToPath(new URL('..', import.meta.url));
const activeStates = new Set(['queued', 'uploading', 'running']);
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MAX_BODY = 512 * 1024;

function fault(status, message) { return Object.assign(new Error(message), { status }); }
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}

export function validateOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault(400, 'Invalid job options.');
  if (!['english', 'original'].includes(input.mode)) throw fault(400, 'Choose English or original audio.');
  if (!['16:9', '9:16', '1:1'].includes(input.aspect)) throw fault(400, 'Unsupported aspect ratio.');
  if (!['720', '1080', '720p', '1080p'].includes(String(input.quality))) throw fault(400, 'Unsupported output quality.');
  if (!Array.isArray(input.clips) || input.clips.length < 1 || input.clips.length > 100) throw fault(400, 'Select between 1 and 100 clips.');
  let duration = 0;
  const clips = input.clips.map(clip => {
    if (!clip || typeof clip.start !== 'number' || typeof clip.end !== 'number' || !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.start < 0 || clip.end <= clip.start || clip.end > 604800) throw fault(400, 'Invalid clip time.');
    duration += clip.end - clip.start;
    return { start: clip.start, end: clip.end };
  });
  if (duration > 600.001) throw fault(400, 'An export must be 10 minutes or shorter.');
  if (input.cues !== undefined && (!Array.isArray(input.cues) || input.cues.length > 20000)) throw fault(400, 'Too many subtitle cues.');
  const cues = (input.cues || []).map(cue => {
    if (!cue || typeof cue.start !== 'number' || typeof cue.end !== 'number' || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || typeof cue.text !== 'string' || cue.text.length > 4000) throw fault(400, 'Invalid subtitle cue.');
    return { start: cue.start, end: cue.end, text: cue.text };
  });
  return { mode: input.mode, aspect: input.aspect, quality: String(input.quality).replace('p', ''), clips, cues, demo: input.demo === true, sourceName: typeof input.sourceName === 'string' ? path.basename(input.sourceName).slice(0, 200) : 'video' };
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fault(415, 'Use application/json.');
  if (Number(req.headers['content-length']) > MAX_BODY) throw fault(413, 'Job options are too large.');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw fault(413, 'Job options are too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault(400, 'Invalid JSON.'); }
}

function validLocalRequest(req) {
  const remote = req.socket.remoteAddress;
  if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const hosts = new Set([`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`, `[::1]:${req.socket.localPort}`]);
  if (req.socket.localPort === 80) for (const host of ['127.0.0.1', 'localhost', '[::1]']) hosts.add(host);
  if (!hosts.has(String(req.headers.host).toLowerCase())) return false;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

function rangeOf(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2]) || !size) return false;
  const a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const b = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= a && a < size && (m[1] || Number(m[2]) > 0) ? { start: a, end: b } : false;
}

// All paths originate in this module; browser requests can never choose a local path.
export function createExportApi(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || defaultProject);
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(projectRoot, '.runtime'));
  const jobsRoot = path.join(runtimeRoot, 'jobs');
  const workerFile = options.workerFile || path.join(projectRoot, 'scripts', 'media_worker.py');
  const jobs = new Map();
  const token = randomBytes(32).toString('hex');
  const maxUploadBytes = options.maxUploadBytes || Number(process.env.CINECUT_MAX_UPLOAD_BYTES) || 20 * 1024 ** 3;
  const retained = options.maxJobs || 10;
  const retentionMs = options.retentionMs || 24 * 60 * 60 * 1000;
  const children = new Set();
  let initialized, capabilityCache, capabilityPromise, closed = false;
  const hasActiveJob = () => [...jobs.values()].some(j => activeStates.has(j.state) || j.child || j.uploadStream);

  function config() {
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'config.json'), 'utf8')); } catch {}
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
    for (const [key, field] of Object.entries({ CINECUT_FFMPEG: 'ffmpeg', CINECUT_FFPROBE: 'ffprobe', CINECUT_WHISPER_MODEL: 'whisperModel' })) {
      if (!env[key] && typeof saved[field] === 'string') env[key] = saved[field];
    }
    return { python: options.python || process.env.CINECUT_PYTHON || saved.python || 'python', env };
  }

  async function removeSource(job) {
    for (const name of ['source.upload', 'source.media']) await fs.promises.rm(path.join(job.dir, name), { force: true }).catch(() => {});
  }
  async function removeJobDir(dir) {
    if (path.dirname(dir) !== jobsRoot || !new RegExp(`^${uuidPattern}$`).test(path.basename(dir))) return;
    const stat = await fs.promises.lstat(dir).catch(() => null);
    if (stat?.isSymbolicLink()) return;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  async function init() {
    if (!initialized) initialized = (async () => {
      await fs.promises.mkdir(jobsRoot, { recursive: true });
      // Previous processes cannot still be managed. Remove stale uploads on restart.
      const oldDirs = [];
      for (const entry of await fs.promises.readdir(jobsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !new RegExp(`^${uuidPattern}$`).test(entry.name)) continue;
        const dir = path.join(jobsRoot, entry.name);
        const stat = await fs.promises.stat(dir);
        if (Date.now() - stat.mtimeMs > retentionMs) await removeJobDir(dir);
        else { oldDirs.push({ dir, modified: stat.mtimeMs }); for (const file of ['source.upload', 'source.media']) await fs.promises.rm(path.join(dir, file), { force: true }).catch(() => {}); }
      }
      // Job links do not survive a process restart; remove orphaned job directories.
      // This also bounds disk usage across repeated restarts, not just in memory.
      for (const old of oldDirs) await removeJobDir(old.dir);
    })();
    return initialized;
  }
  async function prune() {
    const finished = [...jobs.values()].filter(j => !activeStates.has(j.state));
    for (const job of finished) {
      if (Date.now() - job.updated > retentionMs || jobs.size > retained) {
        jobs.delete(job.id); await removeJobDir(job.dir);
      }
    }
  }
  function launch(args) {
    const conf = config();
    const child = spawn(conf.python, [workerFile, ...args], { cwd: projectRoot, env: conf.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    children.add(child); child.once('close', () => children.delete(child));
    return child;
  }
  function terminate(child) {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      child.once('close', resolve);
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); });
        killer.once('close', code => { if (code !== 0) child.kill(); });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); timer.unref(); child.once('close', () => clearTimeout(timer));
    });
  }
  async function capabilities() {
    if (capabilityCache && Date.now() - capabilityCache.at < 15000) return capabilityCache.value;
    if (!capabilityPromise) capabilityPromise = new Promise(resolve => {
      const child = launch(['--check']); let output = '', errors = '', finished = false;
      const finish = value => {
        if (finished) return; finished = true; clearTimeout(timer);
        const result = { ...value, ready: value.ready === true, englishReady: value.capabilities?.english ?? value.ready === true, originalReady: value.capabilities?.original === true, token };
        capabilityCache = { at: Date.now(), value: result }; resolve(result);
      };
      const timer = setTimeout(() => { terminate(child); finish({ ready: false, problems: ['Media engine check timed out.'] }); }, options.checkTimeoutMs || 30000); timer.unref();
      child.stdout.on('data', data => { output = (output + data).slice(-65536); });
      child.stderr.on('data', data => { errors = (errors + data).slice(-2000); });
      child.on('error', error => finish({ ready: false, problems: [`Unable to start Python media engine: ${error.message}`] }));
      child.on('close', () => {
        try { const line = output.trim().split(/\r?\n/).reverse().find(line => line.trim().startsWith('{')); finish(JSON.parse(line)); }
        catch { finish({ ready: false, problems: [errors.trim() || 'Media engine is unavailable. Run the local setup first.'] }); }
      });
    }).finally(() => { capabilityPromise = null; });
    return capabilityPromise;
  }
  function setState(job, state, message, progress = job.progress) {
    job.state = state; job.message = message; job.progress = progress; job.updated = Date.now();
    if (!activeStates.has(state)) { clearTimeout(job.timer); job.timer = null; }
  }
  function snapshot(job) {
    return { id: job.id, state: job.state, status: job.state, progress: job.progress, message: job.message, ...(job.result ? { result: job.result } : {}) };
  }
  function fail(job, message) { if (job.state !== 'cancelled') setState(job, 'failed', message); void removeSource(job); }

  async function run(job) {
    if (job.state === 'cancelled' || closed) return;
    await fs.promises.writeFile(path.join(job.dir, 'job.json'), JSON.stringify({ ...job.options, id: job.id, parentPid: process.pid, source: path.join(job.dir, 'source.media'), outputDir: job.dir }), { flag: 'wx' });
    if (job.state === 'cancelled' || closed) return;
    setState(job, 'running', 'Starting local media engine.', 1);
    const child = launch(['--job', path.join(job.dir, 'job.json')]); job.child = child;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    clearTimeout(job.timer);
    job.timer = setTimeout(() => { fail(job, 'Export timed out.'); void terminate(child); }, options.jobTimeoutMs || 2 * 60 * 60 * 1000); job.timer.unref();
    let buffer = '', errors = '', finalResult, workerError;
    child.stdout.on('data', data => {
      buffer += data.toString('utf8');
      if (buffer.length > 1024 * 1024) { fail(job, 'Invalid media engine response.'); void terminate(child); return; }
      const lines = buffer.split(/\r?\n/); buffer = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.done === true) finalResult = event;
          else if (event.error) workerError = String(event.error).slice(0, 2000);
          else if (job.state === 'running') {
            if (Number.isFinite(event.progress)) job.progress = Math.max(1, Math.min(99, event.progress));
            if (typeof event.message === 'string') job.message = event.message.slice(0, 1000);
            job.updated = Date.now();
          }
        } catch {}
      }
    });
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.on('error', error => fail(job, `Unable to start media engine: ${error.message}`));
    child.on('close', async code => {
      job.child = null;
      if (job.state !== 'running') { await removeSource(job); return; }
      if (code !== 0 || !finalResult) { fail(job, workerError || errors.trim() || 'Export failed before a valid video was produced.'); return; }
      try {
        const video = await fs.promises.stat(path.join(job.dir, 'result.mp4'));
        if (!video.isFile() || video.size < 32) throw new Error('The media engine did not produce a valid video.');
        const subtitleName = ['english.srt', 'subtitles.srt'].includes(finalResult.files?.subtitles) ? finalResult.files.subtitles : 'english.srt';
        const hasSubtitles = await fs.promises.stat(path.join(job.dir, subtitleName)).then(s => s.isFile() && s.size > 0).catch(() => false);
        if (job.options.mode === 'english' && !hasSubtitles) throw new Error('English subtitles were not produced.');
        const { files, done, ...details } = finalResult;
        job.result = { ...details, videoUrl: `/api/jobs/${job.id}/files/result.mp4`, ...(hasSubtitles ? { subtitlesUrl: `/api/jobs/${job.id}/files/${subtitleName}` } : {}) };
        setState(job, 'completed', 'Export complete.', 100);
      } catch (error) { fail(job, error.message); }
      await removeSource(job);
    });
  }

  async function upload(req, job) {
    const length = req.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > maxUploadBytes)) throw fault(413, 'Video exceeds the local upload limit.');
    if (length === '0') throw fault(400, 'The video is empty.');
    setState(job, 'uploading', 'Receiving video on this computer.', 0);
    clearTimeout(job.timer);
    const temp = path.join(job.dir, 'source.upload');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(temp, { flags: 'wx' }); let count = 0, settled = false;
      job.uploadStream = file;
      const timer = setTimeout(() => stop(fault(408, 'Upload timed out.')), options.uploadTimeoutMs || 30 * 60 * 1000); timer.unref();
      function stop(error) {
        if (settled) return; settled = true; clearTimeout(timer);
        req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('aborted', onAbort); req.removeListener('error', stop);
        job.uploadStream = null;
        if (error) {
          // Wait for the Windows file handle to close before the caller removes it.
          if (file.closed) reject(error); else { file.once('close', () => reject(error)); file.destroy(); }
          req.resume();
        } else resolve();
      }
      function onData(chunk) {
        count += chunk.length;
        if (count > maxUploadBytes) return stop(fault(413, 'Video exceeds the local upload limit.'));
        if (job.state === 'cancelled') return stop(fault(409, 'Job was cancelled.'));
        if (!file.write(chunk)) req.pause();
      }
      function onEnd() { if (!count) stop(fault(400, 'The video is empty.')); else file.end(); }
      function onAbort() { stop(fault(400, 'Video upload was interrupted.')); }
      file.on('drain', () => req.resume()); file.on('error', stop); file.on('finish', () => stop());
      // Cancellation must reject the upload even if the browser stopped sending data.
      file.on('close', () => { if (!settled) stop(fault(409, 'Upload was cancelled.')); });
      req.on('data', onData); req.on('end', onEnd); req.on('aborted', onAbort); req.on('error', stop);
    });
    if (job.state === 'cancelled') throw fault(409, 'Job was cancelled.');
    await fs.promises.rename(temp, path.join(job.dir, 'source.media'));
    await run(job);
  }

  async function serveFile(req, res, job, name) {
    if (job.state !== 'completed') throw fault(409, 'The export is not ready.');
    const file = path.join(job.dir, name);
    const actual = await fs.promises.realpath(file).catch(() => null);
    if (!actual || path.dirname(actual) !== await fs.promises.realpath(job.dir)) throw fault(404, 'File not found.');
    const stat = await fs.promises.stat(actual);
    if (!stat.isFile()) throw fault(404, 'File not found.');
    const range = rangeOf(req.headers.range, stat.size);
    if (range === false) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
    const headers = { 'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'application/x-subrip; charset=utf-8', 'Content-Disposition': `attachment; filename="cinecut-${job.options.mode}${path.extname(name)}"`, 'Content-Length': range ? range.end - range.start + 1 : stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(actual, range || undefined);
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  }

  async function handle(req, res) {
    if (!(req.url || '').startsWith('/api/')) return false;
    try {
      if (closed) throw fault(503, 'Server is shutting down.');
      if (!validLocalRequest(req)) throw fault(403, 'Only requests from this local application are allowed.');
      if (!['GET', 'HEAD'].includes(req.method)) {
        const sent = Buffer.from(String(req.headers['x-cinecut-token'] || ''));
        const expected = Buffer.from(token);
        if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) throw fault(403, 'Reload CineCut before starting an export.');
      }
      const route = req.url.split('?')[0];
      if (route === '/api/capabilities' && req.method === 'GET') { json(res, 200, await capabilities()); return true; }
      await init();
      if (route === '/api/jobs' && req.method === 'POST') {
        if (hasActiveJob()) throw fault(409, 'Another export is active. Wait for it or cancel it first.');
        const settings = validateOptions(await readJson(req));
        // The body read yields; repeat the check so concurrent requests cannot reserve two workers.
        if (hasActiveJob()) throw fault(409, 'Another export is active.');
        const id = randomUUID(), dir = path.join(jobsRoot, id);
        const job = { id, dir, options: settings, state: 'queued', progress: 0, message: 'Ready to receive the source video.', updated: Date.now() };
        jobs.set(id, job);
        try { await prune(); await fs.promises.mkdir(dir); } catch (error) { jobs.delete(id); throw error; }
        job.timer = setTimeout(() => { setState(job, 'cancelled', 'Upload did not start in time.'); void removeSource(job); }, options.queueTimeoutMs || 10 * 60 * 1000); job.timer.unref();
        json(res, 201, { id, uploadUrl: `/api/jobs/${id}/source` }); return true;
      }
      const match = new RegExp(`^/api/jobs/(${uuidPattern})(?:/(source|files/(result\\.mp4|english\\.srt|subtitles\\.srt)))?$`).exec(route);
      if (!match) throw fault(404, 'API endpoint not found.');
      const job = jobs.get(match[1]); if (!job) throw fault(404, 'Export job not found or expired.');
      if (!match[2] && req.method === 'GET') json(res, 200, snapshot(job));
      else if (!match[2] && req.method === 'DELETE') {
        if (activeStates.has(job.state)) { setState(job, 'cancelled', 'Export cancelled.'); job.uploadStream?.destroy(); await terminate(job.child); await removeSource(job); }
        json(res, 200, snapshot(job));
      } else if (match[2] === 'source' && req.method === 'PUT') {
        if (job.state !== 'queued') throw fault(409, 'This job already received a source video.');
        try { await upload(req, job); json(res, 202, snapshot(job)); }
        catch (error) { fail(job, error.message); throw error; }
      } else if (match[3] && ['GET', 'HEAD'].includes(req.method)) await serveFile(req, res, job, match[3]);
      else throw fault(405, 'Method not allowed.');
    } catch (error) { json(res, error.status || 500, { error: error.status ? error.message : 'Local media service error. Check the server log.' }); if (!error.status) console.error(error); }
    return true;
  }
  async function close() {
    closed = true;
    for (const job of jobs.values()) { clearTimeout(job.timer); if (activeStates.has(job.state)) { setState(job, 'cancelled', 'Server stopped.'); job.uploadStream?.destroy(); } }
    await Promise.all([...children].map(terminate));
    await Promise.all([...jobs.values()].map(removeSource));
  }
  return { handle, close };
}
