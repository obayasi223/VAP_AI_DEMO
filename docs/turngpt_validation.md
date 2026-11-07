# TurnGPT 検証（レーン R3）

調査日 2026-11-08。仕様 §7、計画 §4.4 に対応する。

## 1. 判定

| 対象 | 判定 | 根拠 |
|---|---|---|
| 原著 TurnGPT（英語、GPT-2、SODA 学習。HRI 2025 が使用） | **未検証** | 学習済みの重みの公開配布を確認できなかった。学習は範囲外。英語の素の GPT-2／DialoGPT で代用しない |
| TurnGPT-jp（大阪大学 駒谷研の第三者モデル。TurnGPT の手法に倣って日本語で学習。原著とは別物） | **当機の CPU では不適**。日本語の判別は**部分的に合理的** | §4 の事前基準は 5 項目中 3 項目が合格、2 項目（途中の発話への発火率、遅延）が不合格。bfloat16 は未測定 |

**推奨: TurnGPT-jp は採用しない。既定は D の代替 A `ja_rules_v1` のまま置き換えない。**

- 遅延が 3 桁以上違う。TurnGPT-jp は当機で 1 回 0.7〜1.9 秒、`ja_rules_v1` は約 3µs。
- TurnGPT-jp は約 5.3GB のメモリを占め、当機の 9GB で MaAI と同居させるには重すぎる。CPU の取り合いで MaAI の実時間処理を妨げる（今回の検証中に実際に起きた）。
- 判別の精度も明確には上回らない。TurnGPT-jp は自作 55 例で AUC 0.95（質問 対 続く）。`ja_rules_v1` は控え n=60 で AUC 約 0.92（統括の報告による。評価セットが違い、R3 では未確認）なので、直接は比べられない。どちらも「文法的に終わるが続きがある」は解けない。
- 位置づけ: GPU が使える環境になったら、代替 B の候補として再評価する。それまでは `eval_ja.jsonl` での比較用に結果を残すだけにする（任意）。
- どの場合も「TurnGPT」とは呼ばない。使うなら「TurnGPT-jp（Kubo et al., SIGDIAL 2026、`ouktlab`）」とモデル名を開示する。

以下で「TurnGPT」と書くのは原著のみ。阪大のモデルは「TurnGPT-jp」と呼ぶ。代替の推定器も TurnGPT 再現とは呼ばない。

## 2. 入手経路の調査

### 2.1 原著

| 確認先 | 結果 |
|---|---|
| `ErikEkstedt/TurnGPT`（commit `64f7d8c`、2022-10-02） | 重みなし。全履歴にも重み形式のファイルなし。Releases 0 件。README は `load_from_checkpoint("PATH/TO/checkpoint.ckpt")` のみで、配布先の記載なし。推論コードの既定パス `runs/TurnGPT/...ckpt` は著者の手元の物 |
| 同リポジトリの issue（全 2 件） | 重みの配布に関する案内なし。#1 は学習時のエラー、#2 は tokenizer の修正（#2 は題名のみ確認） |
| Hugging Face（`turngpt`、`ErikEkstedt`、`ekstedt`、`skantze` で検索） | 著者名義の配布なし |
| 著者の他リポジトリ（公開 54 件） | 全件で Releases 0 件。関連しそうな 5 件（`conv_ssl`、`TMH_SpeechBot`、`rasalab2022`、`TTD`、`datasets_turntaking`）のファイル一覧に TurnGPT の重みなし（`conv_ssl` の `.ckpt` は VAP 用の例と見られ、未取得）。残り 49 件のファイル一覧は未確認 |
| EMNLP 2020 論文 | 脚注でコードのリポジトリを示すのみ。重みの配布の記述なし |
| HRI 2025 論文（arXiv 2501.08946 の HTML） | GitHub、Hugging Face へのリンクなし。「SODA の 385K 会話で学習」とのみ記述 |

結論: **原著の重みは公開経路では入手できない。** 著者への問い合わせは未実施なので、「存在しない」ではなく「公開配布を確認できない」である。

