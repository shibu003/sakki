// side panel: 同意の前は偽の手続きへの入口、同意の後は今のタブの記録（無ければ一番新しい記録）を早送りで走らせる。
// 写しの在るページは、実際の見た目を sandbox の iframe（script なし・押せない）に建て直し、frame のカメラで動かす
import { timeline, frame, paint } from './replay.js';

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const shot = $('page');
let run = 0;
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
}

$('again').addEventListener('click', load);
// 開いている side panel でゴーストが押された → 閉じたばかりの記録を走らせ直す
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'ghost_pressed') load(); });
$('try').addEventListener('click', () => chrome.tabs.create({ url: 'onboarding.html' }));
load();
