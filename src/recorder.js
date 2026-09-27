// 骨組みだけを記録する（REQ-2・弱点 #5 #6 #7）。content script と偽の手続きのページの両方で読む classic script。
// 取るのは focus・click・input の瞬間だけ。最初の focus か click までは何も送らない。MutationObserver もタイマーの見回りも持たない。
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

  let mode = 'idle';     // idle（同意の前・止まった）→ record_session
  let ctx = null;        // hello の返事: { take, noText, seed, memo:Set }
  let queue = Promise.resolve();
  let lastHeading = null;
  let pendingMemo = [];
  let pendingInput = null; // 入力は回数だけ溜める（値は溜めない）
  const lastPressed = new WeakMap(); // form → submit の前に最後に押した submit でない物の名前

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
  function takeInput(out) {
    const p = pendingInput;
    if (!p) return;
    pendingInput = null;
    clearTimeout(p.timer);
    collectValues();
    out.push({ type: 'ev', k: 'input', ...p.box, n: p.n, search: isSearchField(p.el) || undefined });
  }
  function enqueue(job) {
    queue = queue.then(job).catch(() => stop()); // 文脈が切れた（拡張の再読み込み）→ 止まる。何も溜めない
  }
  // 事象を記録する: 測るのは listener の中（同期）、送るのは順に。最初の 1 回だけ hello の返事を待ってから測る
  function record(build) {
    const capture = () => {
      const out = [];
      takeInput(out);
      snapshotIfNeeded(out);
      const ev = build();
      if (ev) out.push(ev);
      return out;
    };
    const flush = async (msgs) => { for (const m of msgs) await send(m); };
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
    record(() => ({ type: 'ev', k: 'focus', ...box }));
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
    record(() => ({ type: 'ev', k: 'click', ...box, s: name && !ctx.noText ? mask(name, ctx.memo, ctx.seed) : undefined }));
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
  const LISTENERS = [['focusin', onFocus], ['click', onClick], ['input', onInput], ['submit', onSubmit]];

  function start() {
    if (mode === 'record_session') return;
    mode = 'record_session';
    for (const [type, fn] of LISTENERS) document.addEventListener(type, fn, true);
  }

  // 偽の手続きの完了（拡張自身のページだけ）: 押した事象の後に、完了の画面の骨組みを取ってから閉じる
  if (location.protocol === 'chrome-extension:') {
    document.addEventListener('sakki:done', () => { if (mode === 'record_session') record(() => ({ type: 'done' })); });
  }

  // 同意の前は何も読まない・何も送らない。同意の欄が押されたら、その瞬間から録る
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.consentedAt) return;
    if (ch.consentedAt.newValue) start();
    else { stop(); ctx = null; lastHeading = null; }
  });
  chrome.storage.local.get('consentedAt').then((r) => { if (r.consentedAt) start(); }, () => {});
})();
