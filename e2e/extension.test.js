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
// state の文字列だけ（箱の数字と memo の hash は除く = 幅 1232 の「123」に当たらない）
const stringsOf = (S) => JSON.stringify(S, (k, v) => (typeof v === 'number' || k === 'memo' ? undefined : v));
const textsOf = (S) => S.pages.flatMap((p) => [p.host, ...(p.items || []).map((i) => i.s), ...(p.evs || []).map((e) => e.s)]).filter(Boolean);
// side panel（拡張のページを 360x640 のタブで開く）と、その中の実際の見た目の iframe
async function openPanel() {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  return p;
}
// Playwright は sandbox の srcdoc の枠の url を about:blank と報告するので、要素から辿る
const shotOf = async (p) => (await p.$('#page'))?.contentFrame();
// iframe の文書の点 (x, y) が side panel の画面のどこに出ているか（transform 込み）
const iframeBox = (p) => p.$eval('#page', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, s: r.width / e.offsetWidth }; });
// 画面の画素（PNG を拡張のページで解く）
async function pixelAt(p, x, y) {
  const png = await p.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } });
  return p.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const g = new OffscreenCanvas(1, 1).getContext('2d');
    g.drawImage(bmp, 0, 0);
    return [...g.getImageData(0, 0, 1, 1).data];
  }, png.toString('base64'));
}
const near = (px, rgb, tol = 24) => rgb.every((v, i) => Math.abs(px[i] - v) <= tol);

test.before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(FIX, new URL(req.url, 'http://x').pathname);
    if (!f.startsWith(FIX) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
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

test('e2e: 偽の手続きの後に side panel を開くと、実際の見た目の上をゴーストが走る（PBI-0007 AC-1 通し）', async () => {
  const p = await openPanel();
  await p.waitForFunction(() => document.body.dataset.mode === 'replay_fast' || document.body.dataset.mode === 'worst_spot', null, { timeout: 10000 });
  const seen = new Set();
  while (!(await p.evaluate(() => document.body.dataset.done === '1'))) {
    const h = await (await shotOf(p))?.evaluate(() => document.querySelector('section:not([hidden]) h1')?.textContent).catch(() => null);
    if (h) seen.add(h);
    await sleep(50);
  }
  // ゴーストが走るのは事象のあるページ（予約の画面）。完了の画面は押した後なので走らない（side panel の隣に本物が在る）
  assert.deepEqual([...seen], ['宿の予約（ためし）'], [...seen].join(' / '));
  assert.equal(await p.$eval('#page', (e) => e.hidden), false, '実際の見た目の iframe が見えている');
  const look = await (await shotOf(p)).evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor, main: getComputedStyle(document.querySelector('main')).backgroundColor,
    button: getComputedStyle(document.querySelector('button[type=submit]')).backgroundColor, name: document.querySelector('#name').value,
  }));
  assert.deepEqual(look, { body: 'rgb(241, 245, 249)', main: 'rgb(255, 255, 255)', button: 'rgb(15, 118, 110)', name: '' }, '偽の手続きの色のまま・名前を打つ前の写し');
  const S = sessionsOf(await readState()).find((x) => x.home === 'sakki');
  const s1 = S.pages.find((x) => x.dom?.includes('<section id="s1">'));
  assert.ok(s1, '宿の予約の画面の写しが在る');
  assert.match(s1.dom, /<button type="submit">予約する<\/button>/);
  assert.ok(!JSON.stringify(S).includes('テスト'), '入れた名前は写しにも無い');
  await p.close();
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
  assert.equal(h.s, '■■ 様の予約内容（■■■■■■）'); // 選んだ日（10月15日）は覚える集まりに入るので、月・日 も伏せる
  assert.equal(booking.phase, 'homed');
  const kinds = booking.pages[0].evs.map((e) => e.k).join(',');
  // 欄を押す = focus と click。select は押すたびに click、選ぶたびに input（0.8 秒あけたので 1 回ずつ）
  assert.equal(kinds, 'focus,click,input,focus,click,input,click,input,click,input,click');
});

