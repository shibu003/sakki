// 迷いの検出と、一番の迷いへの寄り・1 倍・渦（PBI-0003 AC-1〜6・AC-X1〜X3）
import test from 'node:test';
import assert from 'node:assert/strict';
import { worstSpot, detectLost, STALL_CAP } from '../src/lost.js';
import { timeline, frame, swirlRadius, GHOST, FILLED, SWIRL } from '../src/replay.js';
import { reduce, initialState, takeReply } from '../src/session.js';

// 題材の記録: booking.test の 1 ページ。見出し 3 段・欄 2 つ・ボタン
const H1 = { k: 'heading', x: 24, y: 20, w: 600, h: 30, s: '宿の予約' };
const GUEST = { k: 'heading', x: 24, y: 80, w: 600, h: 26, s: 'お客様情報' };
const NAME = { x: 24, y: 120, w: 300, h: 32 };
const DATES = { k: 'heading', x: 24, y: 200, w: 600, h: 26, s: '宿泊日の選択' };
const DAY = { x: 24, y: 240, w: 300, h: 32 };
const BTN = { x: 24, y: 320, w: 120, h: 40 };
const ITEMS = [H1, GUEST, { k: 'field', ...NAME, s: 'お名前' }, DATES, { k: 'field', ...DAY, s: '泊まる日' }, { k: 'button', ...BTN, s: '予約する', sub: 1 }];
const pageOf = (evs, extra = {}) => ({ tab: 1, host: 'booking.test', site: 'booking.test', t: evs[0]?.t ?? 0, vw: 800, vh: 600, dh: 1200, items: ITEMS, evs, ...extra });
const one = (evs) => ({ pages: [pageOf(evs)] });
const focus = (t, box = NAME, s = 'お名前', extra = {}) => ({ t, k: 'focus', ...box, s, ...extra });
const pick = (t, box = DAY, s = '泊まる日') => ({ t, k: 'input', ...box, n: 1, p: 1, s });
const typed = (t, box = NAME, s = 'お名前') => ({ t, k: 'input', ...box, n: 3, s });
const click = (t, box = BTN, s = '予約する') => ({ t, k: 'click', ...box, s });
const view = { w: 400, h: 500 };
const frames = (S, step = 50) => {
  const tl = timeline(S);
  const out = [];
  for (let t = 0; t <= tl.total; t += step) out.push({ t, f: frame(S, t, view, tl) });
  return out;
};
const inside = (p, b) => p.x >= b.x - 1 && p.x <= b.x + b.w + 1 && p.y >= b.y - 1 && p.y <= b.y + b.h + 1;
const headingIn = (f, s) => f.items.find((it) => it.k === 'heading' && it.s === s);

// 日付を 3 回選び直した（p:1 の input が 4 回。focus は 1 回）
const picked3 = [focus(0), typed(2000), focus(12000, DAY, '泊まる日'), pick(13000), pick(14000), pick(15000), pick(16000), click(17000)];

test('lost: 選び直し 3 回は宿泊日の選択の 1 か所（AC-1 ①③）', () => {
  const spot = worstSpot(one(picked3));
  assert.equal(spot.key, '宿泊日の選択');
  assert.deepEqual(spot.marks, ['repick', 'repick', 'repick']);
  assert.equal(spot.loss, 3000);
  // p が無い = 文字を打った（0.8 秒の切れ目で割れただけ）は選び直しではない
  const typedOnly = picked3.map(({ p, ...e }) => e);
  assert.equal(worstSpot(one(typedOnly)), null);
});

test('replay: 渦は 1 つで、宿泊日の選択の見出しの上（AC-1 ②）', () => {
  const S = one(picked3);
  const withSwirl = frames(S).filter(({ f }) => f.swirl);
  assert.ok(withSwirl.length > 10, `渦を持つ frame ${withSwirl.length}`);
  for (const { t, f } of withSwirl) {
    const h = headingIn(f, '宿泊日の選択');
    assert.ok(h && inside(f.swirl, h), `t=${t}: 渦 (${f.swirl.x},${f.swirl.y}) が宿泊日の選択の箱の中`);
    for (const other of ['宿の予約', 'お客様情報']) {
      const o = headingIn(f, other);
      assert.ok(!o || !inside(f.swirl, o), `t=${t}: 渦が ${other} の上に居る`);
    }
  }
});

