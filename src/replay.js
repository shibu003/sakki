// 再生の純粋部分。frame(session, t, view) が表示リストを返し、paint がそれを canvas に描くだけ。
// side panel の再生も W4 の動画も、この frame 1 本から作る（別の描き方を持たない = 見た物と渡す物が同じ）。
import { worstSpot } from './lost.js';

export const GHOST = { label: 'さっきの私', alpha: 0.6, color: '#4f46e5', r: 9 };
export const FILLED = '●●●';
const SPEED = 4;          // 早送りの倍率
const GAP_CAP = 2000;     // 1 つの間は実時間で 2 秒まで数える（= 再生で 0.5 秒まで）
const STEP_MIN = 150;
const AWAY_MS = 900;      // よそのサイトの箱を見せる時間
const END_HOLD = 800;
// 一番の迷い（lost.js の worstSpot）: その窓に入る事象へ向かう間は 1 倍、1.6 倍まで寄り、赤い渦を 1 つ残す
export const SWIRL = { color: '#dc2626', min: 12, max: 48 };
const SLOW_CAP = 1500;    // 窓の中の 1 つの間は実時間で 1.5 秒まで
const SLOW_MAX = 6000;    // 窓全体で 6 秒まで
const HOLD = 700;         // 窓の最後の事象で止める
const ZOOM = 1.6;
const RAMP = 400;         // 寄る・引くのにかける時間
export const swirlRadius = (loss) => Math.min(SWIRL.max, SWIRL.min + 5 * Math.sqrt(Math.max(0, loss) / 1000));

