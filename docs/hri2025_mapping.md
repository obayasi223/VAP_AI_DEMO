# HRI 2025 と今回の実装の対応表

- 原著: Skantze & Irfan, *Applying General Turn-taking Models to Conversational Human-Robot Interaction*, HRI 2025。arXiv:2501.08946v1（15 Jan 2025）。https://arxiv.org/html/2501.08946
- 確認日: 2026-11-08。担当: R1。
- 表記: 【原文】本文・擬似コードで確認／【図読】図から目盛りで読んだ概算（1秒の矢印を基準にした画像上の測定で、誤差が大きい）／【解釈】原文で決まらない点についての判断／【未確認】。

## 0. この文書の扱い

- **今回の実装は HRI 2025 の完全な複製ではない。** 原著の構成を再構成し、原著にない `LLM_INITIATIVE` と `BREATH_SIGNAL` を加えたものである。原著本文に実装コードの URL はなく、公式のシステム一式は確認できていない。
- **原著の数値（応答時間、割り込み率、質問紙の結果など）を日本語版の性能として引用しない。** 英語話者39名と Furhat による原著の測定であり、今回の構成について何も示さない。§2 では VII 節の数値を載せない。§3 で原著の内部整合を確かめるために触れる箇所も、性能の根拠ではない。
- Appendix A の値は原著の初期値である。原著自身が「かなり恣意的（fairly arbitrary）」で「4回のパイロットで調整」と述べている（V 節）。日本語での妥当性は示されていない。

## 1. Appendix A の全文転記

**行番号は原著のもの。** 誤字や括弧の不一致（§3 の I-7）も直さずにそのまま写した。

**照合の方法:** arXiv HTML に埋め込まれた listing のソース（base64）を復号して、この節を機械的に生成した。次の2つと照合し、差分はなかった（空白の正規化後）。

1. 同じ HTML の描画行（全92行）
2. arXiv PDF の抽出テキスト（空行以外の全行が PDF に存在）

ソースの SHA-256: `21e098a26aa100f1db027376496273cf10a1c5ded0f8682b061ce8720d3ddfb7`（改行は LF、L38 の字下げはタブ、L2・L4 などの行末空白も原文のまま）。