test('e2e: side panel が記録を早送りで描き、最後の位置にゴーストが居る・実際の見た目の色と写真・伏せ字（AC-2 ③・AC-1 ②・PBI-0007 AC-1 AC-2）', async () => {
  const p = await openPanel();
  // 宿の予約のページを映している間に、画面の画素で header の色と写真を見る（カメラが動いた・ページが替わった回は測り直す）
  let look = null;
  for (let i = 0; i < 300 && !look; i++) {
    const fr = await shotOf(p);
    const at = () => fr.evaluate(() => {
      const ph = document.querySelector('#photo');
      if (document.querySelector('h1')?.textContent !== '宿の予約' || !ph?.complete || !ph.naturalWidth) return null;
      const r = ph.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }).catch(() => null);
    const ph = fr && (await at());
    if (ph) {
      const a = await iframeBox(p);
      const header = await pixelAt(p, a.x + 200 * a.s, a.y + 24 * a.s);
      const photo = await pixelAt(p, a.x + ph.x * a.s, a.y + ph.y * a.s);
      if (JSON.stringify(a) === JSON.stringify(await iframeBox(p)) && (await at())) look = { header, photo };
    }
    if (!look) await sleep(20);
  }
  assert.ok(look, '宿の予約のページの写真が side panel に読み込まれた');
  assert.ok(near(look.header, [15, 118, 110]), `header は実際の色（#0f766e）: ${look.header}`);
  assert.ok(near(look.photo, [249, 115, 22]), `写真は実際の画像（#f97316）: ${look.photo}`);
  await p.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 20000 });
  // 最後は確認のページ: 実際の見た目の上でも、名前と日は伏せ字（AC-2）
  const last = await (await shotOf(p)).evaluate(() => ({ h1: document.querySelector('h1').textContent, text: document.body.textContent }));
  assert.equal(last.h1, '■■ 様の予約内容（■■■■■■）', '選んだ日は覚える集まりに入り、数字の間の 月・日 も伏せる');
  assert.ok(!/山田|10月/.test(last.text), last.text);
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
  const json = stringsOf(S);
  for (const w of ['123', 'AB-1234', 'taro', 'example.com', '山田', '太郎', 'カード番号', '4242', 'other.test']) assert.ok(!json.includes(w), `記録に「${w}」`);
  // 実際の見た目の写し（PBI-0007）: 本文は実際のまま、数字・メール・header の名前は伏せ、顔写真は実際の画像、よその枠は灰色の箱
  const dom = S.pages[0].dom;
  assert.ok(dom.includes('残高 ■■■■■■■ 円') && dom.includes('予約番号 AB-■■■■'), '本文は実際のまま、数字だけ伏せる');
  assert.ok(dom.includes('■■■■さんのマイページ') && dom.includes('>■■■■ ■</button>'), 'header の名前は写しでも伏せる');
  assert.match(dom, /<img id="face"[^>]* src="data:image\/gif;base64,/);
  assert.match(dom, /<div id="ext"[^>]*background:#cbd5e1/);
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
  assert.equal(media.length, 2, JSON.stringify(items.map((i) => [i.k, i.w, i.h, i.s])));
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

test('e2e: 罠のページ — 写しに script・値・選んだ物・よその枠を写さず、再生の枠は動かない（PBI-0007 AC-X1）', async () => {
  const p = await ctx.newPage();
  await p.goto(url('trap', 'trap.html'));
  await p.click('#birth');
  const S = await waitFor(async () => { const x = findSession(await readState(), 'trap.test'); return x?.pages[0]?.dom ? x : null; }, 'trap.test の写し');
  const dom = S.pages[0].dom;
  for (const w of ['<script', 'NOSCRIPT-TEXT', 'http-equiv', 'onerror', 'secret-token', 'カード払い', '現地払い', '1990', 'IFRAME-TEXT', 'checked', 'trap.html']) assert.ok(!dom.includes(w), `写しに「${w}」`);
  assert.ok(dom.includes('支払い方法') && dom.includes('<template shadowrootmode="open"><p id="in">名義の欄</p></template>'), '本文と閉じた shadow root の中は写す');
  const birth = dom.match(/<input id="birth"[^>]*>/)?.[0] || '';
  assert.ok(birth.includes('type="text"') && birth.includes('value="●●●"'), `日付の値は ●●●: ${birth}`);
  const vh = await p.evaluate(() => innerHeight);
  assert.ok(dom.includes(`height: ${vh}px`) && !dom.includes('height: 100vh') && dom.includes('.min-h-\\[100vh\\]'), 'vh は記録時の px に・class 名は替えない');
  assert.ok(dom.includes('rgb(1, 2, 3)'), 'CSSOM に足した規則も写す');
  const q = await openPanel();
  await q.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 20000 });
  await sleep(500);
  const fr = await shotOf(q);
  assert.equal(await fr.evaluate(() => location.href), 'about:srcdoc', '再生の枠はよそへ動いていない');
  const r = await fr.evaluate(() => ({
    ran: window.__ran ?? null,
    inner: document.querySelector('#pc').shadowRoot?.querySelector('#in')?.textContent,
    border: getComputedStyle(document.querySelector('#js')).borderTopColor,
    hero: document.querySelector('#js').getBoundingClientRect().height,
  }));
  assert.deepEqual(r, { ran: null, inner: '名義の欄', border: 'rgb(1, 2, 3)', hero: vh + 7 }, 'script は動かず・閉じた shadow root は建ち・CSSOM の規則が効き・vh は記録時の高さ');
  await q.close();
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
  // タブは閉じない: 束の元のタブを閉じると束ごと消える（tab_removed）。次の side panel の検査はこの束（一番新しい束）を映す
});

