// 実機の検査: Chrome for Testing に未 pack の拡張を読ませ、題材のページを実際に操作して storage.session と canvas を見る。
// 要る物: `npm install`（playwright-core）と、その版の chromium（`npx playwright-core install chromium`）。
// branded Google Chrome 137+ は --load-extension を無視するので、Chrome for Testing（channel: 'chromium'）で動かす。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { worstSpot, detectLost } from '../src/lost.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'e2e', 'fixtures');

let server, port, ctx, sw, extId;
const url = (host, file) => `http://${host}.test:${port}/${file}`;
const readState = () => sw.evaluate(() => chrome.storage.session.get('state').then((r) => r.state || { sessions: {}, root: {} }));
async function waitFor(fn, what, ms = 8000) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`時間内に成り立たなかった: ${what}`);
}
const sessionsOf = (st) => Object.values(st.sessions);
const findSession = (st, host) => sessionsOf(st).find((S) => S.pages.some((p) => p.host === host && !p.away));
const latestSession = (st, host) => sessionsOf(st).filter((S) => S.pages.some((p) => p.host === host && !p.away)).sort((a, b) => b.t1 - a.t1)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// state の中の「文字」（見出し・欄の名前・ボタン名・ホスト名）を全部集める。memo は hash なので見ない
const textsOf = (S) => S.pages.flatMap((p) => [p.host, ...(p.items || []).map((i) => i.s), ...(p.evs || []).map((e) => e.s)]).filter(Boolean);

test.before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(FIX, new URL(req.url, 'http://x').pathname);
    if (!f.startsWith(FIX) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f, 'utf8').replaceAll('PORT', String(port)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'sakki-e2e-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--host-resolver-rules=MAP *.test 127.0.0.1'],
  });
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;
  await sw.evaluate(() => { globalThis.__n = 0; chrome.runtime.onMessage.addListener(() => { globalThis.__n++; }); });
});
test.after(async () => {
  await ctx?.close();
  server?.close();
});

const onboarding = () => ctx.pages().find((p) => p.url().includes('/onboarding.html'));

test('e2e: 入れた直後 — 偽の手続きが 1 枚開き、同意の欄は外れていて、入口は side panel（AC-6 ①②④）', async () => {
  await waitFor(() => onboarding(), '偽の手続きのタブが開く');
  assert.equal(ctx.pages().filter((p) => p.url().includes('/onboarding.html')).length, 1);
  const ob = onboarding();
  await ob.waitForLoadState();
  assert.equal(await ob.isChecked('#consent'), false);
  assert.equal(sessionsOf(await readState()).length, 0);
  const behavior = await sw.evaluate(() => chrome.sidePanel.getPanelBehavior());
  assert.equal(behavior.openPanelOnActionClick, true);
  const mf = await sw.evaluate(() => chrome.runtime.getManifest());
  assert.equal(mf.action.default_popup, undefined);
  assert.deepEqual(mf.permissions, ['sidePanel', 'storage', 'scripting', 'contextMenus']);
  assert.deepEqual(mf.host_permissions, ['<all_urls>']);
});

test('e2e: 同意の前は何も送らない（AC-X1 ①）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('booking', 'booking.html'));
  await p.click('#name');
  await p.keyboard.type('山田');
  await p.selectOption('#day', '10月14日');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await sw.evaluate(() => globalThis.__n), 0);
  assert.equal(sessionsOf(await readState()).length, 0);
  await p.close();
});

test('e2e: 同意の欄を押した後の偽の手続きが記録に入り、完了で閉じる（AC-6 ③）', async () => {
  const ob = onboarding();
  await ob.check('#consent');
  await waitFor(() => sw.evaluate(() => chrome.storage.local.get('consentedAt').then((r) => !!r.consentedAt)), 'consentedAt が入る');
  await ob.click('#start');
  await ob.click('#name');
  await ob.keyboard.type('テスト');
  await ob.selectOption('#day', { index: 1 });
  await new Promise((r) => setTimeout(r, 900));
  await ob.selectOption('#day', { index: 3 });
  await ob.click('button[type=submit]');
  const S = await waitFor(async () => { const st = await readState(); return sessionsOf(st).find((x) => x.phase === 'closed'); }, '偽の手続きの束が closed');
  assert.equal(S.home, 'sakki');
  const heads = S.pages.flatMap((p) => p.items.filter((i) => i.k === 'heading').map((i) => i.s));
  assert.ok(heads.includes('宿の予約（ためし）') && heads.includes('予約が完了しました（ためし）'), heads.join(' / '));
  assert.ok(!JSON.stringify(S).includes('テスト'));
  assert.ok(S.pages.flatMap((p) => p.evs).some((e) => e.k === 'click'));
});