```text
 1  // HYPER-PARAMETERS
 2  Const TURNGPT_PREPARE_THRESHOLD = 0.2 
 3  Const ASR_PREPARE_TIMEOUT = 200 // ms
 4  Const SIMILARITY_PREPARE_THRESHOLD = 0.8 
 5  // These affect how easy the robot will ne to interrupt
 6  Const VAP_PNOW_INTERRUPT_THRESHOLD = 0.4
 7  Const VAP_PFUT_INTERRUPT_THRESHOLD = 0.4
 8  // These affect how eager the robot will be to take the turn
 9  Const VAP_PNOW_YIELD_THRESHOLD = 0.5
10  Const VAP_PFUT_YIELD_THRESHOLD = 0.5
11  // Minimum allowed response time
12  Const MIN_GAP_TIME = 500
13  
14  // Response timeouts (in ms) based on TurnGPT output probability:
15  Const TURNGPT_YIELD_TIMEOUTS = {
16      { "threshold": 0.3, "timeout": 500 }, 
17      { "threshold": 0.2, "timeout": 1000 },
18      { "threshold": 0.1, "timeout": 2000 },
19      { "threshold": 0.0, "timeout": 3000 }
20  ]
21  
22  // Initialize variables
23  Set user_speak_end_time = Time.get_current()
24  Set user_turn_end_time = Time.get_current()
25  Set last_asr_time = Time.get_current()
26  Set asr_result = none
27  Set last_sent_asr_result = none
28  Set turngpt_output = 0  
29  
30  // Main processing loop
31  ForEach timestep:
32      current_time = Time.get_current()
33      
34      Set vap_output = VAP.get_current() // Voice Activity Projection
35      
36      // Check if the ASR has updated its output
37      If ASR.has_new_result() then
38  		asr_result = ASR.get_result()
39          DialogState.updateUser(asr_result)
40          turngpt_output = TurnGPT.eval(DialogState.getHistory())
41          last_asr_time = current_time
42      End If
43      
44      // Preparing the response
45      If last_sent_asr_result != asr_result then
46          If (turngpt_output > TURNGPT_PREPARE_THRESHOLD) or ((current_time - last_asr_time) >= ASR_PREPARE_TIMEOUT) then
47              If Similarity(asr_result, last_sent_asr_result) < SIMILARITY_PREPARE_THRESHOLD then
48                  Speech_Generator.cancel()
49                  // Start preparing LLM+TTS
50                  Speech_Generator.prepareAsync(DialogState.getHistory()) 
51                  last_sent_asr_result = asr_result
52              End If
53          End If
54      End If
55      
56      If vap_output.user_is_speaking then
57          user_speak_end_time = current_time
58          // Check for user interruptions
59          If (vap_output.p_now < VAP_PNOW_INTERRUPT_THRESHOLD) and (vap_output.p_fut < VAP_PFUT_INTERRUPT_THRESHOLD) and Speech_Generator.is_speaking() then
60              Speech_Generator.stop_speaking()
61          End If
62      Else
63          // User is not speaking
64          Set turn_shift_allowed = false
65          // Check if VAP has detected a turn yield
66          If (vap_output.p_now > VAP_PNOW_YIELD_THRESHOLD) and (vap_output.p_fut > VAP_PFUT_YIELD_THRESHOLD) then
67              If (current_time - user_turn_end_time) >= MIN_GAP_TIME then
68                  turn_shift_allowed = true
69              End If
70          Else
71              user_turn_end_time = current_time
72          End If
73          // Check if TurnGPT has detected a turn yield
74          If (current_time - user_speak_end_time) >= TurnGPT_Timeout(turngpt_output) then
75              turn_shift_allowed = true
76          End If
77          
78          If turn_shift_allowed and Speech_Generator.is_ready() then
79              Speech_Generator.start_speaking()
80              ASR.reset()
81          End If
82      End If
83  End ForEach
84  
85  
86  Function TurnGPT_Timeout(p):
87      ForEach entry in TURNGPT_YIELD_TIMEOUTS:
88          If p >= entry.threshold then
89              return entry.timeout
90          End If
91      End ForEach
92  End Function
```

### 1.1 定数の一覧

| 原著の定数名（行） | 値 | 計画 §4.1 の略記 | 一致 |
|---|---|---|---|
| `TURNGPT_PREPARE_THRESHOLD`（L2） | 0.2 | `TURNGPT_PREPARE_THRESHOLD` | 一致 |
| `ASR_PREPARE_TIMEOUT`（L3） | 200 ms | `ASR_PREPARE_TIMEOUT` | 一致 |
| `SIMILARITY_PREPARE_THRESHOLD`（L4） | 0.8 | `SIMILARITY_PREPARE_THRESHOLD` | 一致 |
| `VAP_PNOW_INTERRUPT_THRESHOLD`（L6） | 0.4 | `VAP_PNOW_INTERRUPT` | 値は一致、名前は略記 |
| `VAP_PFUT_INTERRUPT_THRESHOLD`（L7） | 0.4 | `VAP_PFUT_INTERRUPT` | 値は一致、名前は略記 |
| `VAP_PNOW_YIELD_THRESHOLD`（L9） | 0.5 | `VAP_PNOW_YIELD` | 値は一致、名前は略記 |
| `VAP_PFUT_YIELD_THRESHOLD`（L10） | 0.5 | `VAP_PFUT_YIELD` | 値は一致、名前は略記 |
| `MIN_GAP_TIME`（L12） | 500（単位の記載なし。L11 の注記と V-A から ms） | `MIN_GAP_TIME` 500ms | 一致 |
| `TURNGPT_YIELD_TIMEOUTS`（L15〜L20） | 0.3→500、0.2→1000、0.1→2000、0.0→3000（ms） | `YIELD_TIMEOUTS` | 値は一致、名前は略記 |