ライセンスは MIT（コードのみ）。依存は `transformers`、`tokenizers`、`pytorch-lightning`、`wandb`、`matplotlib`、`einops`、`pytest`（版の固定なし）と `datasets_turntaking`。原著のコードは実行していない。

参考: 公開リポジトリの README は GPT-2／DialoGPT を基礎とする学習手順で、話者埋め込みの扱いと投影ヘッドが論文時点から変わっている。論文の分析は含まれない（README に明記）。したがってコードから学習し直しても HRI 2025 のモデルとの一致は保証されない。

### 2.2 見つかった他の配布物

| 配布物 | 素性 | 判断 |
|---|---|---|
| `ouktlab/turngpt-jp-rinna-gpt1b-cejc`、同 `-refinement` | 下記 §3 | **検証した** |
| `yqyati/turngpt` の Release（`turngpt-gpt2-500step.tar` ほか） | 個人の卒業研究。英語データで GPT-2 small と Qwen3 を 500 step 学習 | 原著ではなく英語。取得もロードもしていない |
| `Yana5181/turn_gpt_finetune`（HF） | `.gitattributes` と README のみで、重みなし | 対象外 |
| `Throde/MyTurnGPT`、`mumair01/GPT-Monologue-to-Dialogue` | 重みのパスを外から渡す設定で、配布なし | 対象外 |

## 3. TurnGPT-jp の素性

| 項目 | 内容 |
|---|---|
| 配布元 | Hugging Face `ouktlab`。GitHub `osaka-dialogue/TurnGPT-jp`（プロフィール「Komatani Lab. Osaka University」）。両者のサイトはともに `www.ei.sanken.osaka-u.ac.jp` を指す。モデルカードから同リポジトリへリンクあり |
| 論文 | Kubo, Yamamoto, Takeda, Komatani, *Rethinking Binary Evaluation of Turn-Taking under Inherent Ambiguity*, SIGDIAL 2026（aclanthology.org/2026.sigdial-1.2）。脚注から同リポジトリへリンクあり |
| 基礎モデル | `rinna/japanese-gpt-1b`（MIT。GPT-2 系、24 層、2048 次元） |
| 学習データ | 日本語日常会話コーパス CEJC（577 対話、約 200 時間、人間どうしの日常会話。多人数を含む）。手書きの転記を前処理したもの。履歴は 4 ターン |
| ラベル | 話者の交替（次の話者は問わない）。出力は末尾の次トークンが `<ts>` になる確率 |
| 公開版の性能 | 手動ラベル 337 例の二値評価で bAcc 0.802（baseline、閾値 0.103）、0.802（refinement、閾値 0.073）。公開版は匿名化などの処理のため論文の値と異なる（README） |
| ライセンス | **重みは CC-BY-NC-4.0**、コードは MIT。本研究は非営利の修士研究なので条件に合う。THIRD_PARTY_NOTICES への記載が必要 |
| 配布形式 | safetensors（pickle なし）、`config.json` に `auto_map` なし、`trust_remote_code=false` |
| 固定した版 | baseline `f242be578cee6fff4ac89fee0ce7e63a73dd9813`、refinement `a2377593fdac2fdacc8f8f761e82f0181cc5a8b6`。SHA-256 は HF の LFS 値と一致（§6） |

**CEJC の利用条件と派生モデルの関係は未確定。** 研究用の公開ガイドラインは再配布にあたる発表の禁止と出典の明記を定めるが、モデルへの言及はなく、研究用の契約本文は見ていない。検索の要約によれば商用版の契約書サンプル（clrd.ninjal.ac.jp/cejc/CEJC_Commercial_1.pdf）は学習済みモデルを派生物に含めるが、原文は未読で、研究用に当てはまるかも不明。確認できたのは配布元が CC-BY-NC-4.0 で公開している事実までである。

### 原著との違い（一致しない）

