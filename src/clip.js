// 動画の書き出し（PBI-0005・docs/diagrams.md 図 5）。再生と同じ frame() を縦長の枠で呼び、写しの絵の上に paint を重ねて WebCodecs で MP4 にする。
// 外へは何も送らない。読むのは写しに在る資源（画像・CSS）の GET だけ（再生の iframe が読んだ物を HTTP cache から）
import { timeline, frame, paint, captions, fitText } from './replay.js';
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer.mjs';

export const VIEW = { w: 360, h: 640 }; // 縦長の枠（再生の座標）。動画はこの K 倍
const K = 2;
const W = VIEW.w * K, H = VIEW.h * K;
const FPS = 30;
export const INTRO = 1500; // 冒頭: t=0 の frame ＋焼き込み（1 枚目がチャットのサムネになる）
export const OUTRO = 2000; // 最後: 完了の画面の写しの上端（無ければ最後の frame）＋焼き込み
// H.264 Main 4.0 → Baseline 3.1（720×1280@30 は 3.1 の上限ちょうど）→ VP9
const CODECS = ['avc1.4d0028', 'avc1.42001f', 'vp09.00.10.08'];
const KEY_EVERY = 2 * FPS; // シークのため 2 秒ごとに keyframe
const FONT = '"Hiragino Sans", "Noto Sans JP", system-ui, sans-serif';
const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/g;
const XHTML = 'http://www.w3.org/1999/xhtml';
const XML_ATTR = /^([A-Za-z_][\w.-]*|(xlink|xml|xmlns):[A-Za-z_][\w.-]*)$/; // SVG の要素に残せる属性の名前

// CSS の url() を data: に（get は 絶対 URL → data: か null）。data:・blob:・# は触らない。取れない URL は元のまま（SVG の画像の中では読まれず、映らないだけ）
export async function inlineCss(css, base, get) {
  const got = new Map();
  for (const [, , u] of css.matchAll(URL_RE)) {
    if (!u || /^(data:|blob:|#)/i.test(u) || got.has(u)) continue;
    let abs;
    try { abs = new URL(u, base).href; } catch { continue; }
    got.set(u, get(abs));
  }
  for (const [u, p] of got) got.set(u, await p);
  return css.replace(URL_RE, (m, q, u) => (got.get(u) ? `url("${got.get(u)}")` : m));
}

const configOf = (codec) => ({ codec, width: W, height: H, bitrate: 2e6, framerate: FPS, ...(codec.startsWith('avc1') ? { avc: { format: 'avc' } } : {}) });
async function pickCodec() {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const c of CODECS) if ((await VideoEncoder.isConfigSupported(configOf(c)).catch(() => null))?.supported) return c;
  return null;
}

// URL ごとに 1 回だけ読む（data: か文字）
function fetcher() {
  const memo = new Map();
  const once = (key, u, read) => {
    if (!memo.has(key)) memo.set(key, fetch(u, { cache: 'force-cache' }).then((r) => (r.ok ? read(r) : null)).catch(() => null));
    return memo.get(key);
  };
  const asData = (r) => r.blob().then((b) => new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res(null);
    fr.readAsDataURL(b);
  }));
  return { data: (u) => once(`d ${u}`, u, asData), text: (u) => once(`t ${u}`, u, (r) => r.text()) };
}

