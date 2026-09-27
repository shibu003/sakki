// SW。メッセージを session.js の reducer に通し、chrome.storage.session（メモリだけ）に 1 key で置く。外へ送る経路は持たない。
import { reduce, initialState, takeReply, sessionFor, shrink, shouldOpenOnboarding } from './session.js';

const OWN = chrome.runtime.getURL('');
let state = initialState();
let consent = false; // 同意の欄の状態（storage.local の consentedAt をメモリに写す）
const ready = Promise.all([
  chrome.storage.session.get('state').then((r) => { if (r.state) state = r.state; }, () => {}),
  chrome.storage.local.get('consentedAt').then((r) => { consent = !!r.consentedAt; }, () => {}),
]);
let saveTimer = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); // 入口はアイコン → side panel だけ

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (shouldOpenOnboarding(reason)) chrome.tabs.create({ url: 'onboarding.html' }); // 偽の手続き（同意の欄はこの中）
});

function apply(msg) {
  const [next, reply] = takeReply(reduce(state, { t: Date.now(), ...msg }));
  state = next;
  save();
  return reply;
}

// 200ms まとめて丸ごと set（1 key なので半端な書き込みは起きない）。上限に当たったら古いページから捨てて入れ直す
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    for (let i = 0; i < 1000; i++) {
      try { await chrome.storage.session.set({ state }); return; } catch { state = shrink(state); }
    }
  }, 200);
}

// パスとクエリはここで捨てる（ホスト名だけ reducer へ渡す）
function hostOf(url) {
  if (!url) return '';
  if (url.startsWith(OWN)) return 'sakki';
  try { return new URL(url).hostname; } catch { return ''; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await ready;
    if (msg.type === 'get') {
      apply({ type: 'tick' });
      return { consented: consent, session: sessionFor(state, msg.tab) };
    }
    if (!sender.tab || !consent) return null; // 同意の前は何も受けない
    const own = sender.url?.startsWith(OWN) || undefined;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    return apply({ ...msg, tab: sender.tab.id, host: hostOf(sender.url), own, seed }) ?? null;
  })().then(reply, () => reply(null));
  return true;
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  apply({ type: 'tab_created', tab: tab.id, opener: tab.openerTabId, url: tab.pendingUrl || tab.url });
});
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  apply({ type: 'tab_removed', tab: tabId });
});

// 同意の欄を外した → 記録を全部消す。押した → 入れる前から開いていたタブにも recorder を差す
chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== 'local' || !ch.consentedAt) return;
  await ready;
  consent = !!ch.consentedAt.newValue;
  if (!consent) {
    state = reduce(state, { type: 'revoke', t: Date.now() });
    clearTimeout(saveTimer);
    await chrome.storage.session.set({ state });
    return;
  }
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/redact.js', 'src/recorder.js'] }).catch(() => {});
  }
});