test('replay: 渦は 1 か所のページを映している間だけ（AC-1 ②）', () => {
  const S = { pages: [pageOf(picked3), pageOf([click(19000, { x: 24, y: 100, w: 120, h: 40 }, '戻る')], { t: 19000, items: [{ ...H1, s: '予約の確認' }, { k: 'button', x: 24, y: 100, w: 120, h: 40, s: '戻る' }] })] };
  const fs = frames(S);
  const onConfirm = fs.filter(({ f }) => headingIn(f, '予約の確認'));
  assert.ok(onConfirm.length > 5);
  for (const { t, f } of onConfirm) assert.equal(f.swirl, null, `t=${t}: 別のページに渦`);
  assert.ok(fs.some(({ f }) => f.swirl && headingIn(f, '宿泊日の選択')));
});

test('lost: 迷い 0 回は何も出さない（AC-2）', () => {
  const S = one([focus(0), typed(2000), focus(5000, DAY, '泊まる日'), pick(6000), click(8000)]);
  assert.equal(worstSpot(S), null);
  const tl = timeline(S);
  assert.equal(tl.win, null);
  for (let i = 1; i < tl.steps.length; i++) assert.ok(tl.steps[i].rt - tl.steps[i - 1].rt <= 500);
  const fs = frames(S);
  assert.equal(fs.filter(({ f }) => f.swirl).length, 0);
  assert.equal(fs.filter(({ f }) => f.mode === 'worst_spot').length, 0);
  for (const { f } of fs) assert.equal(headingIn(f, '宿の予約').w, 300); // 倍率は常に 1（800 → 400 の 0.5 倍）
});

test('lost: 作り直された欄も名前と横の位置で同じ欄（AC-3）', () => {
  const moved = { ...NAME, y: 160 }; // 上に案内が差し込まれて 40px ずれた、作り直された欄
  const spot = worstSpot(one([focus(0), typed(2000), focus(5000, DAY, '泊まる日'), pick(6000), focus(9000, moved)]));
  assert.deepEqual([spot.key, spot.marks, spot.loss], ['お客様情報', ['refocus'], 7000]);
  // 同じ名前でも別の列（x が 300px 違う）は別の欄
  assert.equal(worstSpot(one([focus(0), typed(2000), focus(5000, DAY, '泊まる日'), focus(9000, { ...NAME, x: 324 })])), null);
  // 間に別の欄の focus が無い = 窓を切り替えて戻っただけ（AC-X1 ②）
  assert.equal(worstSpot(one([focus(0), typed(2000), focus(9000)])), null);
});

test('lost: 同じ見出しへ戻る — 戻るボタン・login の繰り返し・撮り直し（AC-4）', () => {
  const pg = (s, evs, extra = {}) => pageOf(evs, { items: [{ ...H1, s }], ...extra });
  // (a) 戻るボタン: 宿の予約 → 予約の確認 → 宿の予約
  const a = worstSpot({ pages: [pg('宿の予約', [focus(0), click(3000)]), pg('予約の確認', [click(5000)]), pg('宿の予約', [click(9000)])] });
  assert.deepEqual([a.key, a.marks, a.loss], ['宿の予約', ['revisit'], 6000]);
  // (b) login（よその箱）を挟んだ戻り: 1 回目は普通の流れ、2 回目（セッションが切れてまた戻った）から数える
  const away = (t, t1) => ({ away: true, tab: 1, host: 'auth.test', t, t1 });
  const once = { pages: [pg('宿の予約', [focus(0), click(3000)]), away(4000, 20000), pg('宿の予約', [click(21000)])] };
  assert.equal(worstSpot(once), null);
  const twice = { pages: [...once.pages, away(22000, 40000), pg('宿の予約', [click(41000)])] };
  assert.deepEqual([worstSpot(twice).marks, worstSpot(twice).loss], [['revisit'], 41000 - 21000]);
  // (c) 同じ見出しのまま撮り直しただけ
  assert.equal(worstSpot({ pages: [pg('宿の予約', [focus(0)]), pg('宿の予約', [click(5000)])] }), null);
  // 別のタブの別の見出しは、このタブの「間」にならない
  const tabs = { pages: [pg('宿の予約', [focus(0)]), pg('ヘルプ', [click(2000)], { tab: 2 }), pg('宿の予約', [click(4000)])] };
  assert.equal(worstSpot(tabs), null);
});