test('e2e: side panel が一番の迷いで 1 倍に落とし、見出しの上に赤い渦を描く・実際の見出しの上（PBI-0003 AC-7 c・PBI-0007 AC-3）', async () => {
  const p = await openPanel();
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
    const end = frame(session, tl.total, view, tl).swirl, cr = c.getBoundingClientRect();
    return { without, withSwirl: redIn(), key: tl.spot.key, t1: session.t1, mode: f.mode, rad, inHeading: !!h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h, end: { x: cr.left + end.x, y: cr.top + end.y } };
  });
  // 走り終わった画面: 渦の中心が、実際の見た目の iframe の見出し（h1）の箱の中（PBI-0007 AC-3）
  const a = await iframeBox(p);
  const h1 = await (await shotOf(p)).evaluate(() => { const b = document.querySelector('h1').getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, s: document.querySelector('h1').textContent }; });
  assert.equal(h1.s, '宿の予約');
  const inH1 = r.end.x >= a.x + h1.l * a.s && r.end.x <= a.x + h1.r * a.s && r.end.y >= a.y + h1.t * a.s && r.end.y <= a.y + h1.b * a.s;
  assert.ok(inH1, `渦 ${JSON.stringify(r.end)} が h1 ${JSON.stringify(h1)}（${JSON.stringify(a)}）の上`);
  assert.equal(r.key, '宿の予約');
  assert.equal(r.t1, back.t1, 'side panel が映したのは戻るボタンの検査の束');
  assert.equal(r.mode, 'worst_spot');
  assert.ok(r.inHeading, '渦の中心が見出しの箱の中');
  assert.ok(r.withSwirl - r.without >= 10, `渦の赤い画素 ${r.withSwirl} - ${r.without}（半径 ${r.rad}）`);
  await p.close();
});

// ---- PBI-0004: 完了の合図と、角で待つゴースト ----
const GHOST_SEL = 'iframe[title="さっきの私"]';
const ghosts = (p) => p.locator(GHOST_SEL).count();
// タブの id は開いた時に覚える（URL で引くと、前の検査で同じ done.html に居るタブを拾う）。偽の手続きのタブは 1 枚なので URL で引く
const tabIds = new WeakMap();
async function newTab() {
  const ids = () => sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => t.id)));
  const before = new Set(await ids());
  const p = await ctx.newPage();
  tabIds.set(p, await waitFor(async () => (await ids()).find((id) => !before.has(id)), '開いたタブの id'));
  return p;
}
const tabIdOf = async (p) => tabIds.get(p) ?? sw.evaluate((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id), p.url());
// callable は拡張のページ（偽の手続き）で session.js を読んで、今の state に当てる
const callableOf = async (p) => onboarding().evaluate(async (tab) => {
  const { callable } = await import('./src/session.js');
  const { state } = await chrome.storage.session.get('state');
  return callable(state, tab);
}, await tabIdOf(p));
const boxOf = (p, sel) => p.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
const overlap = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
// 渦のある束（泊まる日を 3 回選ぶ）を持つタブ
async function lostTab() {
  const p = await newTab();
  await p.goto(url('booking', 'booking.html'));
  await p.bringToFront();
  await p.click('#name');
  await p.keyboard.type('高橋');
  for (const d of ['10月14日', '10月16日', '10月15日']) {
    await p.click('#day');
    await p.selectOption('#day', d);
    await sleep(900);
  }
  return p;
}
const sessionOfTab = async (p) => { const st = await readState(); const id = await tabIdOf(p); return st.sessions[st.root[id] ?? id]; };

