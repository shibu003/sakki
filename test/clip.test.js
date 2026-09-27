// 動画の書き出しの純粋部分（PBI-0005）。encode と SVG の絵は E2E が持つ
import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineCss } from '../src/clip.js';

test('clip: CSS の url() を data: に。data:・# は触らず、取れない URL は元のまま、同じ URL は 1 回だけ読む（PBI-0005 AC-4）', async () => {
  const asked = [];
  const get = async (u) => { asked.push(u); return u.endsWith('.png') ? `data:image/png;base64,${u.length}` : null; };
  const css = `a{background:url("https://s.test/a.png")} b{background:url(img/b.png)} c{mask:url('#m')} d{background:url(data:image/gif;base64,R0)} e{src:url(https://s.test/f.woff2)} f{background:url("https://s.test/a.png")}`;
  const out = await inlineCss(css, 'https://s.test/css/site.css', get);
  assert.equal(out, 'a{background:url("data:image/png;base64,20")} b{background:url("data:image/png;base64,28")} c{mask:url(\'#m\')} d{background:url(data:image/gif;base64,R0)} e{src:url(https://s.test/f.woff2)} f{background:url("data:image/png;base64,20")}');
  assert.deepEqual(asked, ['https://s.test/a.png', 'https://s.test/css/img/b.png', 'https://s.test/f.woff2']);
});