| | 原著（HRI 2025 使用） | TurnGPT-jp |
|---|---|---|
| 言語 | 英語 | 日本語 |
| 基礎 | GPT-2 | rinna japanese-gpt-1b（24 層、`n_embd` 2048。重みは 5.2GB） |
| 学習データ | SODA 385K 会話（テキストの対話） | CEJC（話し言葉の転記）177,180 ターン |
| 話者の表現 | 2020 年の論文は話者埋め込みあり。HRI 2025 版の構成は未確認 | 語彙に追加されたのは `<ts>` と `<unk>` のみ。公開の推論コードは話者の情報を渡さない |
| p の尺度 | Appendix A の 0.1〜0.3 に対応 | 尺度は別物。公開の閾値は 0.103／0.073 で、用途も二値評価用 |

## 4. 日本語サンプルの推論

**評価セット:** `tools/turngpt_probe/eval_ja.jsonl`（**自作**、1 名の作成で、55 例。ASR 風に句読点なし）。実音声も STT も通していない。ラベルと基準は推論の実行前に固定した（`probe.py` の `CRITERIA`）。

| 種別 `category` | 例数 | 例 |
|---|---|---|
| 意味が続く `continues` | 15 | 雨が降っていたので |
| 文法的に終わるが続きがある `complete_with_continuation` | 15 | 話が三つあります |
| 明確に質問が終わる `question_end` | 15 | 明日の会議は何時からですか |
| 明確に言い切る `statement_end`（計画 §4.4 の「明確に終わる」用に追加） | 10 | ありがとうございました |

### 4.1 結果（入力は発話 1 つのみ、句読点なし）

| 基準（事前に固定） | baseline | refinement | bfloat16（baseline） |
|---|---|---|---|
| AUC（質問 対 続く）≧ 0.85 | **0.951 合格** | **0.942 合格** | 未測定（CPU で約 3 時間たっても終わらず、他レーンへの負荷のため中断） |
| 質問の発火率 ≧ 70%（公開閾値） | **93% 合格** | **100% 合格** | 同上 |
| 続くの発火率 ≦ 30%（公開閾値） | **40% 不合格** | **47% 不合格** | 同上 |
| 中央値 続く < 文法的に終わる | **0.089 < 0.445 合格** | **0.048 < 0.500 合格** | 同上 |
| 4 ターンの遅延 p95 ≦ 200ms | **不合格**（§5） | **不合格**（§5） | 同上 |

| 種別ごとの p の中央値［最小〜最大］ | baseline | refinement |
|---|---|---|
| 続く | 0.089［0.005〜0.488］ | 0.048［0.000〜0.617］ |
| 文法的に終わるが続きがある | 0.445［0.217〜0.762］ | 0.500［0.254〜0.716］ |
| 質問 | 0.694［0.066〜0.851］ | 0.709［0.079〜0.840］ |
| 言い切り | 0.582［0.433〜0.759］ | 0.588［0.341〜0.711］ |

以下は結果を見た後の探索的な集計で、事前の基準ではない。

| 閾値ごとの発火率（baseline） | 続く | 文法的に終わる | 質問 | 言い切り |
|---|---|---|---|---|
| 0.103（公開） | 40% | 100% | 93% | 100% |
| 0.2 | 27% | 100% | 93% | 100% |
| 0.3 | 20% | 87% | 93% | 100% |
| 0.5 | 0% | 40% | 80% | 80% |

### 4.2 読み取り

- **文の途中か完了かは分ける。** 語の途中や助詞で切れる例は低い（「うちの子供がこの前学校で」0.005、「それであのー友達に」0.011）。逐次の増分でも「明日の会議は何時から」0.089 →「ですか」0.786 と動く。
- **公開閾値は低すぎる。** 「続く」の不合格は主に「けど」「が」「ので」で切れる例（「行きたいとは思うんですけど」0.488、「お金はかかるけど」0.432、「明日の会議なんですが」0.352）。「けど」「が」で切り上げる言いさしは実際の会話にあるので、**全部が誤りとは言えない**。これらを除く 11 例の baseline の発火率は 18%。
- **「文法的に終わるが続きがある」は分けられない。** 言い切りとの AUC は 0.753（baseline）、0.640（refinement）で、全例が公開閾値を超えた。「理由は二つあります」のように次があると分かる例でも 0.325。文字列だけのモデルの限界と考えられる（私の解釈）。
- **上昇調でしか質問と分からない文に弱い。** 「もう昼ご飯食べた」0.066、「コーヒーと紅茶どっちがいい」0.326。韻律を持たないので当然である。
- **refinement の優位は見られない。** 差は例ごとの揺れの範囲で、55 例では判断できない。
- **句読点で大きく変わる。** 末尾に「。」を付けると「文法的に終わる」の中央値は 0.445 → 0.103、「続く」との AUC は 0.902 → 0.516 に落ちる（baseline）。**推定器へ渡す前に句読点を除く必要がある。** 学習時の句読点の扱いは論文に明記がなく未確認。
- **履歴の効果は判断できない。** `<ts>` で連結する形式は配布元に記載がなく**私の仮定**であり、履歴付きの例は 12 例（`complete_with_continuation` 5、`statement_end` 7）のみ。`continues` と `question_end` は履歴なしで未測定。

