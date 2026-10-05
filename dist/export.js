const $ = id => document.getElementById(id);

// Export through the loopback server. Audio is decoded and checked by FFmpeg,
// independently of the preview player's mute button and browser autoplay state.
export function setupExporter({state, setBusy, toast, total}) {
  let capabilities;
  async function json(url, options = {}) {
    const response = await fetch(url, {cache: 'no-store', ...options});
    let body;
    try { body = await response.json(); } catch { throw new Error('本机导出服务不可用，请运行新版 start-local.cmd 后刷新页面。'); }
    if (!response.ok) throw new Error(body.error || `本机服务返回 ${response.status}`);
    return body;
  }
  function modeReady(mode) {
    if (!capabilities) return false;
    if (mode === 'original-english') return capabilities.subtitleReady ?? capabilities.capabilities?.['original-english'] ?? false;
    if (mode === 'english') return capabilities.englishReady ?? false;
    return capabilities.originalReady ?? false;
  }
  function updateMode() {
    const mode = $('exportMode').value, translated = mode !== 'original';
    $('burnSubtitles').disabled = translated || Boolean(state.exportJob);
    if (translated) $('burnSubtitles').checked = true;
    $('subtitleExportNote').textContent = translated
      ? state.demo ? '内置示例主要是音乐与音效。请导入有对白的影片以生成英文字幕；此示例可以选择「原声＋已导入字幕」导出。' : mode === 'original-english' ? '自动识别原语言并翻译为英文字幕，字幕时间与原片对白对应；保留电影原声。' : '自动翻译对白为英语，生成英文配音并将英文字幕烧入画面。'
      : state.cues.length ? `已导入 ${state.cues.length} 条字幕，按剪辑后的时间烧入画面。` : '尚未导入字幕。如需自动生成英文字幕，请选择「原声＋自动英文字幕」。';
    $('englishNote').hidden = !translated;
    $('englishNote').textContent = mode === 'english' ? '使用通用英文音色替换原声，不保留原背景音乐或同步口型。没有可识别对白时会提示。' : '保留原片对白、配乐和音效。仅将对白翻译成英文字幕，烧录到画面中，并提供独立 SRT 文件。';
    const ready = modeReady(mode);
    $('startExportBtn').disabled = !ready || Boolean(state.exportJob) || (translated && state.demo);
    if (capabilities) {
      $('engineStatus').textContent = ready ? '● 本机导出引擎已就绪' : '● 当前导出模式需要配置';
      if (!ready) $('subtitleExportNote').textContent = (capabilities.modeProblems?.[mode] || capabilities.problems || ['请配置本机引擎后重试。']).join('；');
    }
  }
  $('exportMode').onchange = updateMode;
  $('exportBtn').onclick = async () => {
    if (!state.clips.length || state.busy) return;
    $('video').pause();
    $('exportDuration').textContent = `${total().toFixed(1)} 秒`;
    $('exportStatus').textContent = '正在检查本机语音和导出引擎…';
    $('downloadLink').hidden = true;
    $('subtitleDownload').hidden = true;
    $('exportPreview').hidden = true;
    $('exportPreview').pause();
    $('exportProgress').hidden = true;
    $('exportResult').hidden = true;
    $('startExportBtn').hidden = false;
    capabilities = null;
    updateMode();
    $('exportDialog').showModal();
    try {
      capabilities = await json('/api/capabilities');
      $('exportStatus').textContent = modeReady($('exportMode').value) ? (state.demo ? '请导入有对白的视频，或使用已导入字幕模式导出演示片。' : '准备就绪，原声与英文字幕将一起写入 MP4。') : '请按提示配置所选模式需要的本机引擎。';
    } catch (error) { $('exportStatus').textContent = error.message; }
    updateMode();
  };
  const headers = () => ({'X-CineCut-Token': capabilities.token});
  function upload(url, blob, job) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); job.xhr = xhr;
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-CineCut-Token', capabilities.token);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          const percent = Math.round(event.loaded / event.total * 100);
          $('exportProgress').value = percent;
          $('exportStatus').textContent = `正在将素材交给本机引擎 · ${percent}%（不发送到互联网）`;
        }
      };
      xhr.onerror = () => reject(new Error('本机素材传输失败，请确认服务仍在运行。'));
      xhr.onabort = () => reject(new DOMException('已取消', 'AbortError'));
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `素材读取失败（${xhr.status}）`));
      };
      if (job.cancelled) return reject(new DOMException('已取消', 'AbortError'));
      xhr.send(blob);
    });
  }
  async function start() {
    if (state.exportJob || !capabilities?.token || !state.blob) return;
    const job = {id: null, cancelled: false, xhr: null, abort: new AbortController()};
    state.exportJob = job;
    setBusy(true);
    $('startExportBtn').hidden = true;
    $('closeExportBtn').disabled = true;
    $('cancelExportBtn').hidden = false;
    $('exportMode').disabled = true;
    $('quality').disabled = true;
    $('burnSubtitles').disabled = true;
    $('downloadLink').hidden = true;
    $('subtitleDownload').hidden = true;
    $('exportResult').hidden = true;
    $('exportPreview').pause();
    $('exportPreview').hidden = true;
    $('exportProgress').hidden = false;
    $('exportProgress').value = 0;
    try {
      const created = await json('/api/jobs', {
        method: 'POST', headers: {...headers(), 'Content-Type': 'application/json'},
        body: JSON.stringify({sourceName: state.fileName, clips: state.clips.map(({start, end}) => ({start, end})),
          aspect: $('aspect').value, quality: Number($('quality').value), mode: $('exportMode').value,
          cues: $('burnSubtitles').checked ? state.cues : [], demo: state.demo})
      });
      job.id = created.id;
      if (job.cancelled) throw new DOMException('已取消', 'AbortError');
      await upload(created.uploadUrl, state.blob, job);
      while (!job.cancelled) {
        const status = await json(`/api/jobs/${job.id}`, {signal: job.abort.signal});
        $('exportProgress').value = status.progress || 0;
        $('exportStatus').textContent = status.message || '本机引擎处理中…';
        if (status.status === 'failed') throw new Error(status.message || '导出失败');
        if (status.status === 'cancelled') throw new DOMException('已取消', 'AbortError');
        if (status.status === 'completed') {
          const result = status.result;
          $('downloadLink').href = result.videoUrl;
          $('downloadLink').download = $('exportMode').value === 'english' ? 'CineCut-English.mp4' : $('exportMode').value === 'original-english' ? 'CineCut-Original-English-Subtitles.mp4' : 'CineCut-Original.mp4';
          $('downloadLink').hidden = false;
          if (result.subtitlesUrl) {
            $('subtitleDownload').href = result.subtitlesUrl;
            $('subtitleDownload').download = $('exportMode').value !== 'original' ? 'CineCut-English.srt' : 'CineCut-Subtitles.srt';
            $('subtitleDownload').hidden = false;
          }
          $('exportPreview').src = result.videoUrl;
          $('exportPreview').muted = false;
          $('exportPreview').hidden = false;
          $('exportProgress').value = 100;
          $('exportStatus').textContent = '成片已生成，音轨检查通过。请播放检查声音与字幕后下载。';
          $('exportResult').textContent = `MP4 · ${result.audioMode === 'dubbed' ? '英文配音' : '电影原声'} · ${result.subtitleCount || 0} 条${result.subtitleLanguage === 'en' ? '英文' : ''}烧录字幕${Number.isFinite(result.audioRmsDb) ? ` · 音量 ${result.audioRmsDb.toFixed(1)} dBFS` : ''}${result.warnings?.length ? '\n' + result.warnings.join('\n') : ''}`;
          $('exportResult').hidden = false;
          $('exportResult').scrollIntoView({block: 'nearest', behavior: 'smooth'});
          toast('成片与字幕已就绪');
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      $('exportStatus').textContent = job.cancelled || error.name === 'AbortError' ? '导出已取消，可以重新开始。' : error.message;
      if (job.id) await json(`/api/jobs/${job.id}`, {method: 'DELETE', headers: headers()}).catch(() => {});
    } finally {
      // POST may have finished after the user cancelled. Release its reservation too.
      if (job.cancelled && job.id) await json(`/api/jobs/${job.id}`, {method: 'DELETE', headers: headers()}).catch(() => {});
      state.exportJob = null;
      setBusy(false);
      $('startExportBtn').hidden = false;
      $('startExportBtn').textContent = '重新导出';
      $('closeExportBtn').disabled = false;
      $('cancelExportBtn').hidden = true;
      $('cancelExportBtn').disabled = false;
      $('exportMode').disabled = false;
      $('quality').disabled = false;
      updateMode();
    }
  }
  $('startExportBtn').onclick = () => void start();
  $('cancelExportBtn').onclick = async () => {
    const job = state.exportJob;
    if (!job) return;
    job.cancelled = true;
    job.xhr?.abort();
    job.abort.abort();
    $('cancelExportBtn').disabled = true;
    $('exportStatus').textContent = '正在取消并停止本机处理…';
    if (job.id) await json(`/api/jobs/${job.id}`, {method: 'DELETE', headers: headers()}).catch(() => {});
  };
  $('exportDialog').addEventListener('close', () => $('exportPreview').pause());
  $('exportDialog').addEventListener('cancel', event => { if (state.exportJob) event.preventDefault(); });
  window.addEventListener('beforeunload', () => {
    const job = state.exportJob;
    if (job?.id) void fetch(`/api/jobs/${job.id}`, {method: 'DELETE', headers: headers(), keepalive: true});
  });
}
