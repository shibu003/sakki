// SW。メッセージを session.js の reducer に通し、chrome.storage.session（メモリだけ）に 1 key で置く。外へ送る経路は持たない。
import { reduce, initialState, takeReply, sessionFor, shrink, shouldOpenOnboarding, callable } from './session.js';

const OWN = chrome.runtime.getURL('');
let state = initialState();
let consent = false; // 同意の欄の状態（storage.local の consentedAt をメモリに写す）
const ready = Promise.all([
  chrome.storage.session.get('state').then((r) => { if (r.state) state = r.state; }, () => {}),
  chrome.storage.local.get('consentedAt').then((r) => { consent = !!r.consentedAt; }, () => {}),
]);
let saveTimer = null;
const MENU = 'call_menu'; // 右クリックの「さっきの自分を呼ぶ」（合図の来た束のタブでだけ見える）

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); // 入口はアイコン → side panel だけ

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (shouldOpenOnboarding(reason)) chrome.tabs.create({ url: 'onboarding.html' }); // 偽の手続き（同意の欄はこの中）
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU, title: 'さっきの自分を呼ぶ', contexts: ['page', 'frame', 'selection', 'link', 'editable', 'image'], visible: false }, () => void chrome.runtime.lastError);
    syncMenu();
  });
});

// 右クリックの項目は、今のタブ（tabId が無ければ最後に focus した窓の今のタブ）の束が呼べる時だけ見せる。
// ponytail: 項目は全部の窓で 1 つ。窓が 2 つ以上なら focus が移るたびに合わせ直す
async function syncMenu(tabId) {
  await ready;
  if (tabId == null) tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0]?.id;
  chrome.contextMenus.update(MENU, { visible: tabId != null && callable(state, tabId) }, () => void chrome.runtime.lastError);
}
chrome.tabs.onActivated.addListener(({ tabId }) => syncMenu(tabId));
chrome.windows.onFocusChanged.addListener(() => syncMenu());
// onClicked は user gesture の中なので、待たずに開く
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU && tab?.id >= 0) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ゴーストを引っ込める: content script へはタブ宛、偽の手続き（拡張のページ）へは全体宛に tab を付けて
function hideGhost(tab) {
  if (tab == null) return;
  chrome.tabs.sendMessage(tab, { type: 'ghost_hide', tab }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'ghost_hide', tab }).catch(() => {});
}

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
      hideGhost(msg.tab); // side panel が開いた → そのタブのゴーストは引っ込む
      return { consented: consent, session: sessionFor(state, msg.tab) };
    }
    if (msg.type === 'ghost_pressed') { // ゴーストの枠が side panel を開けた
      hideGhost(sender.tab?.id ?? msg.tab);
      return null;
    }
    if (!sender.tab || !consent) return null; // 同意の前は何も受けない
    const own = sender.url?.startsWith(OWN) || undefined;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const reply = apply({ ...msg, tab: sender.tab.id, host: hostOf(sender.url), own, seed }) ?? null;
    if ((msg.type === 'done' || msg.type === 'hello') && sender.tab.active) syncMenu(sender.tab.id);
    return reply;
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
  syncMenu();
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
    syncMenu();
    return;
  }
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/redact.js', 'src/recorder.js'] }).catch(() => {});
  }
});