### 4.3 限界

自作、1 名の判断、55 例で、統計的な保証はない。例文は整った書き言葉寄りで、**実際の STT の途中結果（誤認識、言い直し、句読点）では未測定**。人とアバターの対話での応答遅延や割り込みへの効果も未測定（配布元の論文も下流の評価はしていない）。仕様 §7-2 の「収録」は実施していない（STT のキー未提供のため）。

## 5. 計算資源（当機: Ryzen 7 7735U、CPU のみ、メモリ 9GB）

`probe.py` の float32 の測定。各 20 回の p50／p95 で、1 ターンは 6 トークン、4 ターンは 49 トークン。

**他レーンの処理と同時に測った値である**（開始時のロードアベレージは約 10〜15、別プロセスが CPU 約 700% を使用）。静かな状態での値は未測定。

| | baseline p50／p95 | refinement p50／p95 |
|---|---|---|
| 4 スレッド、1 ターン | 755／916 ms | 716／791 ms |
| 4 スレッド、4 ターン | 1536／1654 ms | 1565／1867 ms |
| 8 スレッド、1 ターン | 999／1620 ms | 1094／1434 ms |
| 8 スレッド、4 ターン | 1338／1445 ms | 1438／2383 ms |
| ピークのメモリ（RSS） | 5.34 GB | 5.35 GB |
| ロード時間（ページキャッシュあり） | 3.4 s | 3.5 s |

- 事前の基準（4 ターンで p95 ≦ 200ms）を 7 倍以上超えた。原著の報告は GPU で約 20ms。
- 6 トークンでも 0.7 秒以上かかる。重み 5.2GB を毎回読むことが支配的だと推測され、履歴のキャッシュでは大きく縮まない見込み（推測、未測定）。最終位置だけを出力層に通す方法、キャッシュ、int8 量子化は未測定。
- **bfloat16:** ロードに 1 シャードあたり約 37 秒かかり、評価は約 3 時間たっても終わらなかった。他レーンへの負荷のため中断し、**未測定**。RSS は約 2.8GB だった。当機の CPU フラグに `avx512_bf16`、`avx512f`、`amx_bf16` は見当たらず、bf16 の演算が遅い経路になったと推測される（原因は未確認）。

## 6. 再現手順

推論は自前の `probe.py` で行い、配布元のスクリプトは読むだけで実行していない（`setup_ubuntu.sh` は `sudo apt` を含む）。`training_args.bin`（pickle）は取得していない。

```bash
S=<scratchpad>/r3
python3 -m venv --without-pip $S/venv                # 当機は ensurepip なし
PIP="<既存の venv>/bin/python -m pip --python $S/venv/bin/python"
$PIP install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu
$PIP install -r tools/turngpt_probe/requirements.txt
# 取得は版を固定し、safetensors、設定、tokenizer に限る（*.bin を除く）
#   snapshot_download(repo, revision=<§3 の版>, local_dir=$S/weights/<name>,
#     allow_patterns=["*.safetensors","model.safetensors.index.json","config.json",
#       "generation_config.json","added_tokens.json","special_tokens_map.json",
#       "tokenizer_config.json","spiece.model","README.md"])
cd tools/turngpt_probe
HF_HUB_OFFLINE=1 $S/venv/bin/python -I probe.py --model-dir $S/weights/baseline   --threshold 0.103 --name baseline
HF_HUB_OFFLINE=1 $S/venv/bin/python -I probe.py --model-dir $S/weights/refinement --threshold 0.073 --name refinement
# bfloat16（--dtype bfloat16）は当機では約 3 時間で終わらず中断したので、実行は勧めない
```