test('e2e: 確認画面は弱い合図、完了画面の空いた角にゴースト（PBI-0004 AC-1・AC-3 a・AC-5 a e）', async () => {
  await sw.evaluate(() => {
    globalThis.__menu = [];
    globalThis.__gets = 0;
    const u = chrome.contextMenus.update;
    chrome.contextMenus.update = function (id, props, cb) { globalThis.__menu.push([id, props.visible]); return u.call(chrome.contextMenus, id, props, cb); };
    chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'get') globalThis.__gets++; });
  });
  const p = await lostTab();
  await Promise.all([p.waitForURL(/confirm/), p.click('button[type=submit]')]);
  // 確認画面: main に確定の submit が残る = 弱い合図。ゴーストは出さず、右クリックだけ
  const weak = await waitFor(async () => { const S = await sessionOfTab(p); return S?.weak ? S : null; }, '確認画面で弱い合図', 6000);
  await sleep(2000);
  assert.equal(await ghosts(p), 0, '確認画面にゴーストは出ない');
  assert.equal(weak.phase, 'homed');
  assert.equal(await callableOf(p), true);
  assert.ok((await sw.evaluate(() => globalThis.__menu)).some(([id, v]) => id === 'call_menu' && v === true), '右クリックの項目を見せた');
  // 完了画面: 押した form が消え、main に押せる送信ボタンが無い（検索の form は数えない）= 強い合図
  await Promise.all([p.waitForURL(/done/), p.click('#ok')]);
  await waitFor(async () => (await ghosts(p)) === 1, '完了画面にゴーストが 1 つ', 6000);
  const src = await p.$eval(GHOST_SEL, (f) => f.src);
  assert.equal(src, `chrome-extension://${extId}/ghost.html`);
  const g = await boxOf(p, GHOST_SEL);
  const vh = await p.evaluate(() => document.documentElement.clientHeight);
  assert.ok(Math.abs(g.l - 16) <= 1 && Math.abs(vh - g.b - 16) <= 1, `左下（右下は固定のチャットで塞がる）: ${JSON.stringify(g)} vh=${vh}`);
  for (const sel of ['h1', '#no', 'header a', '#top', '#chat', 'form[role=search]']) assert.ok(!overlap(g, await boxOf(p, sel)), `${sel} に重ならない`);
  assert.equal(await p.evaluate((s) => document.activeElement === document.querySelector(s), GHOST_SEL), false, 'focus を奪わない');
  // ゴーストは返事で即出るが、storage.session は background.js の save() が 200ms まとめて書く（apply のたびに延びる）
  const S = await waitFor(async () => { const x = await sessionOfTab(p); return x?.phase === 'closed' ? x : null; }, '完了で閉じる', 6000);
  assert.equal(S.pages.at(-1).items.find((i) => i.k === 'heading')?.s, '予約が完了しました');
  // サイトが自分で呼ぶ scroll では引っ込まない
  await p.evaluate(() => scrollTo(0, 300));
  await sleep(1000);
  assert.equal(await ghosts(p), 1, 'サイトの scroll では残る');
  // 押すと side panel が開き（get が来る）、ゴーストは引っ込む
  await p.frameLocator(GHOST_SEL).locator('#g').click();
  await waitFor(async () => (await ghosts(p)) === 0, 'ゴーストを押すと引っ込む（side panel が開いた）', 5000);
  // 枠は ghost_pressed（sidePanel.open が決まった直後）で外れ、get は side panel の文書が読み込まれてから来る = 後になりうる
  await waitFor(async () => (await sw.evaluate(() => globalThis.__gets)) >= 1, 'side panel が get を送った', 5000);
  assert.equal(await callableOf(p), true, '引っ込んだ後も右クリックで呼べる');
});

