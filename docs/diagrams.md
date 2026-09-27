# 開発図

図の識別子（英字の名前）は、実装に同じ名前で現れる。突き合わせは `bash docs/diagrams-check.sh`（下の「再測手順」）。

## 1. MVP の流れ（1 つのタブの中）

出典: EP-0001 REQ-1〜7・PBI-0002 G1・PBI-0003 G1・PBI-0004 G1（2026-09-27 更新）

```mermaid
stateDiagram-v2
    [*] --> onboarding: 入れた（onInstalled の reason が install の時だけ偽の手続きを開く）
    onboarding --> record_session: 偽の手続きの同意の欄を押した（consentedAt）
    onboarding --> idle: 押さずに閉じた（追わない・開き直さない）
    idle --> onboarding: アイコン → side panel の「偽の手続きを開く」
    record_session --> idle: 同意の欄を外した（記録を全部消す）
    record_session --> record_session: focus・click・input の瞬間に骨組みを取る（伏せる規則 1 本を通す）
    record_session --> detect_completion: 主なボタンを押した ／ 押して移った先を読み込んだ（ask）／ ダウンロード・PDF ／ 印刷の後
    detect_completion --> record_session: 押した form が 16 秒残った（入力の誤り）／ 渦が無い（何も出さない）
    detect_completion --> call_menu: 弱い合図（main に押せる送信ボタンが残る）で渦が在る → 束は続く
    detect_completion --> show_ghost: 強い合図（押した form が消え、main に押せる送信ボタンが無い）→ 束を閉じた瞬間に渦が在り、空いた角が在る
    detect_completion --> call_menu: 強い合図で渦が在るが、4 つの角が塞がっている
    show_ghost --> call_menu: 手が動いた（pointerdown・wheel・キー・印刷）→ 引っ込む。同じページで出し直さない
    record_session --> replay_fast: アイコン → side panel（今のタブの記録、無ければ一番新しい記録）
    show_ghost --> replay_fast: ゴーストを押した（枠の中で sidePanel.open・side panel が開いたらゴーストは引っ込む）
    call_menu --> replay_fast: そのタブの右クリックの「さっきの自分を呼ぶ」
    replay_fast --> worst_spot: 一番損した 1 か所の窓に入った（1 倍に落とし、1.6 倍まで寄る）
    worst_spot --> replay_fast: 窓を抜けた（赤い渦は 1 か所のページに残す。大きさ = 損した時間）
    replay_fast --> export_clip: 「送る」を押した
    replay_fast --> record_session: 走り終わった・side panel を閉じた
    export_clip --> replay_fast: 共有シートかダウンロードに渡した
```

- 入口は拡張のアイコン 1 つ（popup は持たない）。押すと side panel が開く
- 記録は `chrome.storage.session`（メモリだけ）。外へ送る経路は持たない
- 迷いは記録中の状態ではなく、記録から後で計算する（図 4）。再生・完了（W3）・動画（W4）が同じ関数を呼ぶ
- 合図の強さは 1 本の `judge`（main に押せる送信ボタンが残るか）。偽の手続きも同じ道で完了する（専用の道を持たない）
- ゴーストは拡張のページ（ghost.html）の枠。サイトの文書に記録は入らない。角は右下 → 左下 → 右上 → 左上の順に、固定の要素・文字・欄・ボタン・リンク・画像と重ならない所を 1 回だけ選ぶ

## 2. 記録の単位（束 = タブ＋そこから開いたタブ）

出典: `src/session.js` の reducer・EP-0001 REQ-6（2026-09-27）

```mermaid
stateDiagram-v2
    [*] --> prelude: page（同意済みの最初の骨組み）
    prelude --> prelude: page が別のサイト → 前のサイトの分を捨てて取り直す
    prelude --> homed: ev が検索欄でない欄への input → 本拠 = そのページのサイト
    homed --> homed: page が本拠 → 記録する ／ hello がよそのサイト → away の箱だけ・take:false
    prelude --> closed: done の強い合図（閉じた瞬間だけ、渦が在ればゴーストを返す）
    homed --> closed: done の強い合図
    closed --> prelude: page が来た → 閉じた記録を捨てて次の手続き
    prelude --> [*]: tick 30 分 ／ tab_removed で束が空 ／ revoke
    homed --> [*]: tick 30 分 ／ tab_removed で束が空 ／ revoke
    closed --> [*]: tick 30 分 ／ tab_removed で束が空 ／ revoke
```

