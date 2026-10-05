import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSubtitles,makeCandidates,chooseClips,validRange} from '../dist/logic.js';
test('subtitle parsing preserves multiline text and clips timestamps to source duration',()=>{
  const cues=parseSubtitles('\uFEFF1\r\n00:00:02,100 --> 00:00:04,200\r\n<b>快跑！</b>\r\n第二行\r\n\r\n2\r\n00:00:09,000 --> 00:00:20,000\r\n再见',10);
  assert.equal(cues.length,2);assert.equal(cues[0].text,'快跑！\n第二行');assert.equal(cues[1].end,10);
  assert.equal(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.500\nHello')[0].start,1);
});
test('candidate selection keeps valid non-overlapping ranges within the target duration',()=>{
  const samples=Array.from({length:50},(_,i)=>({time:i*2+.5,delta:i%7+2,thumb:'data:test'}));
  const candidates=makeCandidates(samples,[],100,'dynamic');
  for(const c of candidates)assert.ok(validRange(c.start,c.end,100));
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++)assert.ok(Math.min(candidates[i].end,candidates[j].end)<=Math.max(candidates[i].start,candidates[j].start));
  const selected=chooseClips(candidates,11.5);assert.ok(Math.abs(selected.reduce((n,c)=>n+c.end-c.start,0)-11.5)<.01);
  assert.equal(validRange(-1,3,5),false);assert.equal(validRange(1,7,5),false);
});
