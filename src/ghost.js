// 角で待つゴーストの枠（拡張のページ。サイトの文書からは中が読めない）。押すと side panel を開き、開けたら SW に知らせる（SW が枠を外す）
let open = null; // sidePanel.open の引数。user gesture の中で待たずに呼ぶため、読み込み時に決めておく
Promise.all([chrome.tabs.getCurrent(), chrome.windows.getCurrent()]).then(([t, w]) => {
  open = t ? { tabId: t.id } : { windowId: w.id };
}, () => {});

document.getElementById('g').addEventListener('click', () => {
  if (!open) return;
  chrome.sidePanel.open(open).then(() => chrome.runtime.sendMessage({ type: 'ghost_pressed', tab: open.tabId }), () => {}); // 開けなければ枠は残る
});
