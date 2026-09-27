// 記録の単位（REQ-6・弱点 #8 #9）の純粋な reducer。SW はメッセージをこれに通して storage.session に置くだけ。
// 束 = 根のタブ＋そこから開いたタブ。段は prelude → homed → closed（docs/diagrams.md 図 2）。
import { worstSpot } from './lost.js';

export const IDLE_MS = 30 * 60 * 1000;

const TWO_LEVEL = new Set([
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'lg.jp', 'ed.jp', 'gr.jp', 'ad.jp',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.kr', 'com.cn', 'com.tw', 'co.nz', 'com.br', 'co.in',
]);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// 登録できるドメインの近似（動画の焼き込みも使う）。ponytail: 末尾 2 ラベル＋2 段の接尾辞の小さな表。
// github.io のような私的な接尾辞では 1 段上（foo.github.io → github.io）に出る。外れが実際に出たら Public Suffix List（約 230KB）を入れる
export function siteOf(host) {
  if (!host.includes('.') || IPV4.test(host)) return host;
  const l = host.split('.');
  return l.slice(TWO_LEVEL.has(l.slice(-2).join('.')) ? -3 : -2).join('.');
}

// 社内: ドットの無いホスト・私的 IP・.local。会社専用の login 窓口は束が通っただけで社内にする（共用の Google・Microsoft は入れない）
export function isInternalHost(host) {
  if (!host.includes('.') || host.endsWith('.local')) return true;
  if (!IPV4.test(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
export const isCorpLogin = (host) => /(^|\.)(okta|oktapreview|okta-emea|onelogin)\.com$/.test(host);

export const initialState = () => ({ sessions: {}, root: {} });

// onInstalled の reason が install の時だけ偽の手続きを開く（update・起動では開き直さない）
export const shouldOpenOnboarding = (reason) => reason === 'install';

const rootOf = (st, tab) => st.root[tab] ?? tab;
const baseSite = (S) => S.home ?? S.pages.find((p) => !p.away)?.site; // 子のタブにとっての「よそ」の基準
const stripText = (items) => items.map(({ s, ...rest }) => rest);
const lastPageOf = (S, tab) => {
  for (let i = S.pages.length - 1; i >= 0; i--) if (S.pages[i].tab === tab && !S.pages[i].away) return S.pages[i];
  return null;
};
// このタブの最後の事象（事象の無いページは飛ばす）
const lastEvOf = (S, tab) => {
  for (let i = S.pages.length - 1; i >= 0; i--) {
    const p = S.pages[i];
    if (p.tab === tab && !p.away && p.evs?.length) return p.evs[p.evs.length - 1];
  }
  return null;
};
// よそのサイト（本拠の外・子のタブなら束の基準の外）
const awayFor = (S, site, child) => (S.phase === 'homed' && site !== S.home) || (child && baseSite(S) != null && site !== baseSite(S));
// 本拠へ戻った = 開いているよそのサイトの箱を閉じる
const closeAway = (S, t) => {
  const last = S.pages[S.pages.length - 1];
  if (last && last.open) { last.t1 = Math.max(last.t1, t); delete last.open; }
};
const addMemo = (S, memo) => {
  if (!memo || !memo.length) return;
  const set = new Set(S.memo);
  for (const m of memo) set.add(m);
  S.memo = [...set];
};
const goInternal = (S) => {
  S.internal = true;
  for (const p of S.pages) {
    delete p.dom; // 実際の見た目の写しも捨てる（骨組みの絵に落ちる）
    if (p.items) p.items = stripText(p.items);
    if (p.evs) p.evs = stripText(p.evs);
  }
};

function newSession(root, t, seed) {
  return { root, phase: 'prelude', home: null, internal: false, seed, memo: [], t0: t, t1: t, pages: [] };
}

// msg.type: hello / page / ev / done / ask / tab_created / tab_removed / tick / revoke
// SW が足す物: tab（sender.tab.id）・host（sender.url のホスト名だけ）・own（拡張自身のページ）・t・seed（新しい束の乱数）
export function reduce(state, msg) {
  const st = structuredClone(state);
  delete st.reply;
  const t = msg.t;
  for (const [r, S] of Object.entries(st.sessions)) if (t - S.t1 > IDLE_MS) dropSession(st, r); // 長く放置したら消す
  switch (msg.type) {
    case 'revoke':
      return initialState();
    case 'tick':
      return st;
    case 'tab_created': {
      // リンクから開いたタブだけ束に入れる（新しいタブのページは opener が居ても入れない）
      if (msg.opener != null && /^https?:/.test(msg.url || '') && st.sessions[rootOf(st, msg.opener)]) st.root[msg.tab] = rootOf(st, msg.opener);
      return st;
    }
    case 'tab_removed': {
      const r = rootOf(st, msg.tab);
      delete st.root[msg.tab];
      const S = st.sessions[r];
      if (!S) return st;
      if (String(r) === String(msg.tab)) S.rootGone = true;
      if (S.rootGone && !Object.values(st.root).some((x) => String(x) === String(r))) dropSession(st, r); // 束のタブが全部閉じた
      return st;
    }
  }

  const r = rootOf(st, msg.tab);
  let S = st.sessions[r];
  const site = msg.own ? 'sakki' : siteOf(msg.host || '');
  const child = String(r) !== String(msg.tab);

  // hello = 最初の focus か click。ask = 読み込み時（中身なし）: 生きている束のページだけ hello と同じに扱い、返事で文脈を先に渡す
  // （押した直後にページが替わっても最初の事象を落とさない）。束の外・閉じた束では何もしない（録り始めは最初の focus か click）
  if (msg.type === 'hello' || msg.type === 'ask') {
    if (msg.type === 'ask' && (!S || S.phase === 'closed')) return st;
    if (S && S.phase === 'closed') { dropSession(st, r); S = null; }  // 完了の後の次の手続き → 閉じた記録を捨てる
    if (!S) S = st.sessions[r] = newSession(Number(r), t, msg.seed);
    if (!msg.own && (isInternalHost(msg.host) || isCorpLogin(msg.host))) goInternal(S);
    const away = awayFor(S, site, child);
    closeAway(S, msg.since ?? t);
    if (away) S.pages.push({ away: true, open: true, tab: msg.tab, host: msg.host, t: msg.since ?? t, t1: t });
    S.t1 = t;
    st.reply = { take: !away, noText: S.internal, seed: S.seed, memo: S.memo };
    // 完了を判定してよいか: 押して移った先（このタブの最後の事象が主なボタン）・PDF の画面・印刷
    if (msg.type === 'ask' && !away && (msg.why !== 'arrive' || lastEvOf(S, msg.tab)?.pr)) st.reply.check = 1;
    return st;
  }

  if (!S || S.phase === 'closed') return st;
  if (msg.type === 'done') {
    S.t1 = t;
    if (msg.level === 'weak') { S.weak = t; return st; } // 弱い合図: 束は続く（右クリックだけ）
    S.phase = 'closed';
    st.reply = { ghost: worstSpot(S) != null, tab: msg.tab }; // 閉じた瞬間の 1 回だけ = ゴーストは 1 回だけ置く
    return st;
  }
  // よそのサイトからの骨組みと事象は受けない（take:false で来ないはずの物も捨てる）
  if (awayFor(S, site, child)) return st;
  closeAway(S, t); // 本拠の事象 = 戻ってきた（back で戻ると bfcache で hello が来ないので、ここでも閉じる）
  if (msg.type === 'page') {
    if (S.phase === 'prelude' && !child && S.pages.some((p) => !p.away && p.site !== site)) {
      S.pages = S.pages.filter((p) => !p.away && p.site === site); // 本拠が決まる前にサイトが替わった → 前の分を捨てる
      S.memo = [];
    }
    addMemo(S, msg.memo);
    S.pages.push({
      tab: msg.tab, host: msg.host, site, t,
      vw: msg.vw, vh: msg.vh, dh: msg.dh, c: msg.c,
      items: S.internal ? stripText(msg.items) : msg.items, evs: [],
      ...(msg.dom && !S.internal ? { dom: msg.dom } : {}), // 実際の見た目の写し（PBI-0007）
    });
    S.t1 = t;
    return st;
  }
  if (msg.type === 'ev') {
    addMemo(S, msg.memo); // 事象を捨てる時も、覚える集まりは捨てない（捨てると後のページで値が伏せられない）
    const p = lastPageOf(S, msg.tab);
    if (!p) return st;
    const { k, x, y, w, h, s, n, p: pick, vis, pr } = msg;
    const ev = { t, k, x, y, w, h };
    if (s && !S.internal) ev.s = s;
    if (n) ev.n = n;
    if (pick) ev.p = 1;                         // 選び直しを数える欄（lost.js の repick）
    if (pr) ev.pr = 1;                          // 主なボタンを押した（次のページの ask が完了を判定させる）
    if (vis > 0) ev.vis = Math.min(vis, t);     // 隠れた後に見えるようになった時刻（lost.js の stall）
    p.evs.push(ev);
    if (k === 'input' && !msg.search && S.phase === 'prelude') {
      S.phase = 'homed';
      S.home = p.site;
    }
    S.t1 = t;
    return st;
  }
  return st;
}

function dropSession(st, r) {
  delete st.sessions[r];
  for (const [tab, x] of Object.entries(st.root)) if (String(x) === String(r)) delete st.root[tab];
}

// content script への返事（hello の後だけ在る）
export function takeReply(st) {
  const { reply, ...rest } = st;
  return [rest, reply];
}

// side panel が出す束: 今のタブの束、無ければ一番新しく動いた束
export function sessionFor(state, tab) {
  const S = state.sessions[rootOf(state, tab)];
  if (S && S.pages.some((p) => !p.away)) return S;
  let best = null;
  for (const x of Object.values(state.sessions)) if (x.pages.some((p) => !p.away) && (!best || x.t1 > best.t1)) best = x;
  return best;
}

// 右クリックの「さっきの自分を呼ぶ」を出すタブ: 束に合図（完了か弱い合図）が来ていて、渦が在る
export function callable(state, tab) {
  const S = state.sessions[rootOf(state, tab)];
  return !!S && (S.phase === 'closed' || S.weak != null) && worstSpot(S) != null;
}

// storage.session の上限（10MB）に当たった時: 一番大きい束の、一番古い写しから捨てる（そのページは骨組みの絵に落ちる）。
// 写しが無くなったら一番古いページから捨て、空になった束は消す
export function shrink(state) {
  const st = structuredClone(state);
  let big = null;
  let size = -1;
  for (const [r, S] of Object.entries(st.sessions)) {
    const n = JSON.stringify(S).length;
    if (n > size) { size = n; big = r; }
  }
  if (big == null) return st;
  const withDom = st.sessions[big].pages.find((p) => p.dom);
  if (withDom) { delete withDom.dom; return st; }
  st.sessions[big].pages.shift();
  if (!st.sessions[big].pages.length) dropSession(st, big);
  return st;
}
