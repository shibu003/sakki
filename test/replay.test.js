// 再生の純粋部分（AC-1 ②・AC-2・AC-5）
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline, frame, GHOST, FILLED, awayText } from '../src/replay.js';

const nameBox = { x: 100, y: 100, w: 200, h: 30 };
const dayBox = { x: 100, y: 200, w: 200, h: 30 };
const btnBox = { x: 100, y: 1400, w: 120, h: 40 };
const S = {
  pages: [
    {
      tab: 1, host: 'booking.test', t: 0, vw: 800, vh: 600, dh: 2000,
      items: [
        { k: 'heading', x: 100, y: 40, w: 400, h: 30, s: '宿の予約' },
        { k: 'field', ...nameBox, s: 'お名前' },
        { k: 'field', ...dayBox, s: '泊まる日' },
        { k: 'button', ...btnBox, s: '予約する', sub: 1 },
        { k: 'media', x: 600, y: 100, w: 120, h: 160 },
        { k: 'band', x: 0, y: 0, w: 800, h: 30 },
      ],
      evs: [
        { t: 0, k: 'focus', ...nameBox },
        { t: 2000, k: 'input', ...nameBox, n: 2 },
        { t: 12000, k: 'focus', ...dayBox },       // 10 秒止まっていた
        { t: 13000, k: 'input', ...dayBox, n: 1 },
        { t: 14000, k: 'input', ...dayBox, n: 1 },
        { t: 15000, k: 'input', ...dayBox, n: 1 },
        { t: 16000, k: 'click', ...btnBox, s: '予約する' },
      ],
    },
    { away: true, tab: 1, host: 'auth.test', t: 17000, t1: 197000 },
    { tab: 1, host: 'booking.test', t: 198000, vw: 800, vh: 600, dh: 600, items: [{ k: 'heading', x: 100, y: 40, w: 400, h: 30, s: '■■ 様の予約内容' }], evs: [{ t: 198000, k: 'click', x: 100, y: 40, w: 400, h: 30 }] },
  ],
};
const view = { w: 400, h: 500 };
const centerOf = (b) => [b.x + b.w / 2, b.y + b.h / 2];

test('replay: 事象の順に、同じ箱の中心を通る（AC-2 ①）', () => {
  const tl = timeline(S);
  const evSteps = tl.steps.filter((s) => s.ev);
  assert.equal(evSteps.length, 8);
  for (const s of evSteps) {
    const f = frame(S, s.rt, view, tl);
    const box = f.items.find((it) => it.x === s.ev.x * 0.5 && it.w === s.ev.w * 0.5 && Math.abs(it.y + it.h / 2 - f.ghost.y) < 1);
    assert.ok(box, `t=${s.ev.t} の箱が表示リストに在り、ゴーストと同じ高さ`);
    const [cx, cy] = centerOf(box);
    assert.ok(Math.abs(f.ghost.x - cx) <= 1 && Math.abs(f.ghost.y - cy) <= 1, `t=${s.ev.t}: ghost (${f.ghost.x},${f.ghost.y}) vs (${cx},${cy})`);
  }
});

test('replay: 早送り — 10 秒の間は 0.5 秒以下（AC-2 ②）', () => {
  const { steps } = timeline(S);
  const [a, b] = steps.filter((s) => s.ev && (s.ev.t === 2000 || s.ev.t === 12000));
  assert.ok(b.rt - a.rt <= 500, `${b.rt - a.rt}ms`);
  assert.ok(b.rt - a.rt > 0);
});

test('replay: ゴーストは名札付きで半透明（AC-2 ①）', () => {
  const f = frame(S, 100, view);
  assert.equal(f.ghost.label, 'さっきの私');
  assert.ok(f.ghost.alpha >= 0.4 && f.ghost.alpha <= 0.8);
  assert.equal(GHOST.label, 'さっきの私');
});

test('replay: 入力のあった欄は ●●● を持つ（AC-1 ②）', () => {
  const tl = timeline(S);
  const afterInput = tl.steps.find((s) => s.ev && s.ev.t === 2000).rt;
  const before = frame(S, 0, view, tl).items.find((it) => it.s === 'お名前');
  const after = frame(S, afterInput, view, tl).items.find((it) => it.s === 'お名前');
  assert.equal(before.v, undefined);
  assert.equal(after.v, FILLED);
});

test('replay: よそのサイトの間は箱の文字だけを出す（AC-4 a）', () => {
  const tl = timeline(S);
  const away = tl.steps.find((s) => s.away);
  assert.equal(frame(S, away.rt + 10, view, tl).card.text, 'auth.test で 3 分');
});

test('replay: 決定的で、出る文字は記録の中の文字と固定の語だけ（AC-5）', () => {
  const tl = timeline(S);
  const allowed = new Set([GHOST.label, FILLED]);
  for (const p of S.pages) {
    if (p.away) allowed.add(awayText(p));
    for (const it of p.items || []) if (it.s) allowed.add(it.s);
    for (const e of p.evs || []) if (e.s) allowed.add(e.s);
  }
  for (let t = 0; t <= tl.total; t += 50) {
    const a = frame(S, t, view, tl);
    assert.deepEqual(frame(S, t, view, timeline(S)), a);
    const texts = [...a.items.flatMap((it) => [it.s, it.v]), a.ghost?.label, a.card?.text].filter(Boolean);
    for (const s of texts) assert.ok(allowed.has(s), `t=${t}: 記録に無い文字「${s}」`);
  }
});

test('replay: 記録が空なら何も描かない', () => {
  const f = frame({ pages: [] }, 0, view);
  assert.deepEqual([f.items, f.ghost, f.total], [[], null, 0]);
});
