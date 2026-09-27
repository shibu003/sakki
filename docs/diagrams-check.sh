#!/bin/bash
# 開発図と実装の突き合わせ（docs/diagrams.md の「再測手順」）。ずれたら exit 1。
# 見るのは識別子の実在と値集合の同値だけ。式の綴りは見ない（newway §16-8）。
set -u
cd "$(dirname "$0")/.." || exit 1
md=docs/diagrams.md
fail=0
say() { echo "diagrams-check: $*" >&2; fail=1; }

# mermaid の塊ごとに識別子を抜く: stateDiagram は --> の両側の状態、flowchart は形（[ { (）の前の節点
ids=$(awk '
  /^```mermaid/ { inb=1; kind=""; next }
  /^```/        { inb=0; next }
  inb && kind=="" { kind=$1; next }
  inb && kind ~ /^stateDiagram/ && /-->/ {
    split($0, lr, ":"); line=lr[1]; gsub(/-->/, " ", line)
    n=split(line, w, " "); for (i=1;i<=n;i++) if (w[i] ~ /^[A-Za-z_]+$/) print w[i]
  }
  inb && kind=="flowchart" {
    s=$0
    while (match(s, /[A-Za-z_]+[\[{(]/)) { print substr(s, RSTART, RLENGTH-1); s=substr(s, RSTART+RLENGTH) }
  }' "$md" | sort -u)

done_ids=$(grep -m1 '^実装済み:' "$md" | cut -d: -f2- | tr ' ' '\n' | grep . | sort -u)
todo_ids=$(grep -m1 '^未実装:' "$md" | cut -d: -f2- | tr ' ' '\n' | grep . | sort -u)
[ -n "$ids" ] || say "図から識別子を 1 つも抜けない（awk が壊れている）"
[ -n "$done_ids" ] || say "「実装済み:」の行が無い"

# 1. 図の集合 = 実装済み ∪ 未実装
listed=$(printf '%s\n%s\n' "$done_ids" "$todo_ids" | grep . | sort -u)
d=$(comm -3 <(echo "$ids") <(echo "$listed"))
[ -z "$d" ] || say "図と台帳の集合が違う（左 = 図だけ・右 = 台帳だけ）:
$d"

# 2. 実装済みは src/ のコードに在る。未実装は無い（// のコメントは落としてから見る = 説明文に当たって緑になるのを防ぐ）
code=$(cat src/*.js | sed -E 's#(^|[^:])//.*#\1#')
for id in $done_ids; do printf '%s\n' "$code" | grep -qw -- "$id" || say "実装済みの $id が src/ のコードに無い"; done
for id in $todo_ids; do ! printf '%s\n' "$code" | grep -qw -- "$id" || say "未実装の $id が src/ のコードに在る（実装したら「実装済み」へ移す）"; done

# 3. 図 2 の状態の集合 = session.js の phase の値の集合
fig2=$(awk '/^## 2\./{f=1} /^## 3\./{f=0} f' "$md" | grep -- '-->' | cut -d: -f1 | sed 's/-->/ /' | tr ' ' '\n' | grep -E '^[a-z_]+$' | sort -u)
phases=$(sed -E 's#(^|[^:])//.*#\1#' src/session.js | grep -oE "phase( *=|:) *'[a-z_]+'" | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u)
[ "$fig2" = "$phases" ] || say "図 2 の状態（$(echo $fig2)）と session.js の phase（$(echo $phases)）が違う"

[ "$fail" = 0 ] && echo "diagrams-check: ok（識別子 $(echo "$ids" | wc -l | tr -d ' ')・実装済み $(echo "$done_ids" | wc -l | tr -d ' ')・phase $(echo $phases)）"
exit "$fail"