### 1.2 比較演算子と境界（表形式試験の入力）

| 行 | 条件 | 境界の挙動 |
|---|---|---|
| L45 | `last_sent_asr_result != asr_result` | 両方 `none` の初期状態では偽 |
| L46 | `turngpt_output > 0.2` | **p = 0.2 は偽** |
| L46 | `elapsed >= 200` | 200ms ちょうどで真 |
| L47 | `Similarity < 0.8` | **0.8 ちょうどは偽**。このとき `last_sent_asr_result` は更新されず、次の tick も L45〜L47 を再評価する |
| L59 | `p_now < 0.4 and p_fut < 0.4 and is_speaking` | 3条件の AND。0.4 ちょうどは偽 |
| L66 | `p_now > 0.5 and p_fut > 0.5` | 0.5 ちょうどは偽で、L71 が走る |
| L67 | `elapsed >= 500` | 500ms ちょうどで真 |
| L74 | `elapsed >= TurnGPT_Timeout(p)` | ちょうどで真。L67 が偽でもこちらで真になりうる（OR の関係） |
| L88 | `p >= threshold`（上から順） | 0.3→500、0.2999→1000、0.2→1000、0.1999→2000、0.1→2000、0.0999→3000、0→3000 |

**0.4 ≤ p ≤ 0.5 は割り込みにも譲渡にも当たらない不感帯。** `turn_shift_allowed`（L64）は毎 tick 偽から計算し直す局所変数で、tick をまたいで保持しない。

### 1.3 分岐の試験ケース（案）

試験そのものは E の担当。ここでは原文から導ける入出力を挙げる。

| ID | 状況 | 原文どおりの期待（`original`） | 計画 §4.1 の既定 |
|---|---|---|---|
| T1 | 新しい ASR 結果あり | `asr_result`・`turngpt_output`・`last_asr_time` を更新 | 同じ |
| T2 | p=0.2、前回結果から 199ms | 準備しない | 同じ |
| T3 | p=0.21、前回結果から 0ms、類似度 0.5 | `cancel` の後に `prepareAsync`、`last_sent` を更新 | 同じ |
| T4 | p=0、前回結果から 200ms、類似度 0.5 | T3 と同じ | 同じ |
| T5 | 準備条件は真、類似度 0.8 | 何もしない、`last_sent` は不変 | 同じ |
| T6 | 利用者が発話中、p_now=p_fut=0.39、AI 発話中 | `stop_speaking` | 停止命令は同じ（停止点は語境界＋上限） |
| T7 | 利用者が発話中、p_now=0.39、p_fut=0.4、AI 発話中（相槌の形） | 停止しない | 同じ |
| T8 | 利用者が発話中、p は T6 と同じ、AI は無音 | 停止命令なし | 同じ |
| **T9** | **利用者が5秒話して止まった最初の tick、p_now=p_fut=0.6** | **L67 が真で即時に許可（0ms）** | **最後の発話 tick から 500ms 経つまで許可しない** |
| T10 | 非発話、p=0.5/0.6 | `user_turn_end_time` を現在時刻へ（L71） | 同じ |
| T11 | 非発話、p=0.51/0.51 が 499ms 継続 | L67 では許可しない | 同じ |
| T12 | T11 が 500ms に到達 | 許可 | 同じ |
| T13 | 非発話、VAP は利用者を支持し続ける、TurnGPT p=0 | 発話終了から 3000ms で許可（L74） | 同じ |
| T14 | 非発話、VAP は利用者を支持、TurnGPT p=0.72 | 500ms で許可（L74） | 同じ |
| T15 | 許可あり、`is_ready` が偽 | 開始しない。次の tick で再計算 | 同じ |
| T16 | 許可あり、`is_ready` が真 | `start_speaking` の後に `ASR.reset` | 同じ＋ `segment_id` を増やす |
| T17 | 利用者が発話中、`is_ready` が真 | 開始しない（発話中の分岐に L78 はない） | 同じ |

