#!/bin/bash
# DOM 部分の負の対照: repo の複製に 1 か所ずつ変異を入れ、関係する E2E だけを回して赤を数える（赤くならない変異 = その検査は何も測っていない）。
# 使い方: bash e2e/mutate-dom.sh <名前>   名前を省くと全部。base は変異なし（全部 ok のはず）
set -u
SRC=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT:-$(mktemp -d "${TMPDIR:-/tmp}/sakki-mutate.XXXXXX")}
W3='入れた直後|同意の欄を押した後|PBI-0004'
W7='入れた直後|同意の欄を押した後|値を取らない|PBI-0007|PBI-0003|login の内側'
W5='入れた直後|同意の欄を押した後|PBI-0004 AC-1|PBI-0005'
run() { # $1 = 名前, $2 = 検査の名前の型, $3 = 変える file, $4 = 置換（a|||b。a はその file に 1 回だけ在る）
  local R=$OUT/$1
  rm -rf "$R" && mkdir -p "$R" && (cd "$SRC" && git ls-files -co --exclude-standard | grep -v '^backlog/' | tar -cf - -T -) | tar -xf - -C "$R" && ln -s "$SRC/node_modules" "$R/node_modules"
  python3 - "$R/$3" "$4" <<'PY'
import sys
p, spec = sys.argv[1], sys.argv[2]
a, b = spec.split('|||')
s = open(p).read()
assert s.count(a) == 1, a
open(p, 'w').write(s.replace(a, b))
PY
  (cd "$R" && timeout 600 node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern="$2" e2e/*.test.js > "$OUT/$1.tap" 2>&1)
  echo "$1: $(grep -cE '^ok ' "$OUT/$1.tap") ok / $(grep -cE '^not ok ' "$OUT/$1.tap") not ok"
  grep -E '^not ok ' "$OUT/$1.tap" | cut -c1-110
}
R=src/recorder.js
one() {
  case "$1" in
    base)     run base "$W3|$W7|$W5|拡張が再読み込み" $R "const judge = |||const judge = ";;
    # W3（PBI-0004）: 完了の合図と角のゴースト
    search)   run search "$W3" $R "const inSearch = (el) => !!el.closest('[role=search],search') || [...(el.form?.elements || [])].some((f) => tag(f) === 'INPUT' && isSearchField(f));|||const inSearch = () => false;";;
    weakless) run weakless "$W3" $R "const judge = () => (submitLeft() ? 'weak' : 'strong');|||const judge = () => 'strong';";;
    fixed)    run fixed "$W3" $R "if (pos === 'fixed' || pos === 'sticky' || isMedia(el)|||if (isMedia(el)";;
    keydown)  run keydown "$W3" $R "const HANDS = ['pointerdown', 'wheel', 'keydown', 'beforeprint'];|||const HANDS = ['pointerdown', 'wheel', 'beforeprint'];";;
    # PBI-0006: label の中の選択肢
    label)    run label '入れた直後|同意の欄を押した後|PBI-0006' $R "const byLabel = text(el.labels && el.labels.length ? [...el.labels].map(labelText).join(' ') : wrap ? labelText(wrap) : '');|||const byLabel = text(el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(' ') : wrap ? wrap.textContent : '');";;
    # PBI-0007: 実際の見た目の写しと再生
    copymask) run copymask "$W7" $R ": blank ? v.replace(/\S/g, '■') : mask(v, ctx.memo, ctx.seed)));|||: blank ? v.replace(/\S/g, '■') : v));";;
    choice)   run choice "$W7" $R "const b = blank || isChoiceEl(el) || (t === 'LABEL' && /^(radio|checkbox)\$/.test(el.control?.type || ''));|||const b = blank;";;
    script)   run script "$W7" $R "const SKIP = new Set(['SCRIPT', |||const SKIP = new Set([";;
    vh)       run vh "$W7" $R ".replace(/(?<=[\s:(,])(-?(?:\d+\.?\d*|\.\d+))[sld]?vh\b/g,|||.replace(/(?!)/g,";;
    cssom)    run cssom "$W7" $R "if (t === 'STYLE') return put(styleTag(cssOf(el.sheet) ?? |||if (t === 'STYLE') return put(styleTag(";;
    shadow)   run shadow "$W7" $R "const sr = shadowOf(el);
      if (sr) {|||const sr = el.shadowRoot;
      if (sr) {";;
    camera)   run camera "$W7" src/sidepanel.js 'shot.style.transform = `translate(${-d.x}px, ${-d.y}px) scale(${d.scale})`;|||shot.style.transform = `scale(${d.scale})`;';;
    nocopy)   run nocopy "$W7" src/replay.js "if (page.dom) list.dom = |||if (false) list.dom = ";;
    # PBI-0005: 動画の書き出しと送る
    inline)   run inline "$W5" src/clip.js "if (u && !/^(data:|#)/i.test(u)) jobs.push(|||if (false) jobs.push(";;
    overlay)  run overlay "$W5" src/clip.js "    g.drawImage(ov, 0, 0);|||";;
    caption)  run caption "$W5" src/clip.js "    if (withBand) band(g, lines);|||";;
    faststart) run faststart "$W5" src/clip.js "fastStart: 'in-memory'|||fastStart: false";;
    xmlname)  run xmlname "$W5" src/clip.js "el.removeAttribute(name);|||void 0;";;
    stale)    run stale "$W5" src/clip.js "      if (stale()) return null;|||";;
    abort)    run abort "$W5" src/sidepanel.js "if (e?.name === 'AbortError') return;|||";;
    # AC-X2 ②（PBI-0002）: 文脈が切れた時の catch を外す
    reload)   run reload '拡張が再読み込み' $R "queue = queue.then(job).catch(() => stop());|||queue = queue.then(job);";;
    *) echo "知らない名前: $1"; return 1;;
  esac
}
if [ $# -gt 0 ]; then one "$1"; else for m in base search weakless fixed keydown label copymask choice script vh cssom shadow camera nocopy inline overlay caption faststart xmlname stale abort reload; do one "$m"; done; fi
echo "# TAP: $OUT"