test('lost: 止まっていた時間（AC-5）', () => {
  const gap = (ms, extra = {}) => one([focus(0), typed(2000), focus(2000 + ms, DAY, '泊まる日', extra)]);
  assert.equal(worstSpot(gap(30000)), null); // (a) 30 秒ちょうどは読んでいるだけ
  assert.deepEqual([worstSpot(gap(31000)).marks, worstSpot(gap(31000)).loss, worstSpot(gap(31000)).key], [['stall'], 1000, '宿泊日の選択']); // (b)
  assert.equal(worstSpot(gap(600000)).loss, STALL_CAP); // (c) 3 分で打ち切り
  assert.equal(worstSpot(gap(600000, { vis: 2000 + 590000 })), null); // (d) 見えていたのは 10 秒だけ
  // (e) よそのサイトの箱を挟んだ 2 分
  const e = { pages: [pageOf([focus(0), typed(2000)]), { away: true, tab: 1, host: 'auth.test', t: 3000, t1: 100000 }, pageOf([focus(122000, DAY, '泊まる日')], { items: [{ ...H1, s: '予約の確認' }, { k: 'field', ...DAY, s: '泊まる日' }] })] };
  assert.equal(worstSpot(e), null);
  // (f) 同じ束の子タブ（ヘルプ）に事象があれば間が切れる。無ければ 2 分の停止
  const help = pageOf([click(30000), click(55000), click(80000), click(105000)].map((x) => ({ ...x, s: undefined })), { tab: 2, items: [{ ...H1, s: 'ヘルプ' }] });
  const main = [focus(0), typed(2000), focus(122000, DAY, '泊まる日')];
  assert.equal(worstSpot({ pages: [pageOf(main), help] }), null);
  assert.deepEqual(worstSpot(one(main)).marks, ['stall']);
});