- tab_created の openerTabId が束のタブなら、同じ束に入る
- done の弱い合図は段を変えない（`weak` の印だけ。束は続き、右クリックで呼べる）。ask（完了を判定してよいか）は段を変えない
- 束がドットの無いホスト・私的 IP・.local・会社専用の login 窓口（okta・onelogin）を通ったら internal: 文字を全部落とし、以後も取らない

## 3. 伏せる規則（1 本。記録する時に当てる）

出典: `src/recorder.js` の歩き方・`src/redact.js`（2026-09-27）

```mermaid
flowchart TD
    walk[walk: 要素を順に歩く。閉じた shadow root にも降りる] --> inBand{header・nav・footer の中?}
    inBand -- yes --> band[band: 帯の箱だけ。リンクでない文字は remember へ]
    inBand -- no --> isMedia{画像・canvas・video・iframe・embed・object?}
    isMedia -- yes --> media[media: 同じ大きさの灰色の箱。24px 未満は描かない]
    isMedia -- no --> kindOf{見出し・欄・ボタン・選べる物のどれか?}
    kindOf -- どれでもない。本文・リンク --> walk
    kindOf -- 選べる物 --> choice[choice: 箱だけ。名前を取らない]
    kindOf -- 見出し・欄・ボタン --> noText{社内の束?}
    noText -- yes: 文字なし --> pushItem[pushItem: 箱と伏せた文字を骨組みに足す]
    noText -- no --> mask[mask: 覚える集まりの一致と、数字・メールの形を ■ に]
    mask --> pushItem
    remember[remember: 値・選んだ物・帯の文字の hash] -.-> mask
```

- 骨組みを取る前に、今のページの値を全部 remember に入れる（取った後に消す 2 本目は持たない）
- 取るのは focus・click・input の瞬間だけ。最初の focus か click までは何も送らない

## 4. 迷いの検出（記録から後で計算する 1 本）

出典: `src/lost.js`・PBI-0003 G1（2026-09-27）

```mermaid
flowchart TD
    detectLost[detectLost: 束の全タブの事象を時刻の順に並べる。よそのサイトの箱は除く] -- 欄への focus --> refocus([refocus: 直前の focus が別の欄で、この欄に前にも居た])
    detectLost -- 選べる物の input --> repick([repick: 同じ欄をもう一度選んだ])
    detectLost -- ページの最初の事象 --> revisit([revisit: 前に居た見出しへ、別の見出しを挟んで戻った。よその箱だけを挟んだ戻りは 2 回目から])
    detectLost -- 前の事象から 30 秒を超えた --> stall([stall: 見えていた時間の 30 秒を超えた分。1 回 3 分まで。よその箱を挟んだ間は数えない])
    refocus --> sameField[sameField: 名前が同じで x と w が ±4px。名前が無ければ同じページか同じ見出しのページで箱が ±4px]
    repick --> sameField
    sameField --> spotOf[spotOf: 事象の上で一番近い見出し。無ければ最初の見出し、それも無ければ事象の箱]
    revisit --> spotOf
    stall --> spotOf
    spotOf --> worstSpot[worstSpot: 1 か所ごとに印の損した間の和集合の長さ。一番長い 1 か所。印 0 なら無し]
```

- 印（`([ ])` の形の節点）の集合 = `src/lost.js` が `mark('<kind>', …)` で立てる印の集合（再測手順 4）
- 再生は worstSpot の t0〜t1 の窓に入る事象へ向かう間を 1 倍（1 つの間は 1.5 秒・窓全体で 6 秒まで）にし、渦を 1 つだけ描く

## 再測手順

`bash docs/diagrams-check.sh` が次を確かめる（ずれたら exit 1。`git commit` の前に hook が走らせる）:

1. 図の識別子（stateDiagram の状態・flowchart の節点）の集合 = 下の「実装済み」∪「未実装」
2. 「実装済み」は全部 `src/` に単語として在る。「未実装」は `src/` に 1 つも無い（実装したら「実装済み」へ移す）
3. 図 2 の状態の集合 = `src/session.js` で `phase` に入れる値の集合（`phase:` と `phase =`）
4. 図 4 の印の集合（`([ ])` の形の節点）= `src/lost.js` が `mark('<kind>', …)` で立てる印の集合

実装済み: onboarding idle record_session replay_fast worst_spot detect_completion show_ghost call_menu prelude homed closed walk inBand band isMedia media kindOf choice noText pushItem mask remember detectLost refocus repick revisit stall sameField spotOf worstSpot
未実装: export_clip