// 前の検査の束（泊まる日を 3 回選び直し、完了の画面まで = 一番新しい束）を動画にする。
// side panel の navigator.share は差し替えて File を受け（headless でも canShare は true）、VideoEncoder は数える
test('e2e: 送る 1 回で、さっきの早送りが MP4 になって共有シートに渡る・無ければダウンロード（PBI-0005 通し AC-1〜4・AC-X1〜X3）', async (t) => {
  const p = await ctx.newPage();
  await p.addInitScript(() => {
    window.__shared = [];
    let fail = null;
    window.__shareFails = (name) => { fail = name; };
    navigator.share = async (d) => { if (fail) throw new DOMException('x', fail); window.__shared.push(d.files[0]); };
    const E = window.VideoEncoder;
    window.__encs = [];
    window.VideoEncoder = class extends E {
      constructor(o) { super(o); this.n = 0; window.__encs.push(this); }
      configure(c) { this.codec = c.codec; return super.configure(c); }
      encode(f, o) { this.n++; return super.encode(f, o); }
      close() { this.closedAt = this.n; return super.close(); }
    };
  });
  // 待ちが切れたら、どこで止まったかを message に出す（「作れませんでした」で n が 0 = 1 枚目で投げた・「作っています…」で n が 0 = 写しの絵が決まらない・5 = encoder が受け取らない）
  const clipWait = (fn, ms) => p.waitForFunction(fn, null, { timeout: ms }).catch(async (e) => {
    const st = await p.evaluate(() => ({
      send: ['hidden', 'disabled', 'textContent'].map((k) => document.getElementById('send')[k]), mode: document.body.dataset.mode,
      encs: window.__encs.map((x) => ({ codec: x.codec, n: x.n, q: x.encodeQueueSize, state: x.state, closedAt: x.closedAt })),
    })).catch((x) => String(x));
    throw new Error(`${e.message}\n動画の状態: ${JSON.stringify(st)}`);
  });
  const reqs = [];
  p.on('request', (r) => reqs.push({ method: r.method(), url: r.url() }));
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  // AC-X3: 作っている途中で読み直す（もう一度・ゴーストが押された時と同じ load）→ 前の encoder は途中で閉じる
  await clipWait(() => window.__encs[0]?.n > 5, 60000);
  assert.equal(await p.$eval('#send', (b) => [b.hidden, b.disabled, b.textContent].join('|')), 'false|true|動画を作っています…');
  await p.evaluate(() => document.getElementById('again').click());
  await clipWait(() => !document.getElementById('send').disabled, 180000);
  assert.equal(await p.textContent('#send'), '送る');
  const encs = await p.evaluate(() => window.__encs.map((e) => ({ codec: e.codec, n: e.n, closedAt: e.closedAt })));
  assert.equal(encs.length, 2, JSON.stringify(encs));
  assert.ok(encs[0].closedAt != null && encs[0].closedAt < encs[1].n, `前の encoder は途中で閉じた: ${JSON.stringify(encs)}`);
  // AC-1: 押すと共有シートに MP4 が 1 本。ftyp が先頭・moov が mdat より前（チャットの streaming 再生）・H.264
  await p.click('#send');
  await p.waitForFunction(() => window.__shared.length === 1, null, { timeout: 5000 });
  const info = await p.evaluate(async () => {
    const f = window.__shared[0];
    const b = new Uint8Array(await f.arrayBuffer());
    const find = (s) => { for (let i = 0; i + 4 <= b.length; i++) if (b[i] === s.charCodeAt(0) && b[i + 1] === s.charCodeAt(1) && b[i + 2] === s.charCodeAt(2) && b[i + 3] === s.charCodeAt(3)) return i; return -1; };
    // この Chrome に H.264 の encoder が在るか（clip.js の configOf と同じ形で。CI の ubuntu の Chrome for Testing 151 には在った・run 36373372943 の下見）
    const h264 = (await Promise.all(['avc1.4d0028', 'avc1.42001f'].map((codec) => VideoEncoder.isConfigSupported({ codec, width: 720, height: 1280, bitrate: 2e6, framerate: 30, avc: { format: 'avc' } }).then((r) => r.supported, () => false)))).some(Boolean);
    return { name: f.name, type: f.type, size: b.length, ftyp: find('ftyp'), moov: find('moov'), mdat: find('mdat'), avc1: find('avc1'), vp09: find('vp09'), h264 };
  });
  assert.equal(info.name, 'sakki-booking.test.mp4');
  assert.equal(info.type, 'video/mp4');
  assert.equal(info.ftyp, 4, 'ftyp が先頭');
  assert.ok(info.moov > 0 && info.moov < info.mdat, `moov ${info.moov} が mdat ${info.mdat} より前`);
  if (info.h264) assert.ok(info.avc1 > 0, 'H.264');
  else { // clip.js の CODECS の順で VP9 に落ちる。落ちずに確かめ、訳を TAP に残す
    assert.ok(info.vp09 > 0 && info.avc1 < 0, `H.264 の無い Chrome では VP9: ${JSON.stringify(info)}`);
    t.diagnostic('この Chrome には H.264 の encoder が無い → VP9 の MP4 を確かめた。iPhone・LINE で再生できるか（H.264 の道）はこの run では測っていない');
  }
  // AC-2・AC-3: Chrome の video で開いてシークし、画素を見る（1 枚ごとの位置は同じ frame() で出す）
  const seen = await p.evaluate(async () => {
    const { timeline, frame, captions } = await import('./src/replay.js');
    const { VIEW, INTRO, OUTRO } = await import('./src/clip.js');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { session: S } = await chrome.runtime.sendMessage({ type: 'get', tab: tab.id });
    const tl = timeline(S);
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(window.__shared[0]);
    await new Promise((ok, ng) => { v.onloadeddata = ok; v.onerror = () => ng(new Error(`video: ${v.error?.message}`)); });
    const g = new OffscreenCanvas(720, 1280).getContext('2d', { willReadFrequently: true });
    // 再生の時刻 t を含む 1 枚へ（1 枚の真ん中にシーク）。返り値 = その 1 枚が描いた再生の時刻
    const seek = async (t) => {
      const i = Math.floor(((INTRO + t) * 30) / 1000);
      v.currentTime = (i + 0.5) / 30;
      await new Promise((r) => { v.onseeked = r; });
      g.drawImage(v, 0, 0, 720, 1280);
      return (i * 1000) / 30 - INTRO;
    };
    const px = (x, y) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
    const count = (x, y, w, h, hit) => { const d = g.getImageData(Math.round(x), Math.round(y), Math.round(w), Math.round(h)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (hit(d[i], d[i + 1], d[i + 2])) n++; return n; };
    const orange = (r, gg, b) => Math.abs(r - 249) < 30 && Math.abs(gg - 115) < 30 && Math.abs(b - 22) < 40;
    const red = (r, gg, b) => r > 150 && r - gg > 80 && Math.abs(gg - b) < 40; // 渦（#dc2626）。橙の写真・琥珀のボタンは g と b が離れている
    // 冒頭（1 枚目 = サムネ）: 実際の見た目の header と写真、下端の帯
    const f0 = frame(S, 0, VIEW, tl);
    await seek(-INTRO / 2);
    const intro = { header: px((600 * f0.dom.scale - f0.dom.x) * 2, (24 * f0.dom.scale - f0.dom.y) * 2), photo: count(0, 0, 720, 1280, orange), band: px(10, 1272) };
    // 途中: ゴースト（4 つ目の事象の時刻）
    const tg = await seek(tl.steps[3].rt);
    const fg = frame(S, tg, VIEW, tl);
    const ghost = px(fg.ghost.x * 2, fg.ghost.y * 2);
    // 渦の窓の終わり: 渦の円の中の赤
    const tw = await seek(tl.win.re);
    const sw = frame(S, tw, VIEW, tl).swirl;
    const swirlRed = sw ? count((sw.x - sw.r) * 2, (sw.y - sw.r) * 2, sw.r * 4, sw.r * 4, red) : -1;
    // 最後: 完了の画面の写しの上端（header）と帯
    await seek(tl.total + OUTRO - 100);
    const endPage = S.pages.findLast((x) => !x.away);
    const end = { header: px(600, 24 * (VIEW.w / endPage.vw) * 2), band: px(10, 1272), done: !!endPage.dom };
    return { dur: v.duration, want: (INTRO + tl.total + OUTRO) / 1000, intro, ghost, swirlRed, end, lines: captions(S), doms: S.pages.map((x) => x.dom || '').join('\n') };
  });
  assert.ok(Math.abs(seen.dur - seen.want) < 0.1, `長さ ${seen.dur} 秒 ≒ 冒頭＋再生＋最後 ${seen.want} 秒`);
  assert.deepEqual(seen.lines, ['booking.test', '予約が完了しました', '「予約する」で抜けた'], '焼き込みの 3 行（AC-3）');
  assert.ok(near(seen.intro.header, [15, 118, 110], 40), `冒頭: 実際の header の色 ${seen.intro.header}`);
  assert.ok(seen.intro.photo >= 200, `冒頭: 実際の写真（data: に直した画像）の橙の画素 ${seen.intro.photo}`);
  assert.ok(near(seen.intro.band, [15, 23, 42], 30), `冒頭: 焼き込みの帯 ${seen.intro.band}`);
  assert.ok(seen.ghost[2] > seen.ghost[0] + 40 && seen.ghost[2] > seen.ghost[1] + 40, `途中: ゴーストの青紫 ${seen.ghost}`);
  assert.ok(seen.swirlRed >= 10, `渦の窓の終わり: 赤い渦の画素 ${seen.swirlRed}`);
  assert.ok(seen.end.done, '完了の画面の写しが在る');
  assert.ok(near(seen.end.header, [15, 118, 110], 40), `最後: 完了の画面の header ${seen.end.header}`);
  assert.ok(near(seen.end.band, [15, 23, 42], 30), `最後: 焼き込みの帯 ${seen.end.band}`);
  // AC-X2 ④ の手前: XML にならない属性・要素・制御文字が在っても、写しは絵になる（1 つで SVG ごと読めなくなる）
  const xmlish = await p.evaluate(async () => {
    const { raster } = await import('./src/clip.js');
    const dom = '<!doctype html><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja"><body style="margin:0"><div x-on:click="a" @click="b" :class="c" xlink:href="#" style="background:#dc2626;width:40px;height:40px"></div><o:p>文\u000b</o:p><svg width="10" height="10"><use xlink:href="#a"/></svg></body></html>';
    const b = await raster({ dom, vw: 100, vh: 100 }, { data: async () => null, text: async () => null });
    const g = new OffscreenCanvas(100, 100).getContext('2d');
    g.drawImage(b, 0, 0);
    return [...g.getImageData(20, 20, 1, 1).data].slice(0, 3);
  });
  assert.deepEqual(xmlish, [220, 38, 38], 'x-on:click・@click・:class・html の xmlns・o:p・制御文字の在る写しも絵になる');
  // AC-4: 通信は全部 GET で、拡張の中か写しに在る資源だけ（記録・動画を載せた送信は 0 本）
  // blob:（拡張の origin）は検査が <video> で開いた手元の MP4（Chrome 151・playwright-core 1.62.1 で request に出た。145・1.58.2 では出ていなかった）。外へは出ない
  const odd = reqs.filter((r) => r.method !== 'GET' || !(r.url.startsWith(`chrome-extension://${extId}/`) || r.url.startsWith(`blob:chrome-extension://${extId}/`) || r.url.startsWith('data:') || seen.doms.includes(r.url)));
  assert.deepEqual(odd, [], '写しの外への通信');
  // AC-X1: 共有シートの無い Chrome → 同じ MP4 がダウンロード
  await p.evaluate(() => { navigator.canShare = () => false; });
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), p.click('#send')]);
  assert.equal(dl.suggestedFilename(), 'sakki-booking.test.mp4');
  assert.equal(fs.statSync(await dl.path()).size, info.size);
  // AC-X2 ①: 利用者が共有シートを閉じた → 何もしない ② 他の理由で失敗 → ダウンロード
  await p.evaluate(() => { delete navigator.canShare; window.__shareFails('AbortError'); });
  let dls = 0;
  const onDl = () => dls++;
  p.on('download', onDl);
  await p.click('#send');
  await sleep(1500);
  p.off('download', onDl);
  assert.equal(dls, 0, '閉じた時はダウンロードしない');
  await p.evaluate(() => window.__shareFails('NotAllowedError'));
  const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 10000 }), p.click('#send')]);
  assert.equal(dl2.suggestedFilename(), 'sakki-booking.test.mp4');
  assert.equal(await p.evaluate(() => window.__shared.length), 1, '共有シートに渡ったのは最初の 1 回だけ');
  await p.close();
});