const center = (e) => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });
const fmtDur = (ms) => (ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分`);
export const awayText = (p) => `${p.host} で ${fmtDur(p.t1 - p.t)}`;

// 事象を時刻の順に並べ、再生の時刻 rt を振る。一番の迷いの窓（spot.t0〜t1）に入る事象へ向かう間だけ 1 倍
export function timeline(S) {
  const steps = [];
  S.pages.forEach((p, pi) => {
    if (p.away) steps.push({ t: p.t, pi, away: true });
    else for (const ev of p.evs || []) steps.push({ t: ev.t, pi, ev });
  });
  steps.sort((a, b) => a.t - b.t);
  const spot = worstSpot(S);
  const inWin = (s) => spot && !s.away && s.t >= spot.t0 && s.t <= spot.t1;
  const lastIn = steps.findLastIndex(inWin);
  let rt = 0;
  let slowLeft = SLOW_MAX;
  let win = null;
  steps.forEach((s, i) => {
    if (i > 0) {
      const prev = steps[i - 1];
      const gap = s.t - prev.t;
      if (inWin(s) && !win) win = { rs: rt };
      if (prev.away) rt += AWAY_MS;
      else if (inWin(s) && slowLeft > 0) {
        const d = Math.max(STEP_MIN, Math.min(gap, SLOW_CAP, slowLeft));
        slowLeft -= d;
        rt += d;
      } else rt += Math.max(STEP_MIN, Math.min(gap, GAP_CAP) / SPEED);
      if (i - 1 === lastIn) rt += HOLD;
    } else if (inWin(s)) win = { rs: 0 };
    s.rt = rt;
  });
  if (win) win.re = steps[lastIn].rt + HOLD;
  const total = steps.length ? rt + (steps[steps.length - 1].away ? AWAY_MS : 0) + (lastIn === steps.length - 1 ? HOLD : 0) + END_HOLD : 0;
  return { steps, total, spot, win };
}

// 寄りの倍率: 窓の中は ZOOM、窓の前後 RAMP で 1 へ
function zoomAt(win, t) {
  if (!win) return 1;
  const k = t < win.rs ? 1 - (win.rs - t) / RAMP : t > win.re ? 1 - (t - win.re) / RAMP : 1;
  return 1 + (ZOOM - 1) * ease(Math.max(0, k));
}

const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

export function frame(S, t, view, tl = timeline(S)) {
  const { steps, total, spot, win } = tl;
  const list = { w: view.w, h: view.h, total, mode: 'replay_fast', items: [], ghost: null, card: null, swirl: null };
  if (!steps.length) return list;
  t = Math.max(0, Math.min(t, total));
  let i = 0;
  while (i + 1 < steps.length && steps[i + 1].rt <= t) i++;
  const a = steps[i];
  const b = steps[i + 1];
  const u = b ? (t - a.rt) / (b.rt - a.rt) : 1;
  const samePage = b && !a.away && !b.away && a.pi === b.pi;
  const cur = b && !samePage && u >= 0.5 ? b : a;       // 別のページへは半分で切り替える
  const page = S.pages[cur.pi];
  const inWin = win && t >= win.rs && t <= win.re;
  if (inWin) list.mode = 'worst_spot';

  if (page.away) {
    list.card = { text: awayText(page) };
    // よそのサイトの間は、直前に居た本拠のページを薄く残す
    const back = [...S.pages.slice(0, cur.pi)].reverse().find((p) => !p.away);
    if (!back) return list;
    return drawPage(list, back, null, view);
  }
  let g;
  if (samePage) {
    const p = center(a.ev), q = center(b.ev), k = ease(u);
    g = { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
  } else {
    g = center(cur.ev);
  }
  // 画面のゴーストの時刻までに入力があった欄は ●●● を持つ
  const filled = new Set();
  for (const s of steps) {
    if (s.rt > t) break;
    if (s.ev && s.ev.k === 'input' && s.pi === cur.pi) filled.add(`${s.ev.x},${s.ev.y}`);
  }
  // 渦: 窓に入った時から、1 か所のページを映している間だけ。窓の間に育ち、窓の後は残る
  let sw = null;
  if (spot && win && t >= win.rs && cur.pi === spot.pi) {
    const grow = win.re - HOLD > win.rs ? Math.min(1, (t - win.rs) / (win.re - HOLD - win.rs)) : 1;
    sw = { box: spot.box, r: swirlRadius(spot.loss) * (0.3 + 0.7 * grow), a: (t / 250) % (Math.PI * 2) };
  }
  return drawPage(list, page, g, view, filled, zoomAt(win, t), sw);
}

function drawPage(list, page, g, view, filled = new Set(), z = 1, sw = null) {
  const scale = (view.w / page.vw) * z;
  const docW = page.vw * scale;
  const docH = Math.max(page.dh || 0, page.vh || 0) * scale;
  const camX = g ? Math.round(Math.max(0, Math.min(g.x * scale - view.w / 2, docW - view.w))) : 0;
  const camY = g ? Math.round(Math.max(0, Math.min(g.y * scale - view.h / 2, docH - view.h))) : 0;
  list.color = page.c || '#334155';
  list.host = page.host;
  for (const it of page.items) {
    const x = it.x * scale - camX;
    const y = it.y * scale - camY;
    const w = it.w * scale;
    const h = it.h * scale;
    if (y + h < 0 || y > view.h || x + w < 0 || x > view.w) continue;
    const d = { k: it.k, x, y, w, h };
    if (it.s) d.s = it.s;
    if (it.k === 'field' && (it.v || filled.has(`${it.x},${it.y}`))) d.v = FILLED;
    list.items.push(d);
  }
  if (g) list.ghost = { x: g.x * scale - camX, y: g.y * scale - camY, label: GHOST.label, alpha: GHOST.alpha };
  if (sw) list.swirl = { x: (sw.box.x + sw.box.w / 2) * scale - camX, y: (sw.box.y + sw.box.h / 2) * scale - camY, r: sw.r, a: sw.a };
  return list;
}

// ---- 描く（ctx は CanvasRenderingContext2D か OffscreenCanvasRenderingContext2D）----
const FONT = '"Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';

function fitText(ctx, s, w) {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= w) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + '…';
}

export function paint(ctx, list) {
  const { w, h } = list;
  ctx.save();
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = 'middle';
  for (const it of list.items) {
    switch (it.k) {
      case 'band':
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(it.x, it.y, it.w, it.h);
        break;
      case 'media':
        ctx.fillStyle = '#cbd5e1';
        ctx.fillRect(it.x, it.y, it.w, it.h);
        break;
      case 'heading':
        ctx.fillStyle = '#0f172a';
        ctx.font = `700 ${Math.max(11, Math.min(18, it.h * 0.7))}px ${FONT}`;
        if (it.s) ctx.fillText(fitText(ctx, it.s, it.w), it.x, it.y + it.h / 2);
        else { ctx.fillStyle = '#cbd5e1'; ctx.fillRect(it.x, it.y + it.h * 0.3, Math.min(it.w, 160), it.h * 0.4); }
        break;
      case 'field': {
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1;
        ctx.fillRect(it.x, it.y, it.w, it.h);
        ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
        ctx.font = `400 11px ${FONT}`;
        if (it.s) { ctx.fillStyle = '#475569'; ctx.fillText(fitText(ctx, it.s, it.w), it.x, it.y - 7); }
        if (it.v) { ctx.fillStyle = '#334155'; ctx.fillText(it.v, it.x + 6, it.y + it.h / 2); }
        break;
      }
      case 'button':
        ctx.fillStyle = list.color;
        ctx.fillRect(it.x, it.y, it.w, it.h);
        if (it.s) {
          ctx.fillStyle = '#ffffff';
          ctx.font = `600 12px ${FONT}`;
          ctx.textAlign = 'center';
          ctx.fillText(fitText(ctx, it.s, it.w - 6), it.x + it.w / 2, it.y + it.h / 2);
          ctx.textAlign = 'start';
        }
        break;
      case 'choice':
        ctx.strokeStyle = '#94a3b8';
        ctx.strokeRect(it.x + 0.5, it.y + 0.5, it.w - 1, it.h - 1);
        break;
    }
  }
  if (list.card) {
    ctx.fillStyle = 'rgba(248,250,252,0.85)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0f172a';
    ctx.font = `600 15px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, list.card.text, w - 24), w / 2, h / 2);
    ctx.textAlign = 'start';
  }
  const sw = list.swirl;
  if (sw) {
    // 赤い渦巻き 2.5 巻き（中心から外へ）。こちらが書く文字は足さない
    ctx.strokeStyle = SWIRL.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const u = i / 60, ang = sw.a + u * 5 * Math.PI;
      const x = sw.x + sw.r * u * Math.cos(ang), y = sw.y + sw.r * u * Math.sin(ang);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const g = list.ghost;
  if (g) {
    ctx.globalAlpha = g.alpha;
    ctx.fillStyle = GHOST.color;
    ctx.beginPath();
    ctx.arc(g.x, g.y, GHOST.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `600 11px ${FONT}`;
    const tw = ctx.measureText(g.label).width + 10;
    const lx = Math.min(g.x + GHOST.r + 4, w - tw - 2);
    ctx.fillRect(lx, g.y - 9, tw, 18);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(g.label, lx + 5, g.y);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