計画どおりなら「発話終了から 500ms 未満では許可が出ない」が全経路で成り立つ（L74 の最小値も 500ms）。不変条件の試験にできる。

## 2. 節ごとの対応

| 節 | 原著の内容【原文】 | 今回の実装 | 差分・理由 | 担当 |
|---|---|---|---|---|
| III 冒頭 | 汎用モデル（TurnGPT と VAP）を併用。人間同士のデータで自己教師あり学習 | 同じ考え方で MaAI と推定器を併用 | 推定器は未確定（§4.4）。ない場合は HRI 近似度が下がる | R2、R3、E |
| III-A | GPT-2 拡張、`<ts>` トークンの確率をターン完了確率とする。SODA（385K 会話）で学習。8GB RTX 2080 で約 20ms | TurnGPT を検証し、不適なら代替 | 英語で学習。**公開リポジトリの重みが原著の SODA 学習版と一致するかは未確認**。今回は GPU なし。代替は TurnGPT 再現と呼ばない | R3、D |
| III-B | stereo の VAP。過去 30 秒から 2 秒先を予測、例として 10Hz。p_now は 0–600ms、p_future は 600–2000ms。Fisher Part 1 と Switchboard（米国の電話、約 1000 時間） | MaAI 2ch、日本語モデル | 窓は MaAI 文書でも同じ。学習データ、文脈長、周期は異なる（§4）。閾値を流用できる根拠はない | R2、B |
| IV | ベースライン（無音閾値、割り込み不可、LED、毎ポーズの視線逸らし） | **実装しない** | 比較実験は今回の範囲外。視線の説明（IV-B）だけ V-D の背景として参照 | — |
| V 冒頭 | TTS 出力を VAP へ、対話履歴を TurnGPT へ戻す（self-monitoring）。ハイパーパラメータは4回のパイロットで調整 | 実再生 PCM を system チャネルへ。話した分だけ履歴へ | 原著は「TTS output」とだけ述べ、再生位置の扱いは不明。今回は実再生 PCM と明記して記録 | A、B、J |
| V-A | ASR を TurnGPT へ、2ch を VAP へ。両者の出力で譲渡を判定。最小 0.5 秒、上限 3 秒。許可は発話可能（ready）とは別 | `step()` 純粋関数、`policy.hri2025.json` の原著値 | 文の「favored the user」は §3 の I-1。`user_turn_end_time` は I-4 | E |
| V-B | ASR 途中結果で先行生成。TurnGPT ≥0.2 または前回結果から 0.2 秒で起動、新規起動で旧要求を取消。文埋め込み類似度 ≥0.8 なら再生成しない（all-MiniLM-L6-v2） | E が判断、D が `prepare/cancel` を実行。類似度は文字 n-gram コサイン | 手法が違うので 0.8 は流用しない。閾値は別管理してログに残す。`>` と `≥` は I-3、図との差は I-5 | E、D |
| V-C | p_now と p_future の両方が利用者を支持したら次の語境界で停止。片方だけなら相槌として継続。話した部分だけを履歴へ。再開も可能と述べる | 語境界を既定、上限 200ms【暫定】でフェード。語境界の判定は D、停止は A、履歴は J | 上限時間は原著にない追加。再開は擬似コードになく、今回も未設計 | E、D、A、J |
| V-D | VAP で自分の発話を分析し、視線を動的に制御。**譲渡されないと予測されるポーズでは逸らさず、「うっかり譲渡」しうるポーズで逸らす**。ターン保持が目的。LED は不使用 | `gaze_decision` を TurnManager の出力に含める。閾値は `policy.ja.json` | **Appendix A に視線の記述はなく、数値の閾値もない。計画 §4.2 は向きが逆（§5）**。吸気とは別の機能 | E、H |
| VI、VII | 39名の被験者内実験、質問紙、割り込みの事後注釈 | **再現しない** | 数値は引用しない（§0）。今回の評価は仕様 §10 | — |
| VIII | 映像の手がかり、多人数、応答前の工夫などを将来課題に挙げる。利用者主導の場面も評価したいと述べる | 利用者の話の途中で内容から申し出る処理を追加 | **原著は途中の申し出の機構を実装も評価もしていない**。原著の結果をこの追加の効果の根拠にしない | G、E |
| Appendix A | §1 | §1.3 の表形式試験 | §3 の解釈の差を設定で切替 | E |
| Appendix C | gpt-3.5 用の英語プロンプト（役割と倫理ジレンマの話題）。履歴は LLM で要約 | 使わない | 日本語、別モデル、別の役割（`persona.ja.json`）。要約の扱いは【未確認】 | D |
| Fig. 1 | 順に、利用者音声、ASR、TurnGPT、応答生成、ロボット音声、視線、VAP | 研究者画面の時系列の参考 | §3 の I-5、§5 の視線を参照 | I、E |
| Fig. 3 | User→ASR→DM→TTS→Robot、緑で VAP と TurnGPT を追加、DM→表情と視線 | 仕様 §4 の構成へ置換（DM は TurnManager と Negotiator） | `InitiativeMonitor` と `ResponsePrefetch` の分離、Web Audio の実再生、吸気は原著にない。表情の LLM 生成（IV-B）は仕様に要求がなく実装しない | F、J |
| Fig. 4 | 割り込みと相槌の例（HTML 版では誤って Figure 5 と表示。I-8） | 割り込み試験の場面の参考 | 【図読】赤線の後も約 0.3〜0.4 秒波形が続く。語境界までの遅れか描画の都合かは判別できない | E |