| ファイル | SHA-256 |
|---|---|
| baseline `model-00001-of-00002.safetensors` | `9037aedc12deba102ffda219f080a1e88049a3a6567765849a012ed9724fc273` |
| baseline `model-00002-of-00002.safetensors` | `366c49a5ba509b20fb316b152d661f95e6e5c0e8ccfeb422833c3966da210f02` |
| refinement `model-00001-of-00002.safetensors` | `72e502bc2da903d1976e016504c326c28207eae6a04b5931ba8b6785dbc21922` |
| refinement `model-00002-of-00002.safetensors` | `e17dc763fac806d254b4e59db8cc9672a627c22695cc5ed5f420b6c1a579285b` |
| `spiece.model`（共通） | `9dbbd4ddbe43941051ed35fd44ff0d9d1c00ed345f7fd4d1969df174110f0609` |
| `eval_ja.jsonl` | `637cbb66c2668f212bf329fc7c9892ea1041880c151b151c385702938f29de8d` |

結果は例ごとの値を含めて `tools/turngpt_probe/results_*.json`。重みはリポジトリに入れていない（scratchpad のみ、10GB）。

## 7. HRI 2025 近似度への影響

- **原著の TurnGPT は使えない。** 「HRI 2025 のテキスト推定器の再現」とは書けない。
- 日本語版を含むどの推定器を使っても、言語、学習データ、p の尺度が原著と異なる。Appendix A の `TURNGPT_PREPARE_THRESHOLD` 0.2、`TURNGPT_YIELD_TIMEOUTS` を原著の値のまま移しても同じ意味にならない。§4.1 では 0.2 で「文法的に終わる」が 100% 発火する。**推定器ごとに校正する**（計画 §4.4 のとおり）。
- 原著は英語、GPU（RTX 2080）で約 20ms と報告している。当機の CPU では同じ頻度で評価できない（§5）。
- 推定器なしの場合は VAP が譲渡を示さない限り上限 3000ms 待つ（仕様 §7-4）。近似度は下がると明記する。

## 8. 代替の方針

- 独立インターフェース `estimate(history, partial) -> p` を保ち、モデル名を開示する。
- **既定は代替 A `ja_rules_v1`**（文末形態のルール。レーン D）。代替 B（LLM または小型日本語モデル）の候補として TurnGPT-jp を検証した結果、当機では不採用（§1）。
- 比較は `eval_ja.jsonl` で行い、**`complete_with_continuation` は文字列では原理的に難しい**ので、ここの正解率で推定器を選ばない。評価セットは自作なので、実対話の記録が取れたら差し替える。
- 入力は句読点を除いて正規化する。

## 9. 計画の修正が必要な点（持ち主の統括へ）

1. 計画 §1.1 の「外部配布は【未確認】」を「原著は公開配布を確認できず。日本語版 TurnGPT-jp が 2026-06 に公開」に更新。
2. 計画 §4.4 の 1 に結果を追記する: 原著は「未検証（入手不可）」、TurnGPT-jp は「検証済み、当機の CPU では不採用（遅延とメモリ）。GPU があれば代替 B として再評価」。また、STT の句読点を除いてから推定器へ渡すことを §4.4 か STT の正規化の項に加える（§4.2 で句読点により値が大きく変わった）。`policy.ja.json` の `TURNGPT_PREPARE_THRESHOLD` 0.2 は原著の値の記録用で、`ja_rules_v1` の尺度とは別。
3. `DEPENDENCIES_LOCK.md` と `THIRD_PARTY_NOTICES.md` は持ち物外なので未記入。TurnGPT-jp を使うなら §3 の版と CC-BY-NC-4.0 を記載する。
4. 仕様 §7-2 の「収録」は STT のキーが来てから。今回はテキストのみ。