test('e2e: H.264 も VP9 も無い Chrome では「送る」は押せず、訳を出す（PBI-0005 AC-X2 ③）', async () => {
  const p = await ctx.newPage();
  await p.addInitScript(() => { VideoEncoder.isConfigSupported = async () => ({ supported: false }); });
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  await p.waitForFunction(() => { const b = document.getElementById('send'); return !b.hidden && b.textContent !== '動画を作っています…'; }, null, { timeout: 20000 }); // 初めの「送る」（hidden）で抜けない
  assert.deepEqual(await p.$eval('#send', (b) => [b.hidden, b.disabled, b.textContent]), [false, true, 'この Chrome では動画を作れません']);
  await p.close();
});

test('e2e: 迷いの無い手続きの完了では何も出ない（PBI-0004 AC-2）', async () => {
  const p = await newTab();
  await p.goto(url('booking', 'booking.html'));
  await p.click('#name');
  await p.keyboard.type('伊藤');
  await p.selectOption('#day', '10月15日');
  await Promise.all([p.waitForURL(/confirm/), p.click('button[type=submit]')]);
  await Promise.all([p.waitForURL(/done/), p.click('#ok')]);
  await waitFor(async () => (await sessionOfTab(p))?.phase === 'closed', '完了で閉じる', 6000);
  await sleep(1500);
  assert.equal(await ghosts(p), 0);
  assert.equal(await callableOf(p), false);
});