**原著にないもの（今回の追加）:** `InitiativeMonitor`、発話候補の状態、吸気の合図、発話招待の検出、`fallback_energy` と VAP 鮮度切れの扱い、録音リプレイ。

## 3. 論文内の不一致と計画 §4.1 の解釈

| ID | 不一致 | 根拠【原文】 | 計画の解釈 | R1 の判定と提案 |
|---|---|---|---|---|
| I-1 | **p の向き** | V-A 本文のみ「both p_now and p_future have favored the user for at least 0.5 s」。一方、L59（p<0.4 で割り込み）、L66（p>0.5 で譲渡）、L5/L8 の注記、III-B「both predictions shift to the robot」、V-C（両方が利用者を支持で停止） | 擬似コードを正とし、p＝AI 側、MaAI で実測して確定 | **計画どおりでよい。** 原文内で V-A だけが孤立しており、V-A は書き誤りとみてよい【解釈】。MaAI は 2 要素を返し合計 1.0 と文書にある。添字は R2 で確定 |
| I-2 | **停止点** | V-C「stops speaking at the next word boundary」。L60 は `stop_speaking()` と書くだけ | §1.1 は擬似コードを「即時」と記載。§4.1 は語境界を既定、上限 200ms、即時は切替 | **設計はそのままでよいが §1.1 の記述は修正が必要。** 擬似コードは停止点を規定しておらず、「即時」とは書いていない。矛盾ではなく未規定。上限 200ms は原著にない値で、Fig. 4 の【図読】（約 0.3〜0.4 秒）より短い |
| I-3 | **`>` と `≥`** | V-B「0.2 or higher」、L46 は `>`。他の箇所は一致（V-B 0.2 s ↔ L46 `>=`、V-B 0.8 or higher ↔ L47 `<`、V-A at least 0.5 s ↔ L67 `>=`） | **記載なし** | `policy.hri2025.json` と試験は擬似コードの `>` に合わせ、差分をここに残すことを提案。連続値なので実害は小さい。L88 は p=0.2 を「≥」で扱うので、p=0.2 は 1000ms の枠だが準備の閾値は超えない点を T2 で固定する |
| I-4 | **`user_turn_end_time` と MIN_GAP の意味** | 3通りある。L11「最小応答時間」、V-B「話し終えて 0.5 秒後」、V-A「0.5 秒以上支持が続いた後」。L71 の更新は非発話かつ VAP が譲渡でないときだけ | 発話中の分岐でも更新。原文どおりは設定で切替 | **計画どおりでよい。** 発話終了と VAP の反転の遅い方から 500ms となり、3つの記述をすべて満たす。VII-A も 0.5 秒を最小応答時間と呼ぶ。Fig. 1 と Fig. 4 の許可線は VAD の終わりから約 0.6 秒【図読】で、0ms 許可は見えない（L74 経路とも区別できないので決定的な根拠ではない）。原文どおりの 0ms は発話が 500ms 以上続いたときに起きる（T9） |
| I-5 | **準備の起動と Fig. 1 の差** | L46 なら p=0 でも更新停止から 200ms で起動する。Fig. 1 と V-B は "So"、"favorite"、"movies" の後のみ。"do you"（p=0.0）、"have any"（p=0.0）の後は次の結果まで約 0.7 秒【図読】空くのに起動がない。"so" の後の起動も約 0.5 秒後【図読】。Fig. 4 の "oh that is really cool" も次の結果まで約 1 秒あるが起動がない（p は図に記載なし） | 記載なし | **原文だけでは解決できない。** 類似度で止まった可能性、図の簡略化、実装差のいずれか。試験は擬似コードを正とする。実ログの起動回数と費用で見直す |
| I-6 | **同じポーズの読み方** | III-B は Fig. 1 の "How about you?" 前のポーズを相槌の誘いとして読む。V-D は同じポーズを「うっかり譲渡しうる」と読み、視線を逸らす | §4.2 は逆向き（§5） | 計画の修正が必要。両方の読みが同居するので、視線の判定は「発話権の移行の予測」に限り、人の意図を推定したものとしてログに残さない |
| I-7 | **擬似コードの表記揺れ** | L15 は `{` で開き L20 は `]` で閉じる。L5 の "will ne to"。`MIN_GAP_TIME` に単位なし | — | 転記は原文のまま。JSON では配列として持つ |
| I-8 | **図番号（HTML 版のみ）** | HTML の V-C と VI-C は Fig. 4 を指す箇所で「Figure 5」と表示する。PDF では Figure 4 | — | 論文の不一致ではなく HTML 変換の誤り。引用時は PDF の番号を使う |

