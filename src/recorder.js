// 骨組みだけを記録する（REQ-2・弱点 #5 #6 #7）。content script と偽の手続きのページの両方で読む classic script。
// 取るのは focus・click・input の瞬間だけ。最初の focus か click までは中身を送らない（読み込み時の ask は中身なし）。MutationObserver は持たない。
// 完了（REQ-4・図 1 の detect_completion）: 押した後と押して移った先だけ、決められるまで 4 回見る。渦があれば角にゴースト（REQ-5・show_ghost）。
(function () {
  'use strict';
  if (globalThis.__sakkiBooted || typeof document === 'undefined' || !globalThis.chrome?.storage) return;
  globalThis.__sakkiBooted = true; // scripting で差し直された時に二重に動かない
  const { mask, remember: toMemo } = globalThis.sakki;

  const MAX_ITEMS = 600;
  const MAX_NODES = 20000; // ponytail: 大きなページは先頭から 2 万要素まで。足りなければ見える範囲に絞る
  const SMALL = 24;
  const NAME_RE = /氏名|名前|姓|せい|めい|セイ|メイ|フリガナ|ふりがな|カナ|^名$|^名[（(]/;
  const NAME_AC = /^(name|family-name|given-name|additional-name|nickname|honorific-prefix|honorific-suffix)$/;
  const SEARCH_RE = /^(q|query|search|keyword|keywords|s|kw)$/i;
  const CHOICE_ROLES = /^(radio|option|tab|checkbox|switch|menuitemradio|menuitemcheckbox)$/;
  const FIELD_ROLES = /^(textbox|combobox|searchbox|spinbutton)$/;
  const MEDIA = new Set(['IMG', 'PICTURE', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'EMBED', 'OBJECT']);
  const NOT_FIELD_INPUTS = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'radio', 'checkbox', 'password']);
  const FIELD_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea';
  const WAITS = [1000, 2000, 5000, 8000]; // 完了を見る間（押してから 1・3・8・16 秒）
  const GHOST = { w: 148, h: 52, edge: 16 }; // 角に置く枠の大きさと端からの距離
  const HANDS = ['pointerdown', 'wheel', 'keydown', 'beforeprint']; // 手が動いた（サイトが呼ぶ scroll は入れない）

  let mode = 'idle';     // idle（同意の前・止まった）→ record_session ⇄ detect_completion（完了を見ている）→ show_ghost（角に居る）
  let ctx = null;        // hello の返事: { take, noText, seed, memo:Set }
  let queue = Promise.resolve();
  let lastHeading = null;
  let pendingMemo = [];
  let pendingInput = null; // 入力は回数だけ溜める（値は溜めない）
  let shownAt = 0;         // 隠れた後に見えるようになった時刻。次の事象に vis で付ける（隠れていた時間を停止と数えない）
  const lastPressed = new WeakMap(); // form → submit の前に最後に押した submit でない物の名前
  let detectTimer = null;
  let ghostEl = null;
  let ghostTab = null;

  const shadowOf = (el) => el.shadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) || null;
  const text = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const role = (el) => (el.getAttribute('role') || '').toLowerCase();
  const tag = (el) => el.tagName.toUpperCase();

  // header・footer は、article・aside・main・nav・section の中に無い時だけ帯（HTML-AAM の banner / contentinfo と同じ）
  function inBand(el) {
    const r = role(el);
    if (r === 'banner' || r === 'navigation' || r === 'contentinfo' || tag(el) === 'NAV') return true;
    if (tag(el) !== 'HEADER' && tag(el) !== 'FOOTER') return false;
    return !el.parentElement?.closest('article,aside,main,nav,section');
  }
  function isMedia(el) {
    return MEDIA.has(tag(el));
  }
  function isChoiceEl(el) {
    if (tag(el) === 'OPTION') return true;
    if (tag(el) === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) return true;
    return CHOICE_ROLES.test(role(el)) || el.hasAttribute('aria-pressed') || el.hasAttribute('aria-checked') || el.hasAttribute('aria-selected');
  }
  function isField(el) {
    const t = tag(el);
    if (t === 'INPUT') return !NOT_FIELD_INPUTS.has(el.type);
    if (t === 'TEXTAREA' || t === 'SELECT') return true;
    return el.isContentEditable && !el.parentElement?.isContentEditable || FIELD_ROLES.test(role(el));
  }
  function isButton(el) {
    const t = tag(el);
    if (t === 'BUTTON' || t === 'SUMMARY') return true;
    if (t === 'INPUT') return ['submit', 'button', 'reset', 'image'].includes(el.type);
    return role(el) === 'button';
  }
  const isSubmit = (el) => (tag(el) === 'BUTTON' && (el.type || 'submit') === 'submit' && !!el.form) || (tag(el) === 'INPUT' && (el.type === 'submit' || el.type === 'image'));

  // 見出し・欄・ボタン・選べる物のどれか（どれでもなければ null = 取らずに中へ歩く）
  function kindOf(el) {
    if (/^H[1-6]$/.test(tag(el)) || role(el) === 'heading') return 'heading';
    if (isChoiceEl(el)) return 'choice';
    if (isField(el)) return 'field';
    if (isButton(el)) return 'button';
    return null;
  }

  // 見出しの文字（中の画像は alt）
  function headingText(el) {
    let s = '';
    const walkText = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1) { if (tag(c) === 'IMG') s += ' ' + (c.alt || '') + ' '; else walkText(c); }
      }
    };
    walkText(el);
    return text(s);
  }
  // label の文字。中に入れた select の選択肢・textarea の初めの文字は値なので混ぜない（PBI-0006）
  function labelText(el) {
    let s = '';
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (!n.parentElement?.closest('select,textarea,datalist')) s += n.nodeValue;
    return s;
  }
  function fieldName(el) {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const s = text(by.split(/\s+/).map((id) => { const l = root.getElementById?.(id) || document.getElementById(id); return l ? labelText(l) : ''; }).join(' '));
      if (s) return s;
    }
    if (el.getAttribute('aria-label')) return text(el.getAttribute('aria-label'));
    const wrap = el.closest('label');
    const byLabel = text(el.labels && el.labels.length ? [...el.labels].map(labelText).join(' ') : wrap ? labelText(wrap) : '');
    if (byLabel) return byLabel;
    return text(el.getAttribute('placeholder') || el.getAttribute('title') || '');
  }
  function buttonName(el) {
    if (el.getAttribute('aria-label')) return text(el.getAttribute('aria-label'));
    if (tag(el) === 'INPUT') return text(el.value || el.alt || '');
    return text(el.textContent);
  }
  const isNameField = (el) => NAME_AC.test(el.getAttribute('autocomplete') || '') || NAME_RE.test(fieldName(el));
  const isSearchField = (el) => el.type === 'search' || role(el) === 'searchbox' || SEARCH_RE.test(el.name || '') || !!el.closest('[role=search],search');
  const isPick = (el) => tag(el) === 'SELECT' || isChoiceEl(el); // 選び直しを数える欄（文字の欄は打つ速さで input が割れる）
  const nameOf = (el) => (ctx.noText ? undefined : mask(fieldName(el), ctx.memo, ctx.seed) || undefined); // 欄の名前（同じ欄を名前と位置で見分ける）
  const visible = (el) => !el.checkVisibility || el.checkVisibility({ visibilityProperty: true });

  // ---- 完了の合図（図 1 の detect_completion）----
  // 押した form: form、無ければ欄を持つ一番近い祖先
  function formOf(el) {
    const f = el.form || el.closest('form');
    if (f) return f;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) if (n.querySelector(FIELD_SEL)) return n;
    return null;
  }
  const inSearch = (el) => !!el.closest('[role=search],search') || [...(el.form?.elements || [])].some((f) => tag(f) === 'INPUT' && isSearchField(f));
  // 主なボタン: submit か、欄の隣のボタン。帯の中・検索の form・選べる物は除く
  function isPress(el) {
    if (!isButton(el) || tag(el) === 'SUMMARY' || isChoiceEl(el) || inSearch(el)) return false;
    for (let n = el; n; n = n.parentElement) if (inBand(n)) return false;
    return isSubmit(el) || !!formOf(el);
  }
  const isDownload = (el) => {
    if (tag(el) !== 'A') return false;
    try { return el.hasAttribute('download') || /\.pdf$/i.test(new URL(el.getAttribute('href') || '', location.href).pathname); } catch { return false; }
  };
  // main に押せる送信ボタンが残っている（確認画面・入力画面）。disabled のアンケートは数えない
  function submitLeft() {
    let left = false;
    forEachElement(document.querySelector('main,[role=main]') || document.body, (el) => {
      if (left || !visible(el) || inBand(el)) return 'skip';
      if (isPress(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') left = true;
      return null;
    });
    return left;
  }
  const judge = () => (submitLeft() ? 'weak' : 'strong');
  const gone = (form) => !form.isConnected || !visible(form);

  // 決められるまで WAITS の間で見る（ponytail: 見回りはこの 4 回まで。足りない SPA は次の読み込みの ask で拾う）
  function detect(ready) {
    clearTimeout(detectTimer);
    mode = 'detect_completion';
    const waits = [...WAITS];
    const step = () => {
      if (mode !== 'detect_completion') return;
      if (ready(!waits.length)) return signal(judge());
      if (waits.length) detectTimer = setTimeout(step, waits.shift());
      else mode = 'record_session';
    };
    detectTimer = setTimeout(step, waits.shift());
  }
  // ① 押した後: 押した form が消えているのを 2 回続けて見たら（読み込み中の一瞬の消えでは立てない）
  function watchPress(form) {
    let seen = 0;
    detect(() => (seen = gone(form) ? seen + 1 : 0) >= 2);
  }
  // SW に判定してよいか聞く（中身なし）: arrive = 押して移った先・pdf = PDF の画面・print = 印刷した
  function ask(why) {
    enqueue(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'ask', why });
      if (!r?.check || mode === 'idle') return;
      if (why === 'arrive') detect((last) => last || !!firstHeading());
      else signal(judge());
    });
  }
  function signal(level) {
    mode = 'record_session';
    record(() => ({ type: 'done', level }), (r) => { if (r?.ghost) showGhost(r.tab); });
  }

  // ---- 角で待つゴースト（図 1 の show_ghost）。枠は拡張のページ = サイトの文書に記録は入らない ----
  // 右下 → 左下 → 右上 → 左上の順に、固定の要素・文字・欄・ボタン・リンク・画像の箱と重ならない角を 1 回だけ選ぶ
  function freeCorner() {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const { w, h, edge } = GHOST;
    const tiny = vw < w + 2 * edge || vh < h + 2 * edge;
    const spots = [['bottom', 'right'], ['bottom', 'left'], ['top', 'right'], ['top', 'left']]
      .map(([v, side]) => ({ v, side, x: side === 'left' ? edge : vw - edge - w, y: v === 'top' ? edge : vh - edge - h, busy: tiny }));
    const block = (r) => {
      if (r.width <= 0 || r.height <= 0) return;
      for (const s of spots) if (r.left < s.x + w && r.right > s.x && r.top < s.y + h && r.bottom > s.y) s.busy = true;
    };
    const range = document.createRange();
    forEachElement(document, (el) => {
      if (spots.every((s) => s.busy) || !visible(el)) return 'skip';
      const pos = getComputedStyle(el).position;
      const k = kindOf(el);
      if (pos === 'fixed' || pos === 'sticky' || isMedia(el) || (k && k !== 'heading') || tag(el) === 'A') block(el.getBoundingClientRect());
      for (const c of el.childNodes) {
        if (c.nodeType !== 3 || !c.nodeValue.trim()) continue;
        range.selectNodeContents(c);
        for (const r of range.getClientRects()) block(r);
      }
      return null;
    });
    return spots.find((s) => !s.busy) || null;
  }
  function showGhost(tab) {
    if (ghostEl) return;
    const at = freeCorner();
    if (!at) return; // 4 つの角が塞がっている → 出さない（右クリックで呼べる）
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('ghost.html'); // ponytail: 固定の URL = サイトが拡張の在否を probe できる。use_dynamic_url が iframe で動くと確かめたら替える
    f.title = 'さっきの私';
    const css = {
      position: 'fixed', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', [at.v]: `${GHOST.edge}px`, [at.side]: `${GHOST.edge}px`,
      width: `${GHOST.w}px`, height: `${GHOST.h}px`, 'max-width': 'none', 'max-height': 'none', margin: '0', padding: '0', border: '0',
      display: 'block', visibility: 'visible', opacity: '1', transform: 'none', 'pointer-events': 'auto',
      background: 'transparent', 'color-scheme': 'light', 'z-index': '2147483647',
    };
    for (const [k, v] of Object.entries(css)) f.style.setProperty(k, v, 'important'); // サイトの iframe{display:none!important} に負けない
    document.documentElement.appendChild(f);
    ghostEl = f;
    ghostTab = tab;
    mode = 'show_ghost';
    for (const t of HANDS) addEventListener(t, hideGhost, true);
  }
  // 引っ込む: 手が動いた・side panel が開いた。同じページで出し直さない（呼び戻すのはアイコンか右クリック）
  function hideGhost() {
    if (!ghostEl) return;
    ghostEl.remove();
    ghostEl = null;
    for (const t of HANDS) removeEventListener(t, hideGhost, true);
    if (mode === 'show_ghost') mode = 'record_session';
  }

  const hasValue = (el) => (tag(el) === 'SELECT' ? el.value !== '' : el.isContentEditable ? !!text(el.textContent) : !!el.value);

  // ---- 覚える集まり ----
  function remember(value, name) {
    const v = text(value);
    if (!v) return;
    const parts = name ? [v, ...v.split(/[\s　]+/)] : [v];
    for (const p of parts) {
      for (const m of toMemo(p, { seed: ctx.seed, name })) if (!ctx.memo.has(m)) { ctx.memo.add(m); pendingMemo.push(m); }
    }
  }
  // 今のページの値を全部集まりへ入れる（骨組みの文字を取る前に必ず呼ぶ）
  function collectValues() {
    const names = [];
    forEachElement(document, (el) => {
      if (inBand(el)) bandTexts(el); // 帯の中の欄の値も入れるので、中へは降りる
      const t = tag(el);
      if (isField(el) && hasValue(el)) {
        const v = t === 'SELECT' ? el.options[el.selectedIndex]?.text : el.isContentEditable ? el.textContent : el.value;
        const name = t !== 'SELECT' && isNameField(el);
        remember(v, name);
        if (name) names.push(text(v));
      }
      if (t === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox') && el.checked) remember(fieldName(el), false);
      if (/^(true|mixed)$/.test(el.getAttribute('aria-pressed') || el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || '')) remember(el.textContent, false);
      return null;
    });
    for (let i = 0; i + 1 < names.length; i++) { remember(names[i] + names[i + 1], true); remember(names[i + 1] + names[i], true); } // 姓と名をつないだ形
  }
  // header・nav のリンクでない文字（ユーザー名など）を集まりへ。リンク（メニュー）は入れない
  function bandTexts(band) {
    if (tag(band) === 'FOOTER' || role(band) === 'contentinfo') return;
    const tw = document.createTreeWalker(band, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (n.parentElement?.closest('a')) continue;
      remember(n.nodeValue, false);
    }
  }

  // 要素を順に歩く（開いた・閉じた shadow root にも降りる）。fn が 'skip' を返したら中へは降りない
  function forEachElement(root, fn) {
    const stack = [root];
    let seen = 0;
    while (stack.length && seen < MAX_NODES) {
      const node = stack.pop();
      const kids = node.children ? [...node.children] : [];
      for (let i = kids.length - 1; i >= 0; i--) {
        const el = kids[i];
        seen++;
        if (fn(el) === 'skip') continue;
        const sr = shadowOf(el);
        if (sr) stack.push(sr);
        stack.push(el);
      }
    }
  }

  // ---- 骨組み（docs/diagrams.md 図 3）----
  function walk() {
    const items = [];
    const pushItem = (k, el, s, extra) => {
      if (items.length >= MAX_ITEMS) return;
      const r = rectOf(el);
      if (r.w < 1 || r.h < 1) return;
      const it = { k, ...r };
      if (s && !ctx.noText) it.s = mask(s, ctx.memo, ctx.seed);   // noText = 社内の束: 文字なし
      Object.assign(it, extra);
      items.push(it);
    };
    forEachElement(document, (el) => {
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return 'skip';
      if (inBand(el)) { pushItem('band', el); return 'skip'; }
      if (isMedia(el)) {
        const r = el.getBoundingClientRect();
        if (r.width >= SMALL && r.height >= SMALL) pushItem('media', el);
        return 'skip';
      }
      const k = kindOf(el);
      if (!k) return null;
      if (k === 'heading') pushItem('heading', el, headingText(el));
      else if (k === 'field') pushItem('field', el, fieldName(el), hasValue(el) ? { v: 1 } : undefined);
      else if (k === 'button') pushItem('button', el, buttonName(el), isSubmit(el) ? { sub: 1 } : undefined);
      else pushItem('choice', el);   // choice: 箱だけ。名前を取らない
      return 'skip';
    });
    return items;
  }

  // 見えている最初の見出し（隠した画面を DOM に残す SPA では、DOM の順の最初は隠れている事がある）
  const firstHeading = () => {
    for (const h of document.querySelectorAll('h1,h2,[role=heading]')) {
      if (!h.checkVisibility || h.checkVisibility({ visibilityProperty: true })) return headingText(h);
    }
    return '';
  };
  function siteColor() {
    const b = document.querySelector('button[type=submit],input[type=submit],button:not([type])');
    const c = b && getComputedStyle(b).backgroundColor;
    return c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c) ? c : null;
  }

  // ---- 送る ----
  function send(msg) {
    if (pendingMemo.length) { msg.memo = pendingMemo; pendingMemo = []; }
    return chrome.runtime.sendMessage(msg);
  }
  function stop() {
    mode = 'idle';
    for (const [type, fn] of LISTENERS) document.removeEventListener(type, fn, true);
    removeEventListener('pageshow', onPageShow);
    removeEventListener('afterprint', onPrinted);
    clearTimeout(detectTimer);
    hideGhost();
    if (pendingInput) clearTimeout(pendingInput.timer);
    pendingInput = null;
    pendingMemo = [];
  }

  async function ensureReady() {
    if (ctx) return true;
    const r = await chrome.runtime.sendMessage({ type: 'hello', since: Math.round(performance.timeOrigin) });
    if (!r || !r.take) { stop(); return false; } // よそのサイト（本拠の外）: 中身を取らない
    ctx = { ...r, memo: new Set(r.memo || []) };
    return true;
  }
  // 見出しが替わっていたら骨組みを取る（その瞬間の画面で、同期で）
  function snapshotIfNeeded(out) {
    const h = firstHeading();
    if (lastHeading !== null && h === lastHeading) return;
    lastHeading = h;
    collectValues();
    out.push({
      type: 'page', vw: innerWidth, vh: innerHeight,
      dh: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0), c: siteColor(), items: walk(),
    });
  }
  // 溜めていた入力を listener の中で同期に切り離す（hello を待つ間に次の欄の入力で上書きされない）
  function detachInput() {
    const pend = pendingInput;
    if (!pend) return null;
    pendingInput = null;
    clearTimeout(pend.timer);
    return pend;
  }
  function takeInput(out, pend) {
    if (!pend) return;
    collectValues();
    const el = pend.el;
    out.push({
      type: 'ev', k: 'input', ...pend.box, n: pend.n, search: isSearchField(el) || undefined,
      p: isPick(el) ? 1 : undefined, s: isField(el) ? nameOf(el) : undefined, // 選べる物（radio 等）は名前を取らない
    });
  }
  function enqueue(job) {
    queue = queue.then(job).catch(() => stop()); // 文脈が切れた（拡張の再読み込み）→ 止まる。何も溜めない
  }
  // 事象を記録する: 測るのは listener の中（同期）、送るのは順に。最初の 1 回だけ hello の返事を待ってから測る。then は最後の返事を受ける
  function record(build, then) {
    const pend = detachInput();
    const capture = () => {
      const out = [];
      if (lastHeading === null) snapshotIfNeeded(out); // この文書の最初の事象: 入力より先にページ（無いと reducer が入力を捨てる）
      takeInput(out, pend);
      snapshotIfNeeded(out);
      const ev = build();
      if (ev?.type === 'ev' && shownAt) { ev.vis = shownAt; shownAt = 0; }
      if (ev) out.push(ev);
      return out;
    };
    const flush = async (msgs) => {
      let r;
      for (const m of msgs) r = await send(m);
      then?.(r);
    };
    if (ctx) { const msgs = capture(); enqueue(() => flush(msgs)); return; }
    enqueue(async () => { if (await ensureReady()) await flush(capture()); });
  }

  // 閉じた shadow root の中の事象は document では host に見えるので、root の activeElement / elementFromPoint で中へ辿る
  function deepTarget(e) {
    let t = e.composedPath()[0];
    for (let i = 0; i < 16 && t && t.nodeType === 1; i++) {
      const r = shadowOf(t);
      if (!r) break;
      const inner = e.type === 'click' ? r.elementFromPoint(e.clientX, e.clientY) : r.activeElement;
      if (!inner || inner === t) break;
      t = inner;
    }
    return t && t.nodeType === 1 ? t : null;
  }
  const interactive = (el) => {
    for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
      if (n.nodeType !== 1) continue;
      if (isButton(n) || isField(n) || isChoiceEl(n) || ['A', 'LABEL', 'SELECT'].includes(tag(n))) return n;
    }
    return null;
  };

  function onFocus(e) {
    const el = deepTarget(e);
    if (!el || !isField(el)) return;
    const box = rectOf(el);
    record(() => ({ type: 'ev', k: 'focus', ...box, s: nameOf(el) }));
  }
  function onClick(e) {
    const raw = deepTarget(e);
    if (!raw) return;
    const el = interactive(raw);
    const form = el?.closest?.('form');
    if (el && form && isButton(el)) {
      if (isSubmit(el)) { const last = lastPressed.get(form); if (last && ctx) remember(last, false); }
      else lastPressed.set(form, buttonName(el));
    }
    const box = el ? rectOf(el) : { x: Math.round(e.clientX + scrollX) - 8, y: Math.round(e.clientY + scrollY) - 8, w: 16, h: 16 };
    const name = el && isSubmit(el) ? buttonName(el) : '';
    const press = !!el && isPress(el);
    record(() => ({ type: 'ev', k: 'click', ...box, s: name && !ctx.noText ? mask(name, ctx.memo, ctx.seed) : undefined, pr: press ? 1 : undefined }));
    if (press) watchPress(formOf(el));             // ① 押した form が消えるか
    else if (el && isDownload(el)) signal(judge()); // ② 控えのダウンロード・PDF
  }
  // 入力は回数だけ溜める（値は溜めない）。同じ欄の続きは数えるだけ、欄が替わるか 0.8 秒止まったら送る
  function onInput(e) {
    const el = deepTarget(e);
    if (!el || !(isField(el) || isChoiceEl(el))) return;
    if (pendingInput && pendingInput.el === el) { pendingInput.n++; return; }
    record(() => null); // 前の欄の分を送る
    const p = (pendingInput = { el, n: 1, box: rectOf(el) });
    p.timer = setTimeout(() => { if (pendingInput === p) record(() => null); }, 800);
  }
  function onSubmit(e) {
    const last = lastPressed.get(e.target);
    if (last && ctx) remember(last, false);
  }
  function onVisible() {
    if (document.visibilityState === 'visible') shownAt = Date.now();
  }
  // 戻るボタン（bfcache）: 同じ recorder が同じ見出しのまま再開するので、次の事象で骨組みを取り直す
  function onPageShow(e) {
    if (!e.persisted) return;
    lastHeading = null;
    shownAt = Date.now();
  }
  const onPrinted = () => ask('print'); // ③ 印刷の窓が閉じた後（前に出すと控えに写る）
  const LISTENERS = [['focusin', onFocus], ['click', onClick], ['input', onInput], ['submit', onSubmit], ['visibilitychange', onVisible]];

  function start() {
    if (mode !== 'idle') return;
    mode = 'record_session';
    for (const [type, fn] of LISTENERS) document.addEventListener(type, fn, true);
    addEventListener('pageshow', onPageShow);
    addEventListener('afterprint', onPrinted);
    ask(document.contentType === 'application/pdf' ? 'pdf' : 'arrive'); // 押して移った先か、PDF の画面か
  }

  // side panel が開いた・ゴーストが押された（SW から。偽の手続きのページには全体宛に tab 付きで来る）
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === 'ghost_hide' && (m.tab == null || m.tab === ghostTab)) hideGhost();
  });

  // 同意の前は何も読まない・何も送らない。同意の欄が押されたら、その瞬間から録る
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.consentedAt) return;
    if (ch.consentedAt.newValue) start();
    else { stop(); ctx = null; lastHeading = null; }
  });
  chrome.storage.local.get('consentedAt').then((r) => { if (r.consentedAt) start(); }, () => {});
})();