test('e2e: 控えの PDF と印刷で完了、入力画面の PDF は弱い・サイトの CSS に負けない・手が動いたら引っ込む（PBI-0004 AC-4・AC-X1 ①・AC-5 b c d・AC-6）', async () => {
  // (c) 入力画面の約款 PDF: main に「予約する」が残る = 弱い
  const a = await lostTab();
  await a.click('#terms');
  const Sa = await waitFor(async () => { const S = await sessionOfTab(a); return S?.weak ? S : null; }, '入力画面の PDF で弱い合図');
  assert.equal(Sa.phase, 'homed');
  assert.equal(await ghosts(a), 0);
  // (b) 控えの画面で印刷（afterprint）。サイトの CSS が iframe を消そうとしても出る
  await a.goto(url('booking', 'receipt.html'));
  await a.addStyleTag({ content: 'iframe{display:none!important;opacity:0!important}' });
  await a.evaluate(() => dispatchEvent(new Event('afterprint')));
  await waitFor(async () => (await ghosts(a)) === 1, '印刷の後にゴースト', 6000);
  await waitFor(async () => (await sessionOfTab(a))?.phase === 'closed', '印刷で閉じる', 6000);
  assert.deepEqual(await a.$eval(GHOST_SEL, (f) => [getComputedStyle(f).display, getComputedStyle(f).opacity]), ['block', '1']);
  await a.keyboard.press('Shift'); // (c) キー
  await waitFor(async () => (await ghosts(a)) === 0, 'キーで引っ込む', 2000);
  // (a) 控えの PDF を押す
  const b = await lostTab();
  await b.goto(url('booking', 'receipt.html'));
  await b.click('#pdf');
  await waitFor(async () => (await ghosts(b)) === 1, '控えの PDF でゴースト', 6000);
  await waitFor(async () => (await sessionOfTab(b))?.phase === 'closed', '控えの PDF で閉じる', 6000);
  await b.mouse.click(300, 300); // (d) 本文を押す
  await waitFor(async () => (await ghosts(b)) === 0, '本文を押すと引っ込む', 2000);
  await sleep(1500);
  assert.equal(await ghosts(b), 0, '同じページで出し直さない');
  // 偽の手続きも同じゴースト（AC-6）。(b) wheel で引っ込む
  const ob = onboarding();
  assert.equal(await ghosts(ob), 1, '偽の手続きの完了画面にも同じ枠');
  assert.equal(await ob.$eval(GHOST_SEL, (f) => f.src), `chrome-extension://${extId}/ghost.html`);
  await ob.bringToFront();
  await ob.mouse.move(200, 200);
  await ob.mouse.wheel(0, 60);
  await waitFor(async () => (await ghosts(ob)) === 0, 'wheel で引っ込む', 2000);
});