let booking;
test('e2e: 値を取らない — 名前も選んだ日も記録に残らない（AC-1）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('booking', 'booking.html'));
  await p.click('#name');
  await p.keyboard.type('山田');
  for (const d of ['10月14日', '10月16日', '10月15日']) {
    await p.click('#day'); // 人と同じく、select を押してから選ぶ
    await p.selectOption('#day', d);
    await new Promise((r) => setTimeout(r, 900)); // 選び直しを 1 回ずつ送らせる（0.8 秒でまとめを切る）
  }
  await Promise.all([p.waitForURL(/confirm/), p.click('button[type=submit]')]);
  await p.click('#back');
  booking = await waitFor(async () => {
    const S = findSession(await readState(), 'booking.test');
    return S && S.pages.length >= 2 && S.pages[1].evs.length ? S : null;
  }, 'booking.test の束に 2 ページ目の事象が入る');
  const json = JSON.stringify(booking);
  assert.ok(!json.includes('山田') && !json.includes('10月15日') && !json.includes('10月14日'), 'state に値が無い');
  for (const s of textsOf(booking)) assert.ok(!/\d/.test(s), `骨組みの文字に数字: ${s}`);
  const h = booking.pages[1].items.find((i) => i.k === 'heading');
  assert.equal(h.s, '■■ 様の予約内容（■■月■■日）');
  assert.equal(booking.phase, 'homed');
  const kinds = booking.pages[0].evs.map((e) => e.k).join(',');
  // 欄を押す = focus と click。select は押すたびに click、選ぶたびに input（0.8 秒あけたので 1 回ずつ）
  assert.equal(kinds, 'focus,click,input,focus,click,input,click,input,click,input,click');
});

test('e2e: side panel が記録を早送りで描き、最後の位置にゴーストが居る（AC-2 ③・AC-1 ②）', async () => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  await p.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 20000 });
  const r = await p.evaluate(async () => {
    const { frame, timeline } = await import('./src/replay.js');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { session } = await chrome.runtime.sendMessage({ type: 'get', tab: tab.id });
    const c = document.getElementById('c');
    const tl = timeline(session);
    const f = frame(session, tl.total, { w: c.clientWidth, h: c.clientHeight }, tl);
    const dpr = devicePixelRatio;
    const px = c.getContext('2d').getImageData(Math.round(f.ghost.x * dpr), Math.round(f.ghost.y * dpr), 1, 1).data;
    const bg = c.getContext('2d').getImageData(2, Math.round(c.height - 2), 1, 1).data;
    const filled = frame(session, tl.steps[3].rt, { w: c.clientWidth, h: c.clientHeight }, tl).items.filter((i) => i.v === '●●●').length;
    return { px: [...px], bg: [...bg], mode: document.body.dataset.mode, host: session.home, filled };
  });
  assert.equal(r.host, 'booking.test');
  assert.ok(r.px[2] > r.px[0] + 40 && r.px[2] > r.px[1] + 40, `ゴーストの位置の画素が青紫: ${r.px}`);
  assert.ok(!(r.bg[2] > r.bg[0] + 40), `背景は青紫でない: ${r.bg}`);
  assert.ok(r.filled >= 1, '入力のあった欄に ●●●');
  await p.close();
});

