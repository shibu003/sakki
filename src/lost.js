// 迷いの検出（REQ-3・弱点 #3）。記録から後で計算する純関数 1 本（docs/diagrams.md 図 4）。
// 再生（replay.js）も、完了のゴースト（W3）も、動画（W4）も同じ worstSpot を呼ぶ（2 本目の判定を持たない）。

export const STALL_MS = 30 * 1000;      // 読むだけの 30 秒は迷いにしない
export const STALL_CAP = 3 * 60 * 1000; // 1 回の停止は 3 分で打ち切る（昼休みで渦が最大にならない）
const NEAR = 4;                         // 同じ欄と見なす箱のずれ（px）

const near = (a, b, keys) => keys.every((k) => Math.abs(a[k] - b[k]) <= NEAR);
const boxOf = ({ x, y, w, h }) => ({ x, y, w, h });
const headingsOf = (p) => (p.items || []).filter((it) => it.k === 'heading');
// ページの見出し = 最初の見出しの文字。文字の無い見出し（社内の束）は区別できないので null（動画の焼き込みも使う）
export const pageKey = (p) => headingsOf(p)[0]?.s || null;
const isFieldEv = (e) => e.k === 'focus' || e.k === 'input';

// 同じ欄: 名前が同じで横の位置が同じ（作り直されて縦にずれても同じ）。名前が無ければ同じページか同じ見出しのページで同じ箱
function sameField(S, a, b) {
  if (a.s && b.s) return a.s === b.s && near(a, b, ['x', 'w']);
  const ka = pageKey(S.pages[a.pi]);
  return (a.pi === b.pi || (ka != null && ka === pageKey(S.pages[b.pi]))) && near(a, b, ['x', 'y', 'w', 'h']);
}

// 1 か所: 事象の上で一番近い見出し。上に無ければ最初の見出し、見出しが無ければ事象の箱
function spotOf(S, ev) {
  const hs = headingsOf(S.pages[ev.pi]);
  const cy = ev.y + ev.h / 2;
  let h = null;
  for (const it of hs) if (it.y <= cy && (!h || it.y >= h.y)) h = it;
  h = h || hs[0];
  if (!h) return { key: `${ev.pi}:${ev.x},${ev.y}`, pi: ev.pi, box: boxOf(ev) };
  return { key: h.s || `${ev.pi}:${h.x},${h.y}`, pi: ev.pi, box: boxOf(h) };
}

// 迷いの印を全部拾う。印 = { kind, from, to, key, pi, box }（from〜to = 損した間）
export function detectLost(S) {
  const pages = S?.pages || [];
  S = { pages };
  const evs = [];
  pages.forEach((p, pi) => { if (!p.away) for (const e of p.evs || []) evs.push({ ...e, pi }); });
  evs.sort((a, b) => a.t - b.t);
  const aways = pages.filter((p) => p.away);
  const crossesAway = (a, b) => aways.some((x) => x.t < b.t && (x.t1 ?? x.t) > a.t);
  const marks = [];
  const mark = (kind, from, to, spot) => marks.push({ kind, from: Math.min(from, to), to, ...spot });

  let lastFocus = null;
  evs.forEach((e, i) => {
    const before = evs.slice(0, i);
    if (e.k === 'focus') {
      // 直前の focus が同じ欄なら、窓を切り替えて戻っただけ（ブラウザが focus を返した）
      if (lastFocus && !sameField(S, lastFocus, e)) {
        const prev = before.findLast((x) => isFieldEv(x) && sameField(S, x, e));
        if (prev) mark('refocus', prev.t, e.t, spotOf(S, e));
      }
      lastFocus = e;
    } else if (e.k === 'input' && e.p) {
      const prev = before.findLast((x) => x.k === 'input' && x.p && sameField(S, x, e));
      if (prev) mark('repick', prev.t, e.t, spotOf(S, e));
    }
    // 止まっていた: 見えていた時間（vis = 隠れた後に見えるようになった時刻）の 30 秒を超えた分
    const a = evs[i - 1];
    if (a && !crossesAway(a, e)) {
      const over = e.t - Math.max(a.t, e.vis ?? 0) - STALL_MS;
      if (over > 0) mark('stall', e.t - Math.min(over, STALL_CAP), e.t, spotOf(S, e));
    }
  });

  // 同じ見出しへ戻った: 同じタブの中で、前に居た見出しへ、別の見出しを挟んで戻った（戻るボタンの分も）。
  // よその箱（login）だけを挟んだ戻りは 1 回目は普通の流れ、2 回目から（セッションが切れてまた戻った = 弱点 #8）
  const firstT = (p) => p.evs?.[0]?.t ?? p.t;
  const lastT = (p) => p.evs?.at(-1)?.t ?? p.t;
  const loggedIn = new Set();
  pages.forEach((p, j) => {
    const K = !p.away && pageKey(p);
    if (!K) return;
    const mine = pages.slice(0, j).filter((q) => String(q.tab) === String(p.tab));
    const prev = mine.at(-1);
    if (!prev || (!prev.away && pageKey(prev) === K)) return; // 同じ見出しのまま撮り直しただけ
    const qi = mine.findLastIndex((x) => !x.away && pageKey(x) === K);
    if (qi < 0) return;
    if (mine.slice(qi + 1).every((x) => x.away) && !loggedIn.has(K)) { loggedIn.add(K); return; }
    mark('revisit', lastT(mine[qi]), firstT(p), { key: K, pi: j, box: boxOf(headingsOf(p)[0]) });
  });
  return marks;
}

// 間の和集合の長さ（重なりを 2 回数えない = 事象の間の実時間を超えない）
function unionLength(iv) {
  let total = 0;
  let cur = null;
  for (const [f, t] of [...iv].sort((a, b) => a[0] - b[0])) {
    if (cur && f <= cur[1]) cur[1] = Math.max(cur[1], t);
    else { if (cur) total += cur[1] - cur[0]; cur = [f, t]; }
  }
  return cur ? total + cur[1] - cur[0] : 0;
}

// 一番損した 1 か所。印が 0 なら null
// { key, pi, box, loss, marks: [kind…], t0, t1 }（pi・box = 最後の印のページとその見出しの箱。t0〜t1 = 印の間の端から端）
export function worstSpot(S) {
  const groups = new Map();
  for (const m of detectLost(S)) {
    if (!groups.has(m.key)) groups.set(m.key, []);
    groups.get(m.key).push(m);
  }
  let best = null;
  for (const [key, ms] of groups) {
    const last = ms.reduce((a, b) => (b.to >= a.to ? b : a));
    const spot = {
      key, pi: last.pi, box: last.box,
      loss: unionLength(ms.map((m) => [m.from, m.to])),
      marks: ms.map((m) => m.kind),
      t0: Math.min(...ms.map((m) => m.from)), t1: Math.max(...ms.map((m) => m.to)),
    };
    if (!best || spot.loss > best.loss || (spot.loss === best.loss && (spot.marks.length > best.marks.length || (spot.marks.length === best.marks.length && spot.t0 < best.t0)))) best = spot;
  }
  return best;
}