test('replay: 一番の迷いへ寄って 1 倍に落とし、渦を 1 つ残す（AC-6）', () => {
  // お客様情報で 4 秒（refocus）、宿泊日の選択で 40 秒（repick と stall）
  const moved = { ...NAME, y: 160 };
  const S = { pages: [pageOf([focus(0), typed(1000), focus(3000, DAY, '泊まる日'), focus(5000, moved), typed(6000, moved), pick(8000), pick(48000), click(50000)], { items: [...ITEMS, { k: 'field', ...moved, s: 'お名前' }] })] };
  const lost = detectLost(S);
  assert.deepEqual(lost.map((m) => [m.kind, m.key]), [['refocus', 'お客様情報'], ['repick', '宿泊日の選択'], ['stall', '宿泊日の選択']]);
  const tl = timeline(S);
  assert.deepEqual([tl.spot.key, tl.spot.loss, tl.spot.t0, tl.spot.t1], ['宿泊日の選択', 40000, 8000, 48000]);
  // ② 窓の中へ向かう間は 1 倍（1.5 秒まで）、窓の外は 0.5 秒以下（窓の最後の後だけ 0.7 秒止める）
  const { steps } = tl;
  for (let i = 1; i < steps.length; i++) {
    const d = steps[i].rt - steps[i - 1].rt;
    const gap = steps[i].t - steps[i - 1].t;
    if (steps[i].t >= 8000 && steps[i].t <= 48000) assert.equal(d, Math.max(150, Math.min(gap, 1500)), `t=${steps[i].t}`);
    else if (steps[i - 1].t === 48000) assert.equal(d, Math.max(150, Math.min(gap, 2000) / 4) + 700);
    else assert.ok(d <= 500, `t=${steps[i].t}: ${d}`);
  }
  // ③ 窓の中は worst_spot で 1.6 倍に寄る。① 渦は宿泊日の選択の 1 つだけ
  const fs = frames(S);
  const inWin = fs.filter(({ t }) => t >= tl.win.rs && t <= tl.win.re);
  assert.ok(inWin.length > 20);
  for (const { t, f } of inWin) {
    assert.equal(f.mode, 'worst_spot', `t=${t}`);
    assert.ok(Math.abs(headingIn(f, '宿泊日の選択').w - 300 * 1.6) <= 1, `t=${t}: 幅 ${headingIn(f, '宿泊日の選択').w}`);
  }
  for (const { t, f } of fs.filter(({ t }) => t < tl.win.rs - 400 || t > tl.win.re + 400)) {
    assert.equal(f.mode, 'replay_fast', `t=${t}`);
    const h = f.items.find((it) => it.k === 'heading');
    if (h) assert.equal(h.w, 300, `t=${t}: 窓の外は寄らない`);
  }
  for (const { t, f } of fs.filter(({ f }) => f.swirl)) assert.ok(inside(f.swirl, headingIn(f, '宿泊日の選択')), `t=${t}`);
  assert.equal(fs.filter(({ f }) => f.swirl && headingIn(f, 'お客様情報') && inside(f.swirl, headingIn(f, 'お客様情報'))).length, 0);
  // ④ 寄っている間も、各事象の時刻でゴーストは事象の箱の中心
  for (const s of steps) {
    const f = frame(S, s.rt, view, tl);
    const z = f.items.find((it) => it.k !== 'heading' && Math.abs(it.x + it.w / 2 - f.ghost.x) <= 1 && Math.abs(it.y + it.h / 2 - f.ghost.y) <= 1);
    assert.ok(z, `t=${s.t}: ゴースト (${f.ghost.x},${f.ghost.y}) が事象の箱の中心に無い`);
    const scale = (400 / 800) * (s.rt >= tl.win.rs && s.rt <= tl.win.re ? 1.6 : 1);
    if (s.rt >= tl.win.rs && s.rt <= tl.win.re) assert.ok(Math.abs(z.w - s.ev.w * scale) <= 1, `t=${s.t}: 寄った箱の幅`);
  }
  // ④ 右の方の欄でも、寄っている間は横にも追い、ゴーストは箱の中心・渦は見出しの箱の中
  const R = (b) => ({ ...b, x: b.x + 456 });
  const right = { pages: [pageOf([focus(0, R(NAME)), focus(3000, R(DAY), '泊まる日'), pick(4000, R(DAY)), pick(9000, R(DAY)), click(10000, R(BTN))], { items: ITEMS.map(R) })] };
  const rtl = timeline(right);
  for (const s of rtl.steps) {
    const f = frame(right, s.rt, view, rtl);
    const scale = headingIn(f, '宿泊日の選択').w / 600;
    const box = f.items.find((it) => it.k !== 'heading' && Math.abs(it.w - s.ev.w * scale) <= 1 && Math.abs(it.y + it.h / 2 - f.ghost.y) <= 1);
    assert.ok(box && Math.abs(box.x + box.w / 2 - f.ghost.x) <= 1, `t=${s.t}: 横に寄った時のゴースト ${f.ghost.x} と箱`);
    if (f.swirl) assert.ok(inside(f.swirl, headingIn(f, '宿泊日の選択')), `t=${s.t}: 横に寄った時の渦`);
  }
  const mid = frame(right, (rtl.win.rs + rtl.win.re) / 2, view, rtl);
  assert.ok(headingIn(mid, '宿泊日の選択').x < 480 * 0.8 - 1, `横にも寄っている（camX > 0）: x=${headingIn(mid, '宿泊日の選択').x}`);
  // ⑤ 渦の大きさ = 損した時間（5 秒 < 60 秒、どちらも 12〜48px）。窓を抜けた後は育ち切った大きさで残る
  const rMax = (S2) => Math.max(...frames(S2).filter(({ f }) => f.swirl).map(({ f }) => f.swirl.r));
  const r5 = rMax(one([focus(0), pick(8000), pick(13000), click(14000)]));
  const r60 = rMax(one([focus(0), pick(8000), pick(68000), click(69000)]));
  assert.ok(r5 < r60, `${r5} < ${r60}`);
  for (const r of [r5, r60]) assert.ok(r >= SWIRL.min && r <= SWIRL.max);
  assert.equal(r5, swirlRadius(5000));
  const after = frame(S, tl.win.re + 100, view, tl);
  assert.equal(after.swirl.r, swirlRadius(40000));
});

