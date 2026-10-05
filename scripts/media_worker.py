"""Local CineCut rendering. No model downloads or network requests at runtime."""
from __future__ import annotations

import argparse
import array
import ctypes
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import textwrap
import threading
import unicodedata
import wave

ROOT = Path(__file__).resolve().parent.parent
MAX_DURATION = 600
RATE = 48000
ACTIVE_CHILDREN = set()


class RenderError(Exception):
    pass


def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def run(args, cwd=None, timeout=1800):
    try:
        child = subprocess.Popen([str(a) for a in args], cwd=cwd, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, creationflags=0x08000000 if os.name == 'nt' else 0)
        ACTIVE_CHILDREN.add(child)
        try:
            stdout, stderr = child.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
            raise
        finally:
            ACTIVE_CHILDREN.discard(child)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RenderError(f'无法执行本地媒体工具：{exc}') from exc
    if child.returncode:
        detail = (stderr or stdout).decode('utf-8', errors='replace').strip()
        raise RenderError(f'媒体处理失败：{detail[-2500:]}')
    return stdout


def watch_parent(pid):
    """Do not leave CPU-heavy FFmpeg/ASR behind after a crashed local server."""
    if not pid or int(pid) != os.getppid() or os.name != 'nt':
        return
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x00100000, False, int(pid))
    if not handle:
        return
    def wait():
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        for child in list(ACTIVE_CHILDREN):
            try:
                child.kill()
            except OSError:
                pass
        os._exit(1)
    threading.Thread(target=wait, daemon=True).start()


def executable(env, name):
    candidate = os.environ.get(env) or shutil.which(name)
    return str(Path(candidate).resolve()) if candidate and Path(candidate).is_file() else None


def model_path():
    candidate = os.environ.get('CINECUT_WHISPER_MODEL', '')
    if not candidate:
        return None
    path = Path(candidate).resolve()
    # A name like "small" must never trigger a Hugging Face download.
    required = ('model.bin', 'config.json', 'tokenizer.json')
    return str(path) if path.is_dir() and all((path / name).is_file() for name in required) else None


