# 開発図

図の識別子（英字の名前）は、実装に同じ名前で現れる。構造が変わる変更は同じ commit で図も直す（機械の突き合わせはしない）。

## 1. MVP の流れ（1 つのタブの中）

出典: EP-0001 REQ-1〜7・PBI-0002 G1・PBI-0003 G1・PBI-0004 G1・PBI-0007（2026-09-27 更新）

```mermaid
stateDiagram-v2
    [*] --> onboarding: 入れた（onInstalled の reason が install の時だけ偽の手続きを開く）
    onboarding --> record_session: 偽の手続きの同意の欄を押した（consentedAt）
    onboarding --> idle: 押さずに閉じた（追わない・開き直さない）
    idle --> onboarding: アイコン → side panel の「偽の手続きを開く」
    record_session --> idle: 同意の欄を外した（記録を全部消す）
    record_session --> record_session: focus・click・input の瞬間に骨組みと、見出しが替わったらページの写しを取る（伏せる規則 1 本を通す）
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
    replay_fast --> export_clip: 「送る」を押した（開いた時に裏で作っておいた MP4。図 5）
    replay_fast --> record_session: 走り終わった・side panel を閉じた
    export_clip --> replay_fast: 共有シートかダウンロードに渡した
```

- 入口は拡張のアイコン 1 つ（popup は持たない）。押すと side panel が開く
- 記録を読む口（`get`）は拡張のページにだけ答える（`sender.url` が `chrome-extension://<自分>/`）。content script（乗っ取られた renderer）からは読めない
- 記録は `chrome.storage.session`（メモリだけ）。外へ送る経路は持たない
- 迷いは記録中の状態ではなく、記録から後で計算する（図 4）。再生・完了（W3）・動画（W4）が同じ関数を呼ぶ
- 合図の強さは 1 本の `judge`（main に押せる送信ボタンが残るか）。偽の手続きも同じ道で完了する（専用の道を持たない）
- 再生（replay_fast・worst_spot）は、写しの在るページを side panel の sandbox の iframe（script なし・押せない）に srcdoc で建て直し、`frame` のカメラで動かす。canvas はその上に ●●●・渦・ゴーストだけを重ねる。写しの無いページ（社内の束・大きすぎた・上限で捨てた）は骨組みの絵
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
- 束がドットの無いホスト・私的 IP・.local・会社専用の login 窓口（okta・onelogin）を通ったら internal: 文字と写しを全部落とし、以後も取らない
- storage.session の上限に当たったら、一番大きい束の一番古い写しから捨てる（そのページは骨組みの絵に落ちる）。写しが尽きたら一番古いページから

## 3. 伏せる規則（1 本。骨組みにも写しにも、記録する時に当てる）

出典: `src/recorder.js` の歩き方・写し（copyPage）・`src/redact.js`・PBI-0007（2026-09-27）

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
    remember[remember: 値・選んだ物・帯の文字の hash。自作の選び物の文字は値まるごと（置き文字の 3 文字片で文を伏せない）] -.-> mask
```

```mermaid
flowchart TD
    copyPage[copyPage: 見出しが替わった瞬間の DOM を HTML の文字列 1 本に。閉じた shadow root も template shadowrootmode で] --> noText2{社内の束?}
    noText2 -- yes --> none[写さない: 骨組みの絵だけ]
    noText2 -- no --> skip{script・noscript・meta・title・隠した欄・datalist?}
    skip -- yes --> drop[写さない。on 属性・srcdoc・action・checked・selected も落とす]
    skip -- no --> boxed{よその枠・canvas・動画・音声・object?}
    boxed -- yes --> grey[同じ大きさの灰色の箱]
    boxed -- no --> field{欄の中身?}
    field -- 文字の欄・select・textarea・contenteditable・自作の選び物（aria-haspopup=listbox） --> filled[値があれば ●●●。日付・数の欄は text にして ●●●]
    field -- no --> choice{選べる物の中の文字・radio と checkbox の label?}
    choice -- yes --> allmask[全部 ■。選んだ物だけ伏せると、残った方で選んだ物が分かる]
    choice -- no --> mask
    copyPage -.-> css[CSS: CSSOM から取り、相対 url を絶対に、vh を記録時の px に。読めない stylesheet は link のまま]
```

- 骨組みと写しを取る前と、押した（click）瞬間に、今のページの値を全部 remember に入れる（取った後に消す 2 本目は持たない。自作の選び物は input を出さないので、押した瞬間が次の画面より前に覚える所）
- 自作の選び物（`aria-haspopup=listbox`。Headless UI の Listbox など）は欄: 名前は label から取り（自分を指す aria-labelledby と中の文字は飛ばす）、中の文字は値
- 覚える集まりが後から育ったら（1 ページ目の本文に出ていた名前を 2 ページ目で初めて打った）、reducer の addMemo が前に取った骨組み・事象・写しの文字にも**同じ mask** を新しい分だけ当て直す（規則は 1 本のまま。見える属性の一覧 TEXT_ATTR も redact.js の 1 本を recorder と session が読む）
- 本文・見出し・ボタン・見える属性（alt・title・placeholder・datetime・download・aria-・data-）の文字は mask を通して実際のまま。資源の URL（画像・CSS）は再生で読み直すので残し、ページ自身の URL（パスとクエリ）は残さない（空の URL は写さない）
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

- 印（`([ ])` の形の節点）の集合 = `src/lost.js` が `mark('<kind>', …)` で立てる印の集合
- 再生は worstSpot の t0〜t1 の窓に入る事象へ向かう間を 1 倍（1 つの間は 1.5 秒・窓全体で 6 秒まで）にし、渦を 1 つだけ描く

## 5. 動画の書き出し（side panel を開いた時に裏で作り、「送る」で渡す）

出典: `src/clip.js`・`src/sidepanel.js`・PBI-0005 G1（2026-09-27）

```mermaid
flowchart TD
    load[load: side panel が束を読んだ。再生と並んで makeClip を始める] --> pick{pickCodec: isConfigSupported}
    pick -- avc1.4d0028 → avc1.42001f → vp09 のどれか --> raster[raster: ページごとに 1 回。写しの資源を data: に直し、SVG の foreignObject → ImageBitmap]
    pick -- どれも無い --> noCodec[送るは押せない: この Chrome では動画を作れません]
    raster -- 絵に出来ない・写しが無い --> skel[そのページだけ骨組みの絵]
    raster --> frames[冒頭 1.5 秒 + 再生 0〜total + 最後 2 秒を 30 fps で。frame の dom カメラで写しの絵を描き、paint を重ねる。冒頭と最後に captions の帯]
    skel --> frames
    frames -- 読み直された（もう一度・ゴースト）--> stale[stale: encoder を閉じて捨てる]
    frames --> mux[mp4-muxer: fastStart in-memory で moov を先頭に]
    mux --> ready[送るを押せる]
    ready -- 押した --> canShare{canShare files?}
    canShare -- yes --> share[navigator.share: OS の共有シート]
    canShare -- no --> download[a download でダウンロード]
    share -- AbortError: 利用者が閉じた --> done([何もしない])
    share -- それ以外の失敗 --> download
```

- 動画の材料は記録（写し・事象）と、写しに在る資源の GET だけ。記録や動画を載せた送信は持たない
- 焼き込み（`captions`）は ① 登録できるドメイン（`siteOf`）② 閉じた束の最後のページの見出し ③ 一番の迷いの窓の後の最初の名前の在る click。社内の束は 0 行
