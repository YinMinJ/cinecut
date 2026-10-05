"""Run: python -m unittest discover -s tests -p test_media_worker.py -v

Set CINECUT_INTEGRATION=1 with runtime env configured for real FFmpeg/Windows TTS tests.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('media_worker', ROOT / 'scripts' / 'media_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class TimelineTests(unittest.TestCase):
    def test_reordered_clips_remap_subtitles_without_bleeding_across_cut(self):
        cues = [dict(start=2, end=6, text='first'), dict(start=12, end=18, text='last')]
        clips = [dict(start=14, end=16), dict(start=1, end=4)]
        self.assertEqual(worker.remap_cues(cues, clips), [dict(start=0, end=2, text='last'), dict(start=3, end=5, text='first')])

    def test_invalid_ranges_and_unbounded_duration_are_rejected(self):
        for clips in ([dict(start=-1, end=3)], [dict(start=1, end=1)], [dict(start=0, end=20)], [dict(start=float('nan'), end=4)]):
            with self.assertRaises(worker.RenderError):
                worker.validate_clips(clips, 10)
        with self.assertRaises(worker.RenderError):
            worker.validate_clips([dict(start=0, end=601)], 1000)

    def test_speech_fits_available_gap_and_never_overlaps(self):
        cues = [dict(start=0, end=2, text='Hello'), dict(start=4, end=6, text='Goodbye')]
        plan = worker.timing_plan(cues, [5, 2], 8)
        self.assertGreater(plan[0]['speed'], 1)
        self.assertLess(plan[0]['end'], plan[1]['start'])
        self.assertEqual(plan[1]['speed'], 1)
        self.assertLess(plan[-1]['end'], 8)

    def test_unintelligible_speech_speed_fails_instead_of_truncating(self):
        with self.assertRaisesRegex(worker.RenderError, '2 倍速'):
            worker.timing_plan([dict(start=1, end=2, text='This is much too long')], [9], 3)

    def test_captions_cannot_inject_ass_style_and_have_valid_times(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            worker.write_subtitles(path, [dict(start=1.9999, end=4, text=r'Hello {\alpha&HFF&} world')], 1280, 720, 'english')
            ass = (path / 'captions.ass').read_text(encoding='utf-8-sig')
            self.assertNotIn(r'{\alpha', ass)
            self.assertIn('0:00:02.00', ass)
            self.assertIn('00:00:02,000', (path / 'english.srt').read_text())

    def test_untranslated_output_is_not_mislabeled_as_english(self):
        self.assertEqual(worker.normalize_english('“Café” — yes!'), '"Cafe" - yes!')
        with self.assertRaises(worker.RenderError):
            worker.normalize_english('这不是英文')

    def test_clip_actual_mux_duration_is_used_as_next_subtitle_offset(self):
        cues = [dict(start=0, end=1, text='hello')]
        clips = [dict(start=0, end=1, timelineDuration=1.033), dict(start=0, end=1)]
        mapped = worker.remap_cues(cues, clips)
        self.assertAlmostEqual(mapped[1]['start'], 1.033)

    def test_long_chinese_subtitle_is_split_into_three_line_blocks(self):
        cues = worker.bound_cues([dict(start=0, end=30, text='这是一个很长的中文字幕，用来检查字幕是否会溢出视频边界。' * 10)], 720)
        self.assertGreater(len(cues), 1)
        self.assertEqual(cues[0]['start'], 0)
        self.assertEqual(cues[-1]['end'], 30)
        for cue in cues:
            self.assertLessEqual(len(cue['text'].splitlines()), 3)

    def test_demo_credit_is_present_even_when_no_dialogue_subtitles_exist(self):
        with tempfile.TemporaryDirectory() as folder:
            worker.write_subtitles(Path(folder), [], 1280, 720, 'original', 16)
            ass = (Path(folder) / 'captions.ass').read_text(encoding='utf-8-sig')
            self.assertIn('Big Buck Bunny (edited excerpt)', ass)
            self.assertIn('creativecommons.org/licenses/by/3.0/', ass)
            self.assertIn('0:00:16.00,Attribution', ass)


@unittest.skipUnless(os.environ.get('CINECUT_INTEGRATION') == '1', 'Opt-in real FFmpeg and Windows speech tests')
class RealMediaTests(unittest.TestCase):
    def test_english_synthesis_has_nonzero_audio_and_captions_match_audio_duration(self):
        runtime = worker.check_runtime()
        self.assertTrue(runtime['ready'], runtime['problems'])
        with tempfile.TemporaryDirectory() as folder:
            cues = worker.synthesize(runtime['ffmpeg'], Path(folder), [dict(start=.2, end=3, text='This is an English voice test.')], 8)
            samples = worker.read_wave(Path(folder) / 'dub.wav')
            self.assertGreater(max(abs(int(v)) for v in samples), 1000)
            self.assertEqual(len(samples), 8 * worker.RATE)
            self.assertGreater(cues[0]['end'], cues[0]['start'] + 1)
            self.assertLess(cues[0]['end'], 8)
            self.assertGreater(worker.audio_rms(runtime['ffmpeg'], Path(folder) / 'dub.wav'), -50)

    def test_video_without_audio_fails_before_export(self):
        runtime = worker.check_runtime()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            source = path / 'no-audio.mp4'
            worker.run([runtime['ffmpeg'], '-y', '-v', 'error', '-f', 'lavfi', '-i',
                        'color=c=black:s=160x90:d=1', '-an', '-c:v', 'libx264', source])
            (path / 'job.json').write_text(json.dumps(dict(source=str(source), clips=[dict(start=0, end=1)], mode='original')), encoding='utf-8')
            with self.assertRaisesRegex(worker.RenderError, '没有音轨'):
                worker.render_job(path / 'job.json')
            self.assertFalse((path / 'result.mp4').exists())


if __name__ == '__main__':
    unittest.main()