test('e2e: login の内側 — 本文を取らず、残す文字も伏せ、画像と枠は灰色の箱（AC-3）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('mypage', 'mypage.html'));
  await p.click('#mail');
  const S = await waitFor(async () => findSession(await readState(), 'mypage.test'), 'mypage.test の束');
  const json = JSON.stringify(S);
  for (const w of ['残高', '123', 'AB-1234', 'taro', 'example.com', '山田', '太郎', 'カード番号', '4242']) assert.ok(!json.includes(w), `記録に「${w}」`);
  const items = S.pages[0].items;
  const bySel = async (sel) => p.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  assert.deepEqual(items.filter((i) => i.k === 'heading').map((i) => i.s), ['■■■■さんのマイページ', '予約の確認']);
  assert.equal(items.find((i) => i.k === 'field').s, `メール（${'■'.repeat(16)}）`);
  assert.equal(items.find((i) => i.k === 'button' && i.s?.includes('申し込む')).s, '■ 件を申し込む');
  const bands = items.filter((i) => i.k === 'band');
  assert.equal(bands.length, 1);
  assert.equal(bands[0].s, undefined);
  const media = items.filter((i) => i.k === 'media');
  const face = await bySel('#face'), frame = await bySel('#ext');
  assert.equal(media.length, 2);
  for (const [m, want] of [[media[0], face], [media[1], frame]]) {
    assert.ok(Math.abs(m.w - want.w) <= 1 && Math.abs(m.h - want.h) <= 1, `箱の大きさ ${m.w}x${m.h} vs ${want.w}x${want.h}`);
    assert.equal(m.s, undefined);
  }
  await p.close();
});

test('e2e: 閉じた shadow DOM の中の欄も骨組みに出て、事象がその箱を指す（AC-7）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('shadow', 'shadow.html'));
  const host = await p.$eval('#host', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await p.mouse.click(host.x + 20, host.y + host.h - 15); // 中の input（下 40px）
  await p.keyboard.type('150');
  const S = await waitFor(async () => {
    const x = findSession(await readState(), 'shadow.test');
    return x && x.pages[0].evs.some((e) => e.k === 'input') ? x : null;
  }, 'shadow.test の input が届く', 6000);
  const field = S.pages[0].items.find((i) => i.k === 'field');
  assert.ok(field, '閉じた shadow root の中の欄が骨組みに在る');
  assert.equal(field.s, '郵便番号');
  for (const e of S.pages[0].evs.filter((x) => x.k !== 'click')) {
    assert.deepEqual([e.x, e.y, e.w, e.h], [field.x, field.y, field.w, field.h], `${e.k} の箱`);
  }
  assert.ok(S.pages[0].evs.some((e) => e.k === 'focus'));
  await p.close();
});

test('e2e: label の中の select の選択肢と textarea の文字を名前に混ぜない（PBI-0006）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('clinic', 'clinic.html'));
  await p.selectOption('#dept', '精神科');
  await p.click('#memo');
  const S = await waitFor(async () => findSession(await readState(), 'clinic.test'), 'clinic.test の束');
  const names = S.pages[0].items.filter((i) => i.k === 'field').map((i) => i.s);
  assert.deepEqual(names, ['診療科', 'ご相談', '時間帯']);
  const json = JSON.stringify(S);
  for (const w of ['内科', '精神科', 'はじめの文', '午前', '午後']) assert.ok(!json.includes(w), `記録に「${w}」`);
  await p.close();
});

test('e2e: 実機の選び直しで渦が立つ — booking と偽の手続き（PBI-0003 AC-7 a b）', async () => {
  const evs = booking.pages[0].evs;
  assert.equal(evs.filter((e) => e.k === 'input' && e.p === 1).length, 3, 'select の選び直し 3 回に p:1');
  assert.equal(evs.filter((e) => e.k === 'input' && !e.p).length, 1, '文字の欄の input には p が無い');
  assert.deepEqual(evs.filter((e) => e.k === 'focus').map((e) => e.s), ['お名前', '泊まる日']);
  const spot = worstSpot(booking);
  assert.equal(spot?.key, '宿の予約');
  assert.deepEqual(spot.marks, ['repick', 'repick']);
  const ob = sessionsOf(await readState()).find((S) => S.home === 'sakki');
  assert.ok(ob, '偽の手続きの束が残っている');
  assert.equal(worstSpot(ob)?.key, '宿の予約（ためし）', '偽の手続きは必ず渦が立つ');
});

