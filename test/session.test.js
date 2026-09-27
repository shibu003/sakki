// 記録の単位の reducer（AC-4・AC-6 ⑤・AC-8・AC-X1〜X3）
import test from 'node:test';
import assert from 'node:assert/strict';
import { reduce, initialState, takeReply, sessionFor, shrink, shouldOpenOnboarding, siteOf, IDLE_MS } from '../src/session.js';

// メッセージ列を流す。hello の返事は replies に積む
function run(msgs, st = initialState()) {
  const replies = [];
  for (const m of msgs) {
    const [next, reply] = takeReply(reduce(st, { seed: 7, ...m }));
    st = next;
    if (m.type === 'hello') replies.push(reply);
  }
  return { st, replies };
}
const page = (tab, host, t, heading = '見出し') => ({ type: 'page', tab, host, t, vw: 800, vh: 600, dh: 1200, items: [{ k: 'heading', x: 0, y: 0, w: 200, h: 30, s: heading }] });
const ev = (tab, host, t, k, extra = {}) => ({ type: 'ev', tab, host, t, k, x: 10, y: 10, w: 100, h: 30, ...extra });
const hello = (tab, host, t, since = t) => ({ type: 'hello', tab, host, t, since });
const homed = (tab = 1, host = 'booking.test', t = 1000) => [hello(tab, host, t), page(tab, host, t + 10, '予約'), ev(tab, host, t + 20, 'focus'), ev(tab, host, t + 30, 'input', { n: 2 })];

test('session: よそのサイトの箱（AC-4 a）', () => {
  const { st, replies } = run([
    ...homed(),
    hello(1, 'auth.test', 10100, 10000),
    page(1, 'auth.test', 10200, 'ログイン'),
    ev(1, 'auth.test', 10300, 'input', { n: 8 }),
    hello(1, 'booking.test', 190100, 190000),
    page(1, 'booking.test', 190200, '確認'),
  ]);
  assert.equal(replies[1].take, false); // auth.test では中身を取らない
  const S = st.sessions[1];
  const away = S.pages.filter((p) => p.away);
  assert.equal(away.length, 1);
  assert.deepEqual({ host: away[0].host, sec: (away[0].t1 - away[0].t) / 1000 }, { host: 'auth.test', sec: 180 });
  assert.ok(!('items' in away[0]) && !('evs' in away[0]));
  assert.ok(!JSON.stringify(st).includes('ログイン'));
  assert.equal(S.pages.filter((p) => !p.away).length, 2);
});

test('session: 本拠が決まる前にサイトが替わったら前の分を捨てる（AC-4 b）', () => {
  const { st } = run([
    hello(1, 'search.test', 1000), page(1, 'search.test', 1010, '検索'), ev(1, 'search.test', 1020, 'input', { search: true, memo: ['3abc'] }),
    ...homed(1, 'booking.test', 5000),
  ]);
  const S = st.sessions[1];
  assert.equal(S.phase, 'homed');
  assert.equal(S.home, 'booking.test');
  assert.ok(!JSON.stringify(st).includes('search.test'));
  assert.ok(!S.memo.includes('3abc'));
});

test('session: 30 分の放置と、束のタブが全部閉じた時に消える（AC-4 c）', () => {
  let { st } = run(homed());
  assert.equal(run([{ type: 'tick', t: 1030 + IDLE_MS + 1 }], st).st.sessions[1], undefined);
  assert.ok(run([{ type: 'tick', t: 1030 + IDLE_MS - 1 }], st).st.sessions[1]);
  // 子のタブが残っている間は持つ
  st = run([{ type: 'tab_created', tab: 2, opener: 1, url: 'https://booking.test/help', t: 2000 }, { type: 'tab_removed', tab: 1, t: 2100 }], st).st;
  assert.ok(st.sessions[1]);
  st = run([{ type: 'tab_removed', tab: 2, t: 2200 }], st).st;
  assert.deepEqual(st, initialState());
});

test('session: 子のタブ — 同じサイトは同じ束に、よそのサイトは箱に、新しいタブのページは入れない（REQ-6）', () => {
  const { st, replies } = run([
    ...homed(),
    { type: 'tab_created', tab: 2, opener: 1, url: 'https://booking.test/plan', t: 2000 },
    hello(2, 'booking.test', 2010), page(2, 'booking.test', 2020, 'プラン'),
    { type: 'tab_created', tab: 3, opener: 1, url: 'https://help.test/', t: 3000 },
    hello(3, 'help.test', 3010),
    { type: 'tab_created', tab: 4, opener: 1, url: undefined, t: 4000 }, // chrome://newtab（ホストの許しが無いので url が読めない）
    hello(4, 'news.test', 4010), page(4, 'news.test', 4020, 'ニュース'),
  ]);
  assert.deepEqual(replies.map((r) => r.take), [true, true, false, true]);
  const S = st.sessions[1];
  assert.deepEqual(S.pages.map((p) => (p.away ? `away:${p.host}` : `${p.tab}:${p.host}`)), ['1:booking.test', '2:booking.test', 'away:help.test']);
  assert.ok(st.sessions[4] && !JSON.stringify(S).includes('news.test'));
});