test('e2e: 角が塞がる完了では出さずに右クリックで呼べる（PBI-0004 AC-X2 ②）', async () => {
  const p = await lostTab();
  await p.goto(url('booking', 'full.html'));
  await p.evaluate(() => dispatchEvent(new Event('afterprint')));
  await waitFor(async () => (await sessionOfTab(p))?.phase === 'closed', '印刷で閉じる', 6000);
  await sleep(1000);
  assert.equal(await ghosts(p), 0, '4 つの角が文字で塞がっている');
  assert.equal(await callableOf(p), true);
});

// 最後に置く（拡張を落とすので、後ろの検査は SW に触れない）。headless の Chrome for Testing に --load-extension した拡張は
// runtime.reload() の後に戻らない（2026-09-27 実測: serviceWorkers() が空のまま・拡張のページが ERR_BLOCKED_BY_CLIENT）ので、新しい SW は待たない。
// 測るのは「文脈の切れた古いタブで打っても例外が出ない」だけ。偽の手続きを開き直さない（AC-6 ⑤）は unit の shouldOpenOnboarding が持つ
test('e2e: 拡張が再読み込みされたら、古いタブは例外を出さずに止まる（AC-X2 ②）', async () => {
  const p = await ctx.newPage();
  const errors = [];
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push(e.stack || String(e))); // stack = どの行が文脈の切れた chrome.* に触ったか
  await p.goto(url('booking', 'booking.html'));
  await p.click('#name');
  await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await sleep(500);
  await p.click('#name');
  await p.keyboard.type('鈴木');
  await p.selectOption('#day', '10月14日');
  await p.click('button[type=submit]').catch(() => {});
  await sleep(1000);
  assert.deepEqual(errors.filter((e) => /sakki|Extension context|Uncaught/i.test(e)), []);
});