## 4. 擬似コードが決めていないこと

原文で決まらない点。実装では明示的に決め、試験に入れる必要がある。**「計画」列が空欄のものは計画 §4.1 にも記載がない。**

| ID | 未規定の点 | なぜ問題か | 計画 | 提案【解釈】 | 担当 |
|---|---|---|---|---|---|
| U-1 | L78 に `is_speaking` の確認がない | 話している間に別の応答が ready になると重なる | | `start_speaking` の条件に AI 非発話を加える | E、D |
| U-2 | AI 発話中の L45〜L54。ここに発話中の確認がない | 相槌 "yeah" でも L48 の `cancel` と L50 の準備が走りうる。Fig. 4 の "yeah" の後に LLM の起動は描かれていない。`cancel` が再生中の音声を止めるかも不明 | | `cancel` は未再生の準備だけを対象とする。AI 発話中の準備は抑止し、割り込み確定後に再開することを既定に | E、D |
| U-3 | L80 の `ASR.reset()` の中身 | 所属の問題に加え、次項の変数が残る | `segment_id` と音声位置で規定 | 計画どおり。次項を追加 | E、C、J |
| U-4 | L80 後も `asr_result`・`last_sent_asr_result`・`turngpt_output` が残る | **同じ文の繰り返し（「はい」→「はい」）で L45 が偽のままになり準備が起動しない。** L47 の類似度も前ターンの文と比べることになる | | `segment_id` が変わったら3変数を初期化。`original` との差分として記録 | E |
| U-5 | `Similarity(x, none)` | 初回の比較が定義されない | | 0 として扱い、初回は必ず起動 | D、E |
| U-6 | `timestep` の周期 | 原著は VAP の例として 10Hz のみ記載。計画は tick 20〜50ms、MaAI `normal-ver2` は 12.5Hz | 固定周期 | 試験で tick と VAP フレームを別々に与える | E |
| U-7 | `user_is_speaking` の閾値とヒステリシス | 1フレームの欠けで L57 と L71 の計時が動く。割り込み判定（L59）にも継続時間がない | `vad[0]` としきい値 | しきい値に加え最短継続を設定項目に。既定は原著どおりなし | E、R2 |
| U-8 | `stop_speaking` の冪等性 | L59 が毎 tick 真になりうる | | 語境界待ちの間に重複命令を出さない | E、A |
| U-9 | 発話終了と `turngpt_output` の新旧 | ASR の遅れにより、L74 が判定する時点で p が古いことがある | | `decisions[]` のログに p の revision を残す | E、I |
| U-10 | 再開の仕組み | V-C は「可能になる」と述べるだけで擬似コードにない | | 今回は未実装と明記 | K |