def speech_command():
    shell = shutil.which('powershell.exe')
    if not shell:
        raise RenderError('英文配音需要 Windows PowerShell 和已安装的英语语音包。')
    return [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', ROOT / 'scripts' / 'synthesize.ps1']


def check_runtime():
    ffmpeg, ffprobe = executable('CINECUT_FFMPEG', 'ffmpeg'), executable('CINECUT_FFPROBE', 'ffprobe')
    model = model_path()
    installed = importlib.util.find_spec('faster_whisper') is not None and importlib.util.find_spec('numpy') is not None
    problems = []
    voice = None
    if not ffmpeg or not ffprobe:
        problems.append('请配置 CINECUT_FFMPEG 与 CINECUT_FFPROBE。')
    if not installed:
        problems.append('请先安装 requirements-english.txt 中的 Python 依赖。')
    if not model:
        problems.append('未找到完整的离线 Whisper 模型，请配置 CINECUT_WHISPER_MODEL。')
    try:
        voice = json.loads(run(speech_command() + ['-Check'], timeout=30).decode('utf-8-sig'))['voice']
    except (RenderError, ValueError, KeyError) as exc:
        problems.append(f'英语配音不可用：{exc}')
    original = bool(ffmpeg and ffprobe)
    english = bool(original and installed and model and voice)
    return dict(ready=english, problems=problems, capabilities=dict(original=original, english=english),
                ffmpeg=ffmpeg, ffprobe=ffprobe, model=model, voice=voice, fasterWhisper=installed)


def probe(ffprobe, path):
    return json.loads(run([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))


def dimensions(aspect, quality):
    if str(quality) not in ('720', '1080') or aspect not in ('16:9', '9:16', '1:1'):
        raise RenderError('导出比例或分辨率无效。')
    short = int(quality)
    long = 1280 if short == 720 else 1920
    return (long, short) if aspect == '16:9' else (short, long) if aspect == '9:16' else (short, short)


def validate_clips(clips, duration):
    if not isinstance(clips, list) or not 1 <= len(clips) <= 100:
        raise RenderError('请选择 1 至 100 个有效片段。')
    checked = []
    for clip in clips:
        try:
            start, end = float(clip['start']), float(clip['end'])
        except (TypeError, KeyError, ValueError) as exc:
            raise RenderError('片段起止时间无效。') from exc
        if not math.isfinite(start + end) or start < 0 or end <= start or end > duration + .15:
            raise RenderError('片段时间超出了源视频范围。')
        checked.append(dict(start=start, end=min(end, duration)))
    if sum(c['end'] - c['start'] for c in checked) > MAX_DURATION:
        raise RenderError('单次导出最长 10 分钟，请缩短片段。')
    return checked


def remap_cues(cues, clips):
    result, offset = [], 0.0
    for clip in clips:
        for cue in cues:
            try:
                start, end = max(float(cue['start']), clip['start']), min(float(cue['end']), clip['end'])
                text = str(cue['text']).strip()
            except (TypeError, ValueError, KeyError):
                continue
            if end > start and text:
                result.append(dict(start=offset + start - clip['start'], end=offset + end - clip['start'], text=text))
        offset += clip.get('timelineDuration', clip['end'] - clip['start'])
    return sorted(result, key=lambda cue: cue['start'])


def timestamp(seconds, ass=False):
    units = 100 if ass else 1000
    value = max(0, int(round(seconds * units)))
    hour, value = divmod(value, units * 3600)
    minute, value = divmod(value, units * 60)
    second, fraction = divmod(value, units)
    return f'{hour}:{minute:02d}:{second:02d}.{fraction:02d}' if ass else f'{hour:02d}:{minute:02d}:{second:02d},{fraction:03d}'


def safe_caption(text):
    # ASS override syntax must never come from imported subtitles.
    return str(text).replace('\\', '／').replace('{', '(').replace('}', ')').replace('\r', '').strip()


def caption_lines(text, columns):
    # Count CJK glyphs as double-width, so imported captions also stay on screen.
    words = re.findall(r'[\u2e80-\uffef]|[^\s\u2e80-\uffef]+', ' '.join(text.split()))
    lines, line = [], ''
    measure = lambda s: sum(2 if unicodedata.east_asian_width(c) in ('W', 'F') else 1 for c in s)
    for word in words:
        separator = ' ' if line and not (measure(word) == 2 and len(word) == 1) else ''
        if line and measure(line + separator + word) > columns:
            lines.append(line)
            line = ''
            separator = ''
        line += separator + word
        while measure(line) > columns:
            cut = max(1, columns)
            while measure(line[:cut]) > columns:
                cut -= 1
            lines.append(line[:cut])
            line = line[cut:]
    if line:
        lines.append(line)
    return lines


def bound_cues(cues, width):
    size = max(24, round(width / 30))
    columns = max(26, round(width * .87 / (size * .55)))
    result = []
    for cue in cues:
        lines = caption_lines(cue['text'], columns)
        blocks = ['\n'.join(lines[i:i + 3]) for i in range(0, len(lines), 3)]
        for index, block in enumerate(blocks):
            result.append(dict(start=cue['start'] + (cue['end'] - cue['start']) * index / len(blocks),
                               end=cue['start'] + (cue['end'] - cue['start']) * (index + 1) / len(blocks), text=block))
    return result


def write_subtitles(jobdir, cues, width, height, mode, demo_duration=0):
    name = 'english.srt' if mode == 'english' else 'subtitles.srt'
    parts = []
    for index, cue in enumerate(cues, 1):
        parts.append(f"{index}\n{timestamp(cue['start'])} --> {timestamp(cue['end'])}\n{cue['text']}\n")
    (jobdir / name).write_text('\n'.join(parts), encoding='utf-8')
    size = max(24, round(width / 30))
    margin = round(width * .065)
    header = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,{size},&H00FFFFFF,&H00FFFFFF,&H00101010,&H99000000,-1,0,0,0,100,100,0,0,1,2,1,2,{margin},{margin},{round(height * .065)},1
Style: Attribution,Arial,{max(12, round(width / 80))},&H00FFFFFF,&H00FFFFFF,&H00101010,&H99000000,0,0,0,0,100,100,0,0,1,1,1,7,18,18,16,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    lines = []
    columns = max(26, round((width - margin * 2) / (size * .55)))
    for cue in cues:
        wrapped = r'\N'.join(caption_lines(safe_caption(cue['text']), columns))
        lines.append(f"Dialogue: 0,{timestamp(cue['start'], True)},{timestamp(cue['end'], True)},Default,,0,0,0,,{wrapped}")
    if demo_duration:
        credit = r'Big Buck Bunny (edited excerpt)\N(c) 2008 Blender Foundation / bigbuckbunny.org\NCC BY 3.0 - creativecommons.org/licenses/by/3.0/'
        lines.append(f'Dialogue: 1,0:00:00.00,{timestamp(demo_duration, True)},Attribution,,0,0,0,,{credit}')
    (jobdir / 'captions.ass').write_text(header + '\n'.join(lines) + '\n', encoding='utf-8-sig')
    return name


def audio_rms(ffmpeg, path):
    audio = run([ffmpeg, '-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'])
    values = array.array('f')
    values.frombytes(audio)
    if sys.byteorder != 'little':
        values.byteswap()
    if not len(values):
        return -120.0
    rms = math.sqrt(sum(value * value for value in values) / len(values))
    return round(20 * math.log10(max(rms, 1e-6)), 2)


def normalize_english(text):
    text = text.replace('’', "'").replace('‘', "'").replace('“', '"').replace('”', '"').replace('—', '-').replace('…', '...')
    text = unicodedata.normalize('NFKD', text)
    text = ''.join(c for c in text if not unicodedata.combining(c))
    if any(ord(c) > 127 and c.isalpha() for c in text):
        raise RenderError('模型未生成可用的英语译文，请使用支持翻译的多语言 Whisper 模型。')
    return ' '.join(text.encode('ascii', errors='ignore').decode().split())


def split_cue(start, end, text):
    chunks = textwrap.wrap(text, width=88, break_long_words=False, break_on_hyphens=False)
    total = sum(len(chunk) for chunk in chunks)
    cues, offset = [], start
    for chunk in chunks:
        length = (end - start) * len(chunk) / max(1, total)
        cues.append(dict(start=offset, end=offset + length, text=chunk))
        offset += length
    return cues


def translate(ffmpeg, parts, jobdir, duration):
    from faster_whisper import WhisperModel
    path = model_path()
    if not path:
        raise RenderError('离线 Whisper 模型尚未配置；此应用不会自动下载模型。')
    emit(progress=35, message='正在加载离线翻译模型（CPU 首次加载可能需要数分钟）…')
    model = WhisperModel(path, device='cpu', compute_type='int8', local_files_only=True,
                         cpu_threads=max(1, min(8, (os.cpu_count() or 4) - 1)))
    cues, languages, offset = [], [], 0.0
    for part, part_duration in parts:
        run([ffmpeg, '-y', '-v', 'error', '-i', part, '-vn', '-ac', '1', '-ar', '16000', jobdir / 'recognition.wav'])
        segments, info = model.transcribe(str(jobdir / 'recognition.wav'), task='translate',
            beam_size=5, vad_filter=True, condition_on_previous_text=False,
            vad_parameters=dict(min_silence_duration_ms=300), word_timestamps=False)
        for segment in segments:
            emit(progress=min(65, 38 + 27 * (offset + segment.end) / duration), message=f'正在识别并翻译为英语：{min(duration, offset + segment.end):.0f} / {duration:.0f} 秒')
            if segment.no_speech_prob > .65 or segment.avg_logprob < -1.5:
                continue
            start, end = max(0, segment.start), min(part_duration - .04, segment.end)
            text = normalize_english(segment.text)
            if end > start and re.search(r'[A-Za-z]', text):
                cues.extend(split_cue(offset + start, offset + end, text))
                if info.language not in languages:
                    languages.append(info.language)
        offset += part_duration
    if not cues:
        raise RenderError('选中片段没有识别到可翻译的人声。请选有对白的片段；纯音乐、环境声和无对白演示片不能生成英文配音。')
    return cues, languages


def read_wave(path):
    import numpy as np
    with wave.open(str(path), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != RATE:
            raise RenderError('配音音频格式异常。')
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').copy()


def write_wave(path, samples):
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(samples.astype('<i2').tobytes())


def trim_voice(samples):
    import numpy as np
    active = np.flatnonzero(np.abs(samples.astype(np.int32)) > 180)
    if not len(active):
        raise RenderError('英语语音合成产生了空白音频，请检查 Windows 英语语音包。')
    pad = int(RATE * .045)
    return samples[max(0, active[0] - pad):min(len(samples), active[-1] + pad + 1)]


def timing_plan(cues, durations, total):
    plan = []
    previous_end = 0
    for index, (cue, spoken) in enumerate(zip(cues, durations)):
        start = max(float(cue['start']), previous_end)
        limit = min(total - .015, float(cues[index + 1]['start']) - .025) if index + 1 < len(cues) else total - .015
        capacity = limit - start
        if capacity < .12:
            raise RenderError('对白片段间隔过短，无法放入清晰的英语配音；请保留更完整的对白片段。')
        speed = max(1.0, spoken / max(.01, capacity - .035))
        if speed > 2.0:
            raise RenderError('英语译文比选中对白片段过长，配音需要超过 2 倍速。请增加片段时长后重试。')
        plan.append(dict(start=start, end=start + spoken / speed, speed=speed, limit=limit, text=cue['text']))
        previous_end = start + spoken / speed
    return plan


def synthesize(ffmpeg, jobdir, cues, duration):
    import numpy as np
    request = dict(items=[dict(text=c['text'], file=str(jobdir / f'voice-{i:03d}.wav')) for i, c in enumerate(cues)])
    (jobdir / 'speech.json').write_text(json.dumps(request, ensure_ascii=False), encoding='utf-8')
    emit(progress=68, message=f'正在生成 {len(cues)} 段英语配音…')
    run(speech_command() + ['-Request', jobdir / 'speech.json'], timeout=900)
    voices = [trim_voice(read_wave(jobdir / f'voice-{i:03d}.wav')) for i in range(len(cues))]
    plan = timing_plan(cues, [len(v) / RATE for v in voices], duration)
    result = np.zeros(math.ceil(duration * RATE), dtype=np.int16)
    fitted = []
    for index, (item, samples) in enumerate(zip(plan, voices)):
        if item['speed'] > 1.001:
            write_wave(jobdir / 'tempo-input.wav', samples)
            run([ffmpeg, '-y', '-v', 'error', '-i', jobdir / 'tempo-input.wav',
                 '-af', f"atempo={item['speed']:.8f}", '-ac', '1', '-ar', str(RATE), jobdir / 'tempo-output.wav'])
            samples = trim_voice(read_wave(jobdir / 'tempo-output.wav'))
        start = round(item['start'] * RATE)
        end = start + len(samples)
        if end > round(item['limit'] * RATE) or end > len(result):
            raise RenderError('英语配音无法完整放入片段，已停止导出以避免截断；请增加片段时长。')
        result[start:end] = samples
        fitted.append(dict(start=start / RATE, end=end / RATE, text=item['text']))
        emit(progress=70 + 10 * (index + 1) / len(cues), message=f'英语配音对齐：{index + 1} / {len(cues)}')
    write_wave(jobdir / 'dub.wav', result)
    return fitted


def render_job(jobfile):
    jobfile = Path(jobfile).resolve()
    jobdir = jobfile.parent
    job = json.loads(jobfile.read_text(encoding='utf-8-sig'))
    watch_parent(job.get('parentPid'))
    source = Path(job.get('source', '')).resolve()
    if not source.is_file():
        raise RenderError('找不到上传的视频文件，请重新导入。')
    mode = job.get('mode', 'english')
    if mode not in ('english', 'original'):
        raise RenderError('导出模式无效。')
    runtime = check_runtime()
    if not runtime['capabilities'][mode]:
        raise RenderError('；'.join(runtime['problems']))
    ffmpeg, ffprobe = runtime['ffmpeg'], runtime['ffprobe']
    metadata = probe(ffprobe, source)
    if not any(s.get('codec_type') == 'video' for s in metadata['streams']):
        raise RenderError('文件没有可读取的视频轨道。')
    if not any(s.get('codec_type') == 'audio' for s in metadata['streams']):
        raise RenderError('源视频没有音轨，无法导出有声成片或生成英语配音。')
    try:
        source_duration = float(metadata['format']['duration'])
    except (KeyError, ValueError):
        raise RenderError('无法读取视频时长。')
    clips = validate_clips(job.get('clips'), source_duration)
    width, height = dimensions(job.get('aspect', '16:9'), job.get('quality', '720'))
    emit(progress=2, message='正在提取视频和音轨…')
    parts = []
    for index, clip in enumerate(clips):
        length = clip['end'] - clip['start']
        run([ffmpeg, '-y', '-v', 'error', '-ss', f"{clip['start']:.6f}", '-i', source,
             '-t', f'{length:.6f}', '-map', '0:v:0', '-map', '0:a:0',
             '-vf', f'scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30',
             '-af', f'apad,atrim=duration={length:.6f},asetpts=PTS-STARTPTS',
             '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
             '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', jobdir / f'part-{index:03d}.mp4'])
        part_path = jobdir / f'part-{index:03d}.mp4'
        clip['timelineDuration'] = float(probe(ffprobe, part_path)['format']['duration'])
        parts.append((part_path, clip['timelineDuration']))
        emit(progress=3 + 25 * (index + 1) / len(clips), message=f'已提取片段 {index + 1} / {len(clips)}')
    (jobdir / 'concat.txt').write_text(''.join(f"file 'part-{i:03d}.mp4'\n" for i in range(len(clips))), encoding='utf-8')
    montage = jobdir / 'montage.mp4'
    run([ffmpeg, '-y', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', 'montage.mp4'], cwd=jobdir)
    duration = float(probe(ffprobe, montage)['format']['duration'])
    if audio_rms(ffmpeg, montage) <= -70:
        raise RenderError('选中片段的音轨为空白或接近静音，已停止无声导出；请检查原视频或选择有声音的片段。')
    source_languages, warnings = [], []
    if mode == 'english':
        if job.get('demo'):
            raise RenderError('内置 Big Buck Bunny 演示片没有可翻译对白。请导入含有人声的视频，或改用保留原声模式。')
        cues, source_languages = translate(ffmpeg, parts, jobdir, duration)
        cues = synthesize(ffmpeg, jobdir, cues, duration)
    else:
        cues = bound_cues(remap_cues(job.get('cues') or [], clips), width)
        if not cues:
            warnings.append('未提供字幕；本次保留原声导出不包含字幕。')
    burn_captions = bool(cues or job.get('demo'))
    subtitle_name = write_subtitles(jobdir, cues, width, height, mode, duration if job.get('demo') else 0) if burn_captions else None
    emit(progress=83, message='正在压制 MP4，写入音轨和画面字幕…')
    command = [ffmpeg, '-y', '-v', 'error', '-i', 'montage.mp4']
    if mode == 'english':
        command += ['-i', 'dub.wav', '-map', '0:v:0', '-map', '1:a:0']
    else:
        command += ['-map', '0:v:0', '-map', '0:a:0']
    if mode == 'english':
        command += ['-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English narration']
    if burn_captions:
        command += ['-vf', 'ass=captions.ass', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
    else:
        command += ['-c:v', 'copy']
    command += ['-c:a', 'aac', '-b:a', '192k', '-ar', str(RATE), '-ac', '2', '-t', f'{duration:.6f}', '-movflags', '+faststart', 'result.mp4']
    run(command, cwd=jobdir)
    emit(progress=96, message='正在检查成片音轨与字幕…')
    final_meta = probe(ffprobe, jobdir / 'result.mp4')
    if not any(s.get('codec_type') == 'audio' and s.get('codec_name') == 'aac' for s in final_meta['streams']):
        raise RenderError('成片音轨校验失败。')
    rms = audio_rms(ffmpeg, jobdir / 'result.mp4')
    if rms <= -70:
        raise RenderError('成片静音校验失败，未交付无声文件。')
    files = dict(video='result.mp4')
    if subtitle_name and cues:
        files['subtitles'] = subtitle_name
    return dict(done=True, duration=round(float(final_meta['format']['duration']), 3), language='en' if mode == 'english' else None,
                sourceLanguages=source_languages,
                subtitleCount=len(cues), audioRmsDb=rms, files=files, warnings=warnings)


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--job')
    args = parser.parse_args()
    try:
        if args.check:
            emit(**check_runtime())
        elif args.job:
            emit(**render_job(args.job))
        else:
            parser.error('--check or --job is required')
    except Exception as exc:
        emit(error=str(exc) or type(exc).__name__)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