let back;
test('e2e: 戻るボタンで戻ると骨組みを取り直して戻りを数え、見えるようになった時刻が事象に付く（PBI-0003 AC-4・AC-5 d）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('booking', 'booking.html'));
  await p.evaluate(() => addEventListener('pageshow', (e) => { window.__ps = e.persisted; })); // bfcache から戻ると残る
  await p.click('#name');
  await p.keyboard.type('佐藤');
  for (const d of ['10月14日', '10月16日']) {
    await p.click('#day');
    await p.selectOption('#day', d);
    await sleep(900);
  }
  await Promise.all([p.waitForURL(/confirm/), p.click('button[type=submit]')]);
  await p.click('#back');
  await p.goBack();
  await p.waitForURL(/booking\.html/);
  const fromCache = await p.evaluate(() => window.__ps === true);
  const visible = await p.evaluate(() => document.visibilityState);
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 隠れた後に見えるようになった、を起こす
  await p.click('#name');
  back = await waitFor(async () => {
    const S = latestSession(await readState(), 'booking.test');
    return S && S.pages.filter((x) => !x.away).length >= 3 && S.pages.at(-1).evs.length ? S : null;
  }, 'booking.test の束に戻った後のページと事象が入る');
  const heads = back.pages.map((x) => x.items.find((i) => i.k === 'heading')?.s);
  assert.equal(heads.length, 3, heads.join(' / '));
  assert.deepEqual([heads[0], heads[2]], ['宿の予約', '宿の予約']);
  assert.notEqual(heads[1], '宿の予約');
  assert.deepEqual(back.pages[1].evs.map((e) => e.k), ['click'], '戻った後の事象は確認のページに付かない');
  assert.ok(detectLost(back).some((m) => m.kind === 'revisit' && m.key === '宿の予約'), '戻りの印');
  const first = back.pages[2].evs[0];
  if (visible === 'visible') assert.ok(first.vis > 0 && first.vis <= first.t, `vis=${first.vis} t=${first.t}`);
  else assert.fail(`headless のページが ${visible}（visibilitychange の口を測れない）`);
  console.log(`# 戻るボタン: bfcache から戻った = ${fromCache}（false なら読み込み直し。pageshow の口はこの run では踏んでいない）`);
  await p.close();
});

test('e2e: side panel が一番の迷いで 1 倍に落とし、見出しの上に赤い渦を描く（PBI-0003 AC-7 c）', async () => {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  await p.waitForFunction(() => document.body.dataset.mode === 'worst_spot', null, { timeout: 20000, polling: 'raf' });
  await p.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 30000 });
  const r = await p.evaluate(async () => {
    const { frame, timeline, paint } = await import('./src/replay.js');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { session } = await chrome.runtime.sendMessage({ type: 'get', tab: tab.id });
    const c = document.getElementById('c');
    const view = { w: c.clientWidth, h: c.clientHeight };
    const tl = timeline(session);
    const f = frame(session, tl.win.re, view, tl);
    const g = c.getContext('2d');
    const dpr = devicePixelRatio;
    const { x, y, r: rad } = f.swirl;
    const redIn = () => {
      const d = g.getImageData(Math.round((x - rad) * dpr), Math.round((y - rad) * dpr), Math.round(2 * rad * dpr), Math.round(2 * rad * dpr)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > d[i + 1] + 60 && d[i] > d[i + 2] + 60) n++;
      return n;
    };
    paint(g, { ...f, swirl: null });
    const without = redIn();
    paint(g, f);
    const h = f.items.find((i) => i.k === 'heading' && i.s === tl.spot.key);
    return { without, withSwirl: redIn(), key: tl.spot.key, mode: f.mode, rad, inHeading: !!h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h };
  });
  assert.equal(r.key, '宿の予約');
  assert.equal(r.mode, 'worst_spot');
  assert.ok(r.inHeading, '渦の中心が見出しの箱の中');
  assert.ok(r.withSwirl - r.without >= 10, `渦の赤い画素 ${r.withSwirl} - ${r.without}（半径 ${r.rad}）`);
  await p.close();
});

test('e2e: 拡張が再読み込みされたら、古いタブは例外を出さずに止まり、偽の手続きは開き直さない（AC-X2 ②・AC-6 ⑤）', async () => {
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto(url('booking', 'booking.html'));
  await p.click('#name');
  const before = ctx.pages().filter((x) => x.url().includes('/onboarding.html')).length;
  await sw.evaluate(() => chrome.runtime.reload());
  sw = await ctx.waitForEvent('serviceworker');
  await p.click('#name');
  await p.keyboard.type('鈴木');
  await p.click('button[type=submit]').catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  assert.deepEqual(errors.filter((e) => /sakki|Extension context|Uncaught/i.test(e)), []);
  assert.equal(ctx.pages().filter((x) => x.url().includes('/onboarding.html')).length, before);
  assert.ok(!JSON.stringify(await readState()).includes('鈴木'));
});