**推定器がない場合の挙動（参考）:** `turngpt_output` は 0 のままなので L46 の第1条件は常に偽になり、準備は更新が 200ms 止まったときだけ起動する。L74 の上限は 3000ms。ASR の更新が 200ms より細かく続くと発話の切れ目まで準備は始まらない。

**実装の都合で両方の方策に入れたもの（原著にない。U 項目の補正ではない）:** L78 の `Speech_Generator.is_ready()` に「いま出力できる」を含める。`TurnInputs.start_blocked_reason`（ブラウザの切断中、前の音声がまだ終わっていない）がある間は L78 を偽にし、L79〜L80 を実行しない。拒否された開始で `ASR.reset` だけが進み、準備した応答を失うのを防ぐ。詳細は `docs/known_gaps.md` §7。

## 5. 計画への申し送り（統括向け）

R1 は計画を編集しない。次を提案する。

1. **§4.2（最重要）:** 「VAP が譲渡を予測しないときだけ視線を逸らす」は原著と逆。V-D は "the VAP model predicts that the turn is not yielded after ..., but that it could be 'accidentally' yielded after .... Thus, the robot does not need to avert the gaze in the first pause, but should do it in the second pause." と述べる。Fig. 1 でも第1のポーズは p_now がロボット側で視線は User、第2のポーズは p_now が利用者側へ振れて視線は Away【図読】。
   - 修正案: 「AI 発話中のポーズで、VAP が相手側への移行を予測した（p が AI 側を支持しない）ときに視線を逸らす。移行を予測しないポーズでは逸らさない。」
   - 原著は p_now と p_future のどちらで判定するかを述べていない。Fig. 1 では p_now が反転し、p_future は 0 付近にとどまる【図読】。判定式は `policy.ja.json` の設定にする。
2. **§4.2 に追加の検討:** Fig. 1 では VAP の反転の頃から発話開始まで視線が Away。IV-B はベースラインの説明として「応答の生成を始めるとき」に視線を逸らすと述べる。V-D には提案システムでの開始前の視線の記述がなく、図だけが根拠。入れるかどうかを E1 で決める。
3. **§1.1 の「擬似コードの細部」:** 「擬似コード『即時』」を「擬似コードは停止点を規定しない」に修正（I-2）。
4. **§4.1:** U-1、U-2、U-4、U-5 を解釈の決定に追加。特に U-2 と U-4 は原文どおりに写すと不具合になるので、F の `step` の型を固定する前に E へ伝える。I-3 も既定を決める。
5. **§4.4 / R3:** 確認対象に「公開の重みは SODA 学習版か」を追加。§1.1 の「GPT-2／DialoGPT」と III-A の「GPT-2＋SODA」は同じものとは限らない。
6. **R2:** 原著の文脈 30 秒と MaAI の既定 `context_len_sec=20`（`maai/model.py`）が異なる。計画の助走 10 秒【暫定】でモデルの文脈が十分かは原著から分からないので、R2 の実測に含める。

## 6. 原著と今回の相違