// 写し（既に伏せてある HTML）を絵にする: 外の資源を data: に直し、XHTML にして SVG の foreignObject → ImageBitmap。
// ponytail: declarative shadow DOM は XML の中では建たないので、閉じた shadow root の中は映らない（再生の iframe には映る）
export async function raster(page, get) {
  const doc = new DOMParser().parseFromString(page.dom, 'text/html');
  const jobs = [];
  const setData = (el, attr) => {
    const u = el.getAttribute(attr);
    if (u && !/^(data:|#)/i.test(u)) jobs.push(get.data(u).then((d) => d && el.setAttribute(attr, d)));
  };
  for (const el of doc.querySelectorAll('img[src], input[src]')) setData(el, 'src');
  for (const el of doc.querySelectorAll('image')) { setData(el, 'href'); setData(el, 'xlink:href'); }
  for (const el of doc.querySelectorAll('[style*="url("]')) jobs.push(inlineCss(el.getAttribute('style'), el.baseURI, get.data).then((c) => el.setAttribute('style', c)));
  for (const el of doc.querySelectorAll('style')) jobs.push(inlineCss(el.textContent, el.baseURI, get.data).then((c) => { el.textContent = c; }));
  for (const el of doc.querySelectorAll('link[rel~="stylesheet" i][href]')) { // 記録の時に読めなかった（よそのサイトの）stylesheet
    jobs.push(get.text(el.href).then(async (css) => {
      if (css == null) return el.remove();
      const st = doc.createElement('style');
      if (el.media) st.media = el.media;
      st.textContent = await inlineCss(css, el.href, get.data);
      el.replaceWith(st);
    }));
  }
  await Promise.all(jobs);
  // XML にならない物は 1 つでも在ると SVG ごと読めなくなる: x-on:click・@click・:class などの属性、HTML の要素の xmlns・xlink:（XMLSerializer が自分で書く・宣言が無い）、
  // Word の <o:p> のような : の在る要素、XML 1.0 に無い制御文字
  for (const el of doc.querySelectorAll('*')) {
    const html = el.namespaceURI === XHTML;
    for (const { name } of [...el.attributes]) if (!(html ? (/^[A-Za-z_][\w.-]*$/.test(name) && name !== 'xmlns') || /^xml:[a-z]+$/.test(name) : XML_ATTR.test(name))) el.removeAttribute(name);
    if (el.localName.includes(':')) { const s = doc.createElement('span'); s.append(...el.childNodes); el.replaceWith(s); }
  }
  const h = Math.max(page.dh || 0, page.vh || 0);
  const body = new XMLSerializer().serializeToString(doc.documentElement).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.vw}" height="${h}"><foreignObject width="100%" height="100%">${body}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  // Chrome 151 は foreignObject の在る SVG を createImageBitmap(img) で取ると汚れた絵にする（VideoFrame も getImageData も SecurityError）。
  // img のまま canvas に描くのは汚れないので、一度描いてから取る（2026-09-27 実測: Chrome 145 では汚れなかった・PBI-0009）
  const c = new OffscreenCanvas(page.vw, h);
  c.getContext('2d').drawImage(img, 0, 0);
  return c.transferToImageBitmap();
}

// 焼き込みの帯（下端）。1 行目（ドメイン）を大きく
function band(g, lines) {
  if (!lines.length) return;
  const size = (i) => (i ? 30 : 36), pad = 28, gap = 14;
  const h = pad * 2 + lines.reduce((a, _, i) => a + size(i), 0) + gap * (lines.length - 1);
  g.fillStyle = 'rgba(15,23,42,0.88)';
  g.fillRect(0, H - h, W, h);
  g.fillStyle = '#ffffff';
  g.textBaseline = 'top';
  let y = H - h + pad;
  lines.forEach((s, i) => {
    g.font = `${i ? 600 : 700} ${size(i)}px ${FONT}`;
    g.fillText(fitText(g, s, W - pad * 2), pad, y);
    y += size(i) + gap;
  });
}

// S の早送りを MP4 の File にする。stale() が true になったら encoder を閉じて null（side panel が読み直した）。
// H.264 も VP9 も無ければ NotSupportedError
export async function makeClip(S, stale = () => false) {
  const codec = await pickCodec();
  if (!codec) throw new DOMException('この Chrome では動画を作れません', 'NotSupportedError');
  const tl = timeline(S);
  const lines = captions(S);
  const get = fetcher();
  const bmps = new Map();
  const bitmapOf = (pi) => {
    if (!bmps.has(pi)) bmps.set(pi, raster(S.pages[pi], get).catch(() => null)); // 絵に出来ない → そのページだけ骨組みの絵
    return bmps.get(pi);
  };
  // 最後: 閉じた束の最後のページ（完了の画面。事象が無いので再生では走らない）の写しの上端
  const endPi = S.phase === 'closed' ? S.pages.findLastIndex((p) => !p.away) : -1;
  const end = endPi >= 0 && S.pages[endPi].dom
    ? { ...VIEW, items: [], ghost: null, card: null, swirl: null, dom: { pi: endPi, scale: VIEW.w / S.pages[endPi].vw, x: 0, y: 0 } }
    : frame(S, tl.total, VIEW, tl);

  const cv = new OffscreenCanvas(W, H), g = cv.getContext('2d');
  const ov = new OffscreenCanvas(W, H), o = ov.getContext('2d');
  async function draw(f, withBand) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f8fafc';
    g.fillRect(0, 0, W, H);
    const d = f.dom;
    const bmp = d && (await bitmapOf(d.pi));
    if (bmp) { // 実際の見た目: side panel の iframe と同じ変換（page 座標 p → 画面 p * scale - (x, y)）を K 倍
      g.setTransform(K * d.scale, 0, 0, K * d.scale, -K * d.x, -K * d.y);
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, bmp.width, bmp.height);
      g.drawImage(bmp, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, W, H);
    o.setTransform(K, 0, 0, K, 0, 0);
    paint(o, bmp ? f : { ...f, dom: undefined });
    g.drawImage(ov, 0, 0);
    if (withBand) band(g, lines);
  }

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: codec.startsWith('avc1') ? 'avc' : 'vp9', width: W, height: H, frameRate: FPS }, fastStart: 'in-memory' });
  let failed = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failed = e; } });
  enc.configure(configOf(codec));
  const n = Math.ceil(((INTRO + tl.total + OUTRO) * FPS) / 1000);
  try {
    for (let i = 0; i < n; i++) {
      if (stale()) return null;
      if (failed) throw failed;
      const ms = (i * 1000) / FPS, t = ms - INTRO;
      await draw(t < 0 ? frame(S, 0, VIEW, tl) : t <= tl.total ? frame(S, t, VIEW, tl) : end, t < 0 || t > tl.total);
      const vf = new VideoFrame(cv, { timestamp: Math.round(ms * 1000), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: i % KEY_EVERY === 0 });
      vf.close();
      while (enc.encodeQueueSize > 4 && !failed) await new Promise((r) => { enc.addEventListener('dequeue', r, { once: true }); setTimeout(r, 1000); });
      if (i % 8 === 7) await new Promise((r) => setTimeout(r)); // side panel の早送り（rAF）に譲る
    }
    await enc.flush();
    if (failed) throw failed;
  } finally {
    if (enc.state !== 'closed') enc.close();
    for (const b of bmps.values()) b.then((x) => x?.close());
  }
  muxer.finalize();
  return new File([muxer.target.buffer], `sakki-${lines[0] || 'clip'}.mp4`, { type: 'video/mp4' });
}
