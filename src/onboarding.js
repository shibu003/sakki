// 偽の手続き（弱点 #1）。同意の欄は開示の一文そのもので、最初は外れている。迷わせる所は日付の選び直しの 1 か所だけ。
// 拡張のページには content script が入らないので、recorder.js はこのページが自分で読み込んでいる。
const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of ['s0', 's1', 's2']) $(s).hidden = s !== id; };
let picks = 0;

chrome.storage.local.get('consentedAt').then((r) => { $('consent').checked = !!r.consentedAt; });
$('consent').addEventListener('change', (e) => {
  if (e.target.checked) chrome.storage.local.set({ consentedAt: Date.now() });
  else chrome.storage.local.remove('consentedAt');
});

$('start').addEventListener('click', () => show('s1'));

// 最初に選んだ日は、どの日でも満席（必ず 1 回は選び直す）
$('day').addEventListener('change', (e) => {
  if (!e.target.value) return;
  picks++;
  $('full').hidden = picks > 1;
});

$('book').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('day').value || picks < 2) {
    $('full').hidden = false;
    return;
  }
  const ok = $('consent').checked;
  $('yes').hidden = !ok;
  $('no').hidden = ok;
  show('s2');
  if (ok) document.dispatchEvent(new Event('sakki:done')); // recorder が押した事象の後ろに並べて送る
});