| 項目 | 原著【原文】 | 今回 | 状態・注意 |
|---|---|---|---|
| 言語、話者 | 英語の母語話者39名（米国31、他8） | 日本語。参加者はこれから | 相槌や文末の振る舞いの差は未測定 |
| 身体、提示 | Furhat（投影の顔、機械の首）、対面 | ブラウザ3D（VRM）、画面越し | 視線の効き方が同じとは限らない。未検証 |
| 音声入力 | 接話マイクのヘッドセット（エコー消去を避けるため） | ヘッドセットを基本 | 同じ方針。Web Audio の遅延は別途測定 |
| ASR | Google Speech-to-Text（版の記載なし） | Google STT v2、開発用に ReazonSpeech | 更新の粒度は R4 で確認。日本語の分かち書きの差で 200ms の条件の意味が変わりうる |
| LLM | OpenAI gpt-3.5-turbo（Azure）、約 800 語のプロンプト | Gemini Flash 系（既定 flash-lite、実測で選定） | 実呼び出しは未検証 |
| TTS | ElevenLabs ストリーミング、声 Jennifer | ElevenLabs `eleven_flash_v2_5` 候補 | PCM と語境界の精度は R4 |
| VAP モデル | stereo、Fisher Part 1＋Switchboard、米国英語の電話、約 1000 時間 | MaAI 2ch `jp`（Travel Agency Task Dialogue、Human-Robot Dialogue、Online Conversation Dataset）または `jp_kyoto`（Online Conversation Dataset のみ） | 学習データが違うので p の分布も閾値の意味も同じとは限らない。MaAI 文書による |
| VAP の出力 | スカラー p_now、p_future | 各2要素（合計 1.0）、別に `vad` | 窓は 0–600ms と 600–2000ms で同じ（MaAI 文書） |
| VAP の周期、文脈 | 例として 10Hz、過去 30 秒 | `normal-ver2` は 12.5Hz、`context_len_sec` 既定 20 秒 | 構成は R2 で確定 |
| VAP の入力 | TTS 出力を自己入力 | 実再生 PCM | 計画の方が具体的。同一性は未確認 |
| ターン完了 | TurnGPT（GPT-2、SODA、英語）、RTX 2080 | TurnGPT を検証、不適なら代替。GPU なし | 代替の p の尺度は TurnGPT と異なり、L16〜L19 の表をそのまま使えない。推定器ごとに閾値表を持つ |
| 類似度 | all-MiniLM-L6-v2、0.8 | 文字 n-gram コサイン | 尺度が違うので 0.8 を流用しない |
| 計算機 | 8GB RTX 2080 | Ryzen 7 7735U、WSL2、GPU なし | 遅延は別物。実測のみ報告 |
| 場面 | 倫理ジレンマ、ロボットが主導 | 利用者が長く話す場面を含む | VIII が「利用者主導は今後」と述べており、原著の外 |
| 比較 | ベースラインとの被験者内比較 | 比較実験はしない | 効果を主張しない |
| 追加機構 | なし | 発話希望、候補の更新と撤回、吸気 | 原著の結果を根拠にしない |
| 開始の条件（ja のみ） | L67 と L74 の最小は 500ms。AI の発話の終わりで計時を変えない | ja だけ `turn.start_guard`（最小の間 900ms、L74 は p_now_ai < 0.5 なら 1500ms 以上）と `turn.after_ai_speech`（AI の発話の終わりで L57 と L71 の時計を数え直す、AI の発話中の短い断片に応答しない）。**hri2025 は原著どおり**（`controlSettings` で null、試験で固定） | 原著にない。根拠は実機の1セッションのみ（`docs/known_gaps.md` §10） |

## 7. 読めなかった箇所、確認の限界

- Fig. 2、5、6、7 の画像は見ていない（本文と凡例のみ）。Fig. 1、3、4 は画像を確認した。【図読】の値は概算である。
- Appendix C は冒頭のみ、Appendix D は未読。参考文献の [19]（TurnGPT）、[20]、[45]（VAP）の原典は未読。
- arXiv の最新版は v1 と確認した。HRI の出版版との差は確認していない。