test('session: 社内の判定（AC-8）', () => {
  for (const host of ['intranet', '10.0.0.5', '192.168.1.20', 'wiki.local']) {
    const { st, replies } = run([hello(1, host, 1000), page(1, host, 1010, '人事')]);
    assert.equal(replies[0].noText, true, host);
    assert.ok(!JSON.stringify(st).includes('人事'), host);
  }
  // okta を通った束は、前に取った文字も消える
  const { st } = run([hello(1, 'booking.test', 1000), page(1, 'booking.test', 1010, '予約'), ev(1, 'booking.test', 1020, 'click', { s: '送信' }),
    hello(1, 'acme.okta.com', 2000), hello(1, 'booking.test', 3000), page(1, 'booking.test', 3010, '確認')]);
  assert.equal(st.sessions[1].internal, true);
  assert.ok(!/予約|確認|送信/.test(JSON.stringify(st)));
  // 共用の login は社内にしない
  const g = run([hello(1, 'booking.test', 1000), page(1, 'booking.test', 1010, '予約'), hello(1, 'accounts.google.com', 2000)]);
  assert.equal(g.st.sessions[1].internal, false);
  assert.ok(JSON.stringify(g.st).includes('予約'));
});

test('session: 同意を外すと全部消える（AC-X1 ②）', () => {
  const { st } = run([...homed(), ...homed(2, 'clinic.test', 1100), { type: 'revoke', t: 2000 }]);
  assert.deepEqual(st, initialState());
});

test('session: 読み直しても同じ束に続く（AC-X2 ①）', () => {
  const a = run(homed()).st;
  const revived = JSON.parse(JSON.stringify(a)); // SW が眠って storage.session から読み直した形
  const { st } = run([ev(1, 'booking.test', 1500, 'click')], revived);
  assert.equal(Object.keys(st.sessions).length, 1);
  assert.equal(st.sessions[1].pages[0].evs.length, 3);
});

test('session: 上限に当たったら古いページから捨て、完全な JSON のまま縮む（AC-X2 ③）', () => {
  let { st } = run([...homed(), page(1, 'booking.test', 1100, '2'), page(1, 'booking.test', 1200, '3')]);
  const before = JSON.stringify(st).length;
  st = shrink(st);
  assert.deepEqual(st.sessions[1].pages.map((p) => p.items[0].s), ['2', '3']);
  assert.ok(JSON.stringify(st).length < before);
  st = shrink(shrink(st));
  assert.deepEqual(JSON.parse(JSON.stringify(st)), initialState());
});

test('session: 2 つの束が混ざらない（AC-X3）', () => {
  const { st } = run([
    hello(1, 'booking.test', 1000), hello(2, 'clinic.test', 1001),
    page(1, 'booking.test', 1010, '宿'), page(2, 'clinic.test', 1011, '診療'),
    ev(1, 'booking.test', 1020, 'input', { memo: ['3aaa'] }), ev(2, 'clinic.test', 1021, 'input', { memo: ['3bbb'] }),
    ev(1, 'booking.test', 1030, 'click'), ev(2, 'clinic.test', 1031, 'click'),
  ]);
  assert.equal(Object.keys(st.sessions).length, 2);
  assert.ok(!JSON.stringify(st.sessions[2]).includes('宿') && !JSON.stringify(st.sessions[1]).includes('診療'));
  assert.deepEqual([st.sessions[1].memo, st.sessions[2].memo], [['3aaa'], ['3bbb']]);
  assert.equal(sessionFor(st, 2).home, 'clinic.test');
  assert.equal(sessionFor(st, 99).root, 2); // 束の無いタブ（side panel 自身など）には一番新しく動いた束
});

test('session: 完了で閉じ、次の手続きで閉じた記録を捨てる', () => {
  let { st } = run([...homed(1, 'booking.test'), { type: 'done', tab: 1, t: 1100 }]);
  assert.equal(st.sessions[1].phase, 'closed');
  st = run([ev(1, 'booking.test', 1200, 'click')], st).st;
  assert.equal(st.sessions[1].pages[0].evs.length, 2); // 閉じた後の事象は入らない
  st = run([hello(1, 'clinic.test', 1300), page(1, 'clinic.test', 1310, '診療')], st).st;
  assert.ok(!JSON.stringify(st).includes('booking'));
});

test('session: install の時だけ偽の手続きを開く（AC-6 ⑤）', () => {
  assert.deepEqual(['install', 'update', 'chrome_update', 'shared_module_update'].map(shouldOpenOnboarding), [true, false, false, false]);
});

test('session: 登録できるドメインの近似', () => {
  assert.deepEqual(['www.jalan.net', 'ssl.jalan.net', 'acme.smarthr.jp', 'www.city.nerima.tokyo.jp', 'shop.example.co.jp'].map(siteOf),
    ['jalan.net', 'jalan.net', 'smarthr.jp', 'tokyo.jp', 'example.co.jp']);
});
