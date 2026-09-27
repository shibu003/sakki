// side panel: 同意の前は偽の手続きへの入口、同意の後は今のタブの記録（無ければ一番新しい記録）を早送りで走らせる。
// 写しの在るページは、実際の見た目を sandbox の iframe（script なし・押せない）に建て直し、frame のカメラで動かす。
// 同じ記録の動画（PBI-0005）を開いた時に裏で作り、「送る」で OS の共有シートへ（使えなければダウンロード）
import { timeline, frame, paint } from './replay.js';
import { makeClip } from './clip.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const shot = $('page');
const send = $('send');
let run = 0;
let clip = null; // 出来た MP4（File）。共有シートは押した瞬間の操作が要るので、押す前に作っておく
let shown = null; // iframe に建てているページ

function show(S, f) {
  const d = f.dom;
  const p = d && S.pages[d.pi];
  shot.hidden = !p;
  if (!p) return;
  if (shown !== p) {
    shown = p;
    shot.style.width = `${p.vw}px`;
    shot.style.height = `${Math.max(p.dh || 0, p.vh || 0)}px`;
    shot.srcdoc = p.dom;
  }
  shot.style.transform = `translate(${-d.x}px, ${-d.y}px) scale(${d.scale})`;
}

function setStatus(mode, text) {
  document.body.dataset.mode = mode; // onboarding / idle / replay_fast
  $('status').textContent = text;
  $('try').hidden = mode !== 'onboarding';
}

async function load() {
  ++run; // 作りかけの動画を捨てる
  clip = null;
  send.hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'get', tab: tab?.id });
  if (!res?.consented) return setStatus('onboarding', 'まだ何も録っていません。30 秒の偽の手続きの中の同意の欄を押すと、録り始めます。');
  if (!res.session) return setStatus('idle', 'まだ記録がありません。手続きのページで欄を押すと、そこから録ります。');
  play(res.session);
}

function play(S) {
  const me = ++run;
  const tl = timeline(S);
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setStatus('replay_fast', 'さっきの自分が、早送りで走り直しています。');
  $('again').hidden = true;
  const t0 = performance.now();
  const tick = (now) => {
    if (me !== run) return;
    const t = Math.min(now - t0, tl.total);
    const f = frame(S, t, { w, h }, tl);
    show(S, f);
    paint(ctx, f);
    if (document.body.dataset.mode !== f.mode) document.body.dataset.mode = f.mode; // replay_fast / worst_spot（一番の迷いの窓）
    if (t < tl.total) return requestAnimationFrame(tick);
    setStatus('idle', 'ここまでが、さっきの自分です。');
    document.body.dataset.done = '1';
    $('again').hidden = false;
  };
  requestAnimationFrame(tick);
  prepare(S, me);
}

async function prepare(S, me) {
  send.hidden = false;
  send.disabled = true;
  send.textContent = '動画を作っています…';
  try {
    const f = await makeClip(S, () => me !== run);
    if (me !== run || !f) return;
    clip = f;
    send.disabled = false;
    send.textContent = '送る';
  } catch (e) {
    if (me === run) send.textContent = e?.name === 'NotSupportedError' ? 'この Chrome では動画を作れません' : '動画を作れませんでした（もう一度 で作り直す）';
  }
}

// 共有シート。利用者が閉じた（AbortError）時は何もしない。無い・他の理由で失敗 → ダウンロード
send.addEventListener('click', async () => {
  const f = clip;
  if (!f) return;
  if (navigator.canShare?.({ files: [f] })) {
    try { return await navigator.share({ files: [f] }); } catch (e) { if (e?.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f);
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});

$('again').addEventListener('click', load);
// 開いている side panel でゴーストが押された → 閉じたばかりの記録を走らせ直す
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'ghost_pressed') load(); });
$('try').addEventListener('click', () => chrome.tabs.create({ url: 'onboarding.html' }));
load();