test('lost: 社内の束（文字の無い記録）でも位置で数え、文字を出さない（AC-X1 ①）', () => {
  const strip = (x) => { const { s, ...rest } = x; return rest; };
  const S = { pages: [pageOf(picked3.map(strip), { items: ITEMS.map(strip) })] };
  const spot = worstSpot(S);
  assert.deepEqual(spot.marks, ['repick', 'repick', 'repick']);
  assert.deepEqual(spot.box, { x: DATES.x, y: DATES.y, w: DATES.w, h: DATES.h }); // 位置で「上で一番近い見出し」
  const fs = frames(S);
  assert.ok(fs.some(({ f }) => f.swirl));
  for (const { f } of fs) {
    const texts = [...f.items.flatMap((it) => [it.s, it.v]), f.card?.text].filter(Boolean);
    for (const s of texts) assert.equal(s, FILLED);
    if (f.ghost) assert.equal(f.ghost.label, GHOST.label);
  }
  // 文字の無い見出しは区別できないので戻りは数えない
  const pg = (evs) => pageOf(evs, { items: [strip(H1)] });
  assert.equal(worstSpot({ pages: [pg([focus(0)].map(strip)), pg([click(3000)].map(strip)), pg([click(6000)].map(strip))] }), null);
});

test('lost: 欠けた記録でも落ちない（AC-X2）', () => {
  const finite = (f) => {
    for (const o of [...f.items, f.ghost, f.swirl].filter(Boolean)) {
      for (const [k, v] of Object.entries(o)) if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k}=${v}`);
    }
  };
  // ① s・p・vis の無い古い形: 位置で同じ欄（同じページ）と見なす
  const old = one([focus(0), typed(2000), focus(4000, DAY), focus(7000)].map(({ s, ...e }) => e));
  assert.deepEqual(worstSpot(old).marks, ['refocus']);
  // ② 見出しの無いページ: 渦は事象の箱の中心
  const bare = { pages: [pageOf(picked3, { items: ITEMS.filter((it) => it.k !== 'heading') })] };
  const spot = worstSpot(bare);
  assert.deepEqual(spot.box, DAY);
  for (const { f } of frames(bare)) {
    finite(f);
    if (f.swirl) {
      const day = f.items.find((it) => it.k === 'field' && it.s === '泊まる日');
      assert.ok(Math.abs(f.swirl.x - (day.x + day.w / 2)) <= 1 && Math.abs(f.swirl.y - (day.y + day.h / 2)) <= 1);
    }
  }
  // ③ 上限で古いページが捨てられた（最初の選択が消えた）: 残った事象だけで数える
  const cut = { pages: [pageOf([pick(15000), pick(16000), click(17000)])] };
  assert.deepEqual(worstSpot(cut).marks, ['repick']);
  for (const { f } of frames(cut)) finite(f);
  // ④ 事象 0 件・事象の無いページ（完了の画面だけ）
  assert.equal(worstSpot({ pages: [] }), null);
  assert.equal(worstSpot({}), null);
  const empty = frame({ pages: [] }, 0, view);
  assert.deepEqual([empty.items, empty.ghost, empty.swirl, empty.total], [[], null, null, 0]);
  const noEvs = { pages: [pageOf(picked3), pageOf([], { items: [{ ...H1, s: '完了' }] })] };
  for (const { f } of frames(noEvs)) finite(f);
  assert.equal(worstSpot(noEvs).key, '宿泊日の選択');
});

test('lost: 2 つの束は混ざらない — reducer を通した記録で（AC-X3）', () => {
  let st = initialState();
  const put = (m) => { st = takeReply(reduce(st, { seed: 7, ...m }))[0]; };
  put({ type: 'hello', tab: 1, host: 'booking.test', t: 0 });
  put({ type: 'hello', tab: 2, host: 'clinic.test', t: 1 });
  put({ type: 'page', tab: 1, host: 'booking.test', t: 10, vw: 800, vh: 600, dh: 1200, items: ITEMS });
  put({ type: 'page', tab: 2, host: 'clinic.test', t: 11, vw: 800, vh: 600, dh: 1200, items: [{ ...H1, s: '診療の予約' }, { k: 'field', ...DAY, s: '診療科' }] });
  for (let i = 0; i < 4; i++) {
    put({ type: 'ev', tab: 1, host: 'booking.test', t: 1000 + i * 1000, k: 'input', ...DAY, n: 1, p: 1, s: '泊まる日' });
    put({ type: 'ev', tab: 2, host: 'clinic.test', t: 1500 + i * 1000, k: i ? 'click' : 'input', ...DAY, n: 1, p: i ? undefined : 1 });
  }
  assert.deepEqual(worstSpot(st.sessions[1]).marks, ['repick', 'repick', 'repick']);
  assert.equal(worstSpot(st.sessions[1]).key, '宿泊日の選択');
  assert.equal(worstSpot(st.sessions[2]), null);
});
