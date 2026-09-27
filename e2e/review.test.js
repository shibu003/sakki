// sakki-mvp の module review（2026-09-27）の攻撃と通し。extension.test.js とは別の Chrome for Testing（入れた直後から）で回す。
// 芯 = 偽の手続き → 角のゴースト → side panel の再生 → 「送る」1 回で MP4。漏れの攻撃 = 名前の欄の見落とし・写しの属性・後から覚えた名前。
// 動画に出うる文字 = 写しの文字 ∪ 骨組みの文字 ∪ 焼き込み（clip.js は再生と同じ frame と写しから作る）なので、動画は OCR せずこの和集合で見る
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { captions } from '../src/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'e2e', 'fixtures');
let server, port, ctx, sw, extId;
const errors = [];
const url = (host, file) => `http://${host}.test:${port}/${file}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => sw.evaluate(() => chrome.storage.session.get('state').then((r) => r.state || { sessions: {}, root: {} }));
const findSession = (st, host) => Object.values(st.sessions).find((S) => S.pages.some((p) => p.host === host && !p.away));
// 記録の中の文字列だけ（箱の数字と memo の hash は除く）
const stringsOf = (S) => JSON.stringify(S, (k, v) => (typeof v === 'number' || k === 'memo' ? undefined : v));
async function waitFor(fn, what, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  assert.fail(`時間内に成り立たなかった: ${what}`);
}
async function newPage() {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${p.url()}: ${e}`));
  return p;
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(FIX, new URL(req.url, 'http://x').pathname);
    if (!f.startsWith(FIX) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(f, 'utf8').replaceAll('PORT', String(port)));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'sakki-review-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`, '--host-resolver-rules=MAP *.test 127.0.0.1'],
  });
  sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  extId = new URL(sw.url()).host;
});
test.after(async () => {
  await ctx?.close();
  server?.close();
});

// 後ろの攻撃は ① の同意の上で走る（変異の runner は 'review 通し ①|review 攻撃' で選ぶ）
test('review 通し ①: 入れた直後の偽の手続きで同意して予約まで進めると、完了の画面の角でゴーストが待つ', async () => {
  const ob = await waitFor(() => ctx.pages().find((p) => p.url().includes('/onboarding.html')), '入れた直後に偽の手続きが開く');
  ob.on('pageerror', (e) => errors.push(`onboarding: ${e}`));
  await ob.waitForLoadState();
  await ob.check('#consent');
  await waitFor(() => sw.evaluate(() => chrome.storage.local.get('consentedAt').then((r) => !!r.consentedAt)), '同意が入る');
  await ob.click('#start');
  await ob.click('#name');
  await ob.keyboard.type('山田');
  await ob.selectOption('#day', { index: 1 });
  await sleep(900);
  assert.equal(await ob.isVisible('#full'), true, '最初に選んだ日は満席');
  await ob.selectOption('#day', { index: 3 });
  await sleep(900);
  await ob.click('button[type=submit]');
  await waitFor(async () => (await ob.locator('iframe[title="さっきの私"]').count()) === 1, '完了の画面の角にゴーストが待つ', 20000);
  const S = await waitFor(async () => Object.values((await readState()).sessions).find((x) => x.home === 'sakki' && x.phase === 'closed'), '偽の手続きの束が閉じる');
  assert.ok(!/山田/.test(JSON.stringify(S)), '打った名前は記録に無い');
  assert.deepEqual(captions(S), ['sakki', '予約が完了しました（ためし）', '「予約する」で抜けた'], '焼き込み');
});

