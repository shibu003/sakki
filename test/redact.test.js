// 伏せる規則 1 本（AC-1 ③・AC-3 ②）
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/redact.js';

const { mask, remember } = globalThis.sakki;
const seed = 42;
const memoOf = (...vals) => new Set(vals.flatMap(([v, name]) => remember(v, { seed, name })));

test('redact: 覚えた値と数字を伏せる（AC-1 ③）', () => {
  const memo = memoOf(['山田', true]);
  assert.equal(mask('山田 様の予約内容（10月15日）', memo, seed), '■■ 様の予約内容（■■月■■日）');
});

test('redact: header の名前は 3 文字の一致で見出しから消える（AC-3 ②）', () => {
  const memo = memoOf(['山田太郎 ▼', false]);
  assert.equal(mask('山田太郎さんのマイページ', memo, seed), '■■■■さんのマイページ');
});

test('redact: メール・数字の形は集まりが空でも伏せる（AC-3 ②）', () => {
  assert.equal(mask('メール（taro@example.com）', new Set(), seed), `メール（${'■'.repeat(16)}）`);
  assert.equal(mask('3 件を申し込む', new Set(), seed), '■ 件を申し込む');
  assert.equal(mask('残高 123,456 円', new Set(), seed), '残高 ■■■■■■■ 円');
  assert.equal(mask('１２３４', new Set(), seed), '■■■■');
});

test('redact: 漢数字・和暦は伏せ、数でない漢字は残す', () => {
  assert.equal(mask('令和八年九月二十七日', new Set(), seed), '令和■年■月■■■日');
  assert.equal(mask('令和元年', new Set(), seed), '令和■年');
  assert.equal(mask('一覧へ戻る', new Set(), seed), '一覧へ戻る');
});

test('redact: 揃えてから照合する（カタカナとひらがな・全角と半角）', () => {
  assert.equal(mask('やまださま', memoOf(['ヤマダ', true]), seed), '■■■さま');
  assert.equal(mask('ＴＡＲＯ様', memoOf(['taro', true]), seed), '■■■■様');
});

test('redact: 名前でない値は 3 文字以上の一致か、まるごと一致だけ', () => {
  const memo = memoOf(['東京都港区', false], ['内科', false]);
  assert.equal(mask('港区の東京都庁', memo, seed), '港区の■■■庁');
  assert.equal(mask('内科', memo, seed), '■■');
  assert.equal(mask('内科の予約', memo, seed), '内科の予約');
});

test('redact: 集まりには平文が入らない', () => {
  const memo = [...memoOf(['山田', true], ['東京都港区', false])];
  assert.ok(memo.length > 0);
  assert.ok(!JSON.stringify(memo).includes('山田') && !JSON.stringify(memo).includes('東京'));
  // seed が違えば同じ値でも別の hash（束をまたいで照合できない）
  assert.notDeepEqual(remember('山田', { seed: 1, name: true }), remember('山田', { seed: 2, name: true }));
});
