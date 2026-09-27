// sakki-mvp の module review（2026-09-27）の攻撃: 覚える集まりが後から育った時、前に取った文字にも当たるか（弱点 #6「どこに出ても ■」）
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/redact.js';
import { reduce, initialState, takeReply } from '../src/session.js';

const { remember } = globalThis.sakki;
const SEED = 7;
function run(msgs, st = initialState()) {
  for (const m of msgs) st = takeReply(reduce(st, { seed: SEED, ...m }))[0];
  return st;
}
const box = { x: 0, y: 0, w: 200, h: 30 };
// 1 ページ目: 本文（帯の外）と見出しに名前が出ている。まだ誰も打っていないので覚える集まりは空 = 記録の時点では伏せられない
const dom1 = '<!doctype html><html><head><style media="(width > 600px)">p>b{content:"a>b"}</style></head>'
  + '<body><h1 title="山田太郎さん">山田太郎さんのページ</h1><p data-x="a>b">ご予約者: 山田太郎 様 &amp; ■■■■</p><img alt="顔" src="https://s.test/a.png?w=2"></body></html>';
const page1 = { type: 'page', tab: 1, host: 'm.test', t: 1010, vw: 800, vh: 600, dh: 800, items: [{ k: 'heading', ...box, s: '山田太郎さんのページ' }], dom: dom1 };
// 2 ページ目で「お名前」に 山田太郎 と打つ → 覚える集まりに入る
const memo = remember('山田太郎', { seed: SEED, name: true });

test('review: 後から覚えた名前は、前のページの写し・見出し・事象の文字にも当たる（弱点 #6）', () => {
  const st = run([
    { type: 'hello', tab: 1, host: 'm.test', t: 1000, since: 1000 },
    page1,
    { type: 'ev', tab: 1, host: 'm.test', t: 1020, k: 'click', ...box, s: '山田太郎さんへ送る' },
    { type: 'page', tab: 1, host: 'm.test', t: 2000, vw: 800, vh: 600, dh: 800, items: [{ k: 'field', ...box, s: 'お名前' }] },
    { type: 'ev', tab: 1, host: 'm.test', t: 2010, k: 'input', ...box, n: 4, s: 'お名前', memo },
  ]);
  const S = st.sessions[1];
  const json = JSON.stringify(st);
  assert.ok(!/山田|太郎/.test(json), json);
  assert.equal(S.pages[0].items[0].s, '■■■■さんのページ');
  assert.equal(S.pages[0].evs[0].s, '■■■■さんへ送る');
  // 写しの形は壊さない: style の中（> や " を含む）・資源の URL・実体参照・属性の中の > は元のまま、文字と見える属性だけ伏せる
  assert.equal(S.pages[0].dom, dom1.replace(/山田太郎/g, '■■■■'));
});