test('review 通し ②: sakki を押すと実際の見た目の上を自分が走り、「送る」1 回で MP4 が共有シートへ', async () => {
  // sakki のアイコン = side panel（テストでは sidepanel.html をタブで開く）。共有シートは差し替えて File を受ける
  const p = await newPage();
  await p.addInitScript(() => { window.__shared = []; navigator.share = async (d) => { window.__shared.push(d.files[0]); }; });
  await p.setViewportSize({ width: 360, height: 640 });
  await p.goto(`chrome-extension://${extId}/sidepanel.html`);
  await p.waitForFunction(() => document.body.dataset.mode === 'worst_spot', null, { timeout: 30000, polling: 'raf' });
  const shot = await (await p.$('#page')).contentFrame();
  assert.equal(await shot.evaluate(() => document.querySelector('section:not([hidden]) h1')?.textContent), '宿の予約（ためし）', '実際の見た目の上を走る');
  await p.waitForFunction(() => document.body.dataset.done === '1', null, { timeout: 30000 });
  await p.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 180000 });
  await p.click('#send');
  await p.waitForFunction(() => window.__shared.length === 1, null, { timeout: 5000 });
  const mp4 = await p.evaluate(async () => {
    const f = window.__shared[0];
    const b = new Uint8Array(await f.arrayBuffer());
    const at = (s) => { for (let i = 0; i + 4 <= b.length; i++) if (String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]) === s) return i; return -1; };
    const v = document.createElement('video');
    v.muted = true;
    v.src = URL.createObjectURL(f);
    await new Promise((ok, ng) => { v.onloadeddata = ok; v.onerror = () => ng(new Error(v.error?.message)); });
    v.currentTime = v.duration - 0.05; // 最後までシークできる
    await new Promise((r) => { v.onseeked = r; });
    const { timeline } = await import('./src/replay.js');
    const { INTRO, OUTRO } = await import('./src/clip.js');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const { session } = await chrome.runtime.sendMessage({ type: 'get', tab: tab.id });
    return { name: f.name, type: f.type, ftyp: at('ftyp'), moov: at('moov'), mdat: at('mdat'), dur: v.duration, want: (INTRO + timeline(session).total + OUTRO) / 1000, home: session.home };
  });
  assert.equal(mp4.home, 'sakki', 'side panel が映したのは偽の手続きの束');
  assert.equal(mp4.type, 'video/mp4');
  assert.equal(mp4.name, 'sakki-sakki.mp4');
  assert.ok(mp4.ftyp === 4 && mp4.moov > 0 && mp4.moov < mp4.mdat, `ftyp 先頭・moov が mdat より前: ${JSON.stringify(mp4)}`);
  assert.ok(Math.abs(mp4.dur - mp4.want) < 0.1, `長さ ${mp4.dur} ≒ ${mp4.want}`);
  await p.close();
});

test('review 攻撃: 「予約者名」「Last name」の 2 文字の名前も、確認・完了の画面と焼き込みで伏せる・写しの属性に日付と番号を残さない', async () => {
  const p = await newPage();
  await p.goto(url('leak', 'rv-form.html'));
  await p.click('#who');
  await p.keyboard.type('山田');
  await p.click('#last');
  await p.keyboard.type('Wu');
  await sleep(900);
  await Promise.all([p.waitForURL(/rv-confirm/), p.click('button[type=submit]')]);
  await waitFor(async () => findSession(await readState(), 'leak.test')?.pages.length >= 2, '確認の画面の写し');
  await Promise.all([p.waitForURL(/rv-done/), p.click('#ok')]);
  const S = await waitFor(async () => { const x = findSession(await readState(), 'leak.test'); return x?.phase === 'closed' ? x : null; }, '完了で閉じる');
  const all = stringsOf(S);
  for (const w of ['山田', 'Wu', '2026', '10-15', '5678']) assert.ok(!all.includes(w), `記録に「${w}」`);
  const heads = S.pages.map((x) => x.items.find((i) => i.k === 'heading')?.s);
  assert.deepEqual(heads, ['予約者の入力', '■■ 様の予約内容', '■■ 様、予約が完了しました']);
  assert.ok(S.pages[1].dom.includes('Dear Mr. ■■,'), '英語の名前も本文で伏せる');
  assert.ok(/<time datetime="■{10}">/.test(S.pages[1].dom) && S.pages[1].dom.includes('download="■■_予約確認.pdf"'), '見える属性も伏せる');
  const lines = captions(S);
  assert.deepEqual(lines.slice(0, 2), ['leak.test', '■■ 様、予約が完了しました'], '焼き込みに名前が出ない');
  await p.close();
});

test('review 攻撃: 1 ページ目の本文に出ていた名前を 2 ページ目で打つと、前のページの写しでも伏せる（覚える集まりの当て直し）', async () => {
  const p = await newPage();
  await p.goto(url('member', 'rv-welcome.html'));
  await p.click('#more');
  await waitFor(async () => findSession(await readState(), 'member.test')?.pages[0]?.dom, '会員ページの写し');
  await Promise.all([p.waitForURL(/rv-member/), p.click('#go')]);
  await p.click('#nm');
  await p.keyboard.type('山田太郎');
  await sleep(1200); // 0.8 秒で入力が送られる
  const S = await waitFor(async () => { const x = findSession(await readState(), 'member.test'); return x?.pages[1]?.evs.some((e) => e.k === 'input') ? x : null; }, '名前の入力が届く');
  assert.ok(!/山田|太郎/.test(stringsOf(S)), stringsOf(S));
  assert.ok(S.pages[0].dom.includes('ご予約者: ■■■■ 様'), '前のページの本文も伏せる');
  await p.close();
});

test('review: どのページでも content script・偽の手続き・side panel が例外を出さない', () => {
  assert.deepEqual(errors, []);
});
