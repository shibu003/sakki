// 伏せる規則 1 本（弱点 #6）。記録する時に当て、伏せる物は最初から取らない。
// classic script: content script・偽の手続きのページ・node の test の 3 か所で読むので export を持たず、globalThis.sakki に載せる。
(function (g) {
  'use strict';
  const sakki = (g.sakki = g.sakki || {});

  const KANJI_NUM = '〇一二三四五六七八九十百千万億兆零';
  const SHAPES = [
    /[a-z0-9._%+\-]+@[a-z0-9\-]+(?:\.[a-z0-9\-]+)+/g,                  // メールの形
    /\d(?:[\d,.:\/\-]*\d)?/g,                                           // 数字（NFKC で全角も半角になっている）
    new RegExp(`[${KANJI_NUM}]{2,}|[${KANJI_NUM}](?=[年月日円件番号人歳時分秒回枚個階丁目])|(?<=第)[${KANJI_NUM}]`, 'g'), // 漢数字
    /(?<=令和|平成|昭和|大正|明治)元/g,                                   // 和暦の元年
  ];

  // 揃える: 1 文字ずつ NFKC → 小文字 → カタカナをひらがなへ、空白は落とす。at[i] = 揃えた i 文字目の元の位置
  function normalize(text) {
    let s = '';
    const at = [];
    let i = 0;
    for (const ch of String(text)) {
      const n = ch.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
        .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
      for (let k = 0; k < n.length; k++) at.push(i);
      s += n;
      i += ch.length;
    }
    return { s, at };
  }

  // seed 付きの 53bit hash（cyrb53）。ページをまたいで持ち越すのはこの値だけ。
  // ponytail: 短い値は辞書で戻せる。守るのは「記録を開いても平文が無い」まで。拡張のメモリを読める相手は防がない
  function hash(str, seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // 覚える集まりに入れる形（どれも文字列 1 つ）:
  //   'n<長さ>:<hash>' 名前の欄の値 — 長さを問わず、どこに出ても伏せる
  //   '3<hash>'        3 文字以上の値の 3 文字片 — 3 文字以上の一致で伏せる
  //   'x<hash>'        2 文字以下の値 — 文字がまるごと一致した時だけ伏せる
  function remember(value, opt) {
    const { seed, name } = opt;
    const v = normalize(value).s;
    if (!v) return [];
    if (name) return [`n${v.length}:${hash(v, seed)}`];
    if (v.length < 3) return [`x${hash(v, seed)}`];
    const out = [];
    for (let i = 0; i + 3 <= v.length; i++) out.push(`3${hash(v.slice(i, i + 3), seed)}`);
    return out;
  }

  // 伏せる: 覚える集まりに当たった所と、数字・メールの形を ■ にする（空白はそのまま残す）
  function mask(text, memo, seed) {
    text = String(text);
    const { s, at } = normalize(text);
    const hit = new Uint8Array(text.length);
    const cover = (from, to) => { for (let k = from; k < to; k++) hit[at[k]] = 1; };
    const has = (m) => (memo instanceof Set ? memo.has(m) : memo.includes(m));
    if (memo && (memo.size || memo.length)) {
      if (has(`x${hash(s, seed)}`)) cover(0, s.length);
      for (let i = 0; i + 3 <= s.length; i++) if (has(`3${hash(s.slice(i, i + 3), seed)}`)) cover(i, i + 3);
      const lens = new Set();
      for (const m of memo) if (m[0] === 'n') lens.add(+m.slice(1, m.indexOf(':')));
      for (const L of lens) {
        for (let i = 0; i + L <= s.length; i++) if (has(`n${L}:${hash(s.slice(i, i + L), seed)}`)) cover(i, i + L);
      }
    }
    for (const re of SHAPES) for (const m of s.matchAll(re)) cover(m.index, m.index + m[0].length);
    let out = '';
    let i = 0;
    for (const ch of text) {
      out += hit[i] && !/\s/.test(ch) ? '■' : ch;
      i += ch.length;
    }
    return out;
  }

  sakki.normalize = normalize;
  sakki.hash = hash;
  sakki.remember = remember;
  sakki.mask = mask;
})(globalThis);
