# AI の声のばらつき（ElevenLabs、2026-11-09）

「声のブレを減らしたい」への対応。**発話ごとに声の高さ・調子・話速・音色が変わる**ことと解釈して測った。発話の途中の揺れや再生側の問題（音切れ、再生速度）は測っていない。

**人が聞いて確かめた結果はない。** 以下は音響の指標だけで、聞こえの安定を示さない。

## 結論

- **採用: `seed` の固定（`multi-stream-input` の接続のクエリ）。既定 20261109（値に意味はない、暫定）。** voice_settings は送らない（登録済みの声の設定のまま）。
- 測定で言えること:
  - 同じ文の繰り返しは、波形が同一になった（seed を付けた 2 条件の 40 テイクの組 60／60、実装経由でも 2 組／2 組）。**seed なしの 2 条件では 0／60。**
  - 別の文の間の音量のばらつき（RMS の SD）が約半分になった（下の表 2。ただし文は 5〜8 文で区間は広く、別の seed の区間は 1 を含む）。
  - 最初の音声までの時間は変わらなかった。
- **言えないこと: 別の文の間の声の高さの差は減っていない**（表 2 の F0、比 1.00、区間 0.59〜1.79）。短い発話が長い発話より低い傾向（表 3）も残る。これらは文の中身の違いでも生じるので、ばらつきとは分けられない。
- stability は変えない（既定の登録値 0.76 のまま）。0.9／1.0 は同じ文の揺れを減らす傾向はあるが区間が広く、別の文の間の差は減らず、資料は単調になる危険を述べている。聞いて判断する項目として残す。

## 経路（変更前）

- `apps/orchestrator/src/providers/tts/elevenlabs.ts`、`eleven_flash_v2_5`、`multi-stream-input`、`pcm_24000`、`auto_mode`、`sync_alignment`、`language_code=ja`。
- `voice_settings` も `seed` も送っていなかった。声には登録時の設定が使われていた（GET `/v1/voices/{id}/settings` の実測: stability 0.76、similarity_boost 0.67、style 0、use_speaker_boost true、speed 0.98）。資料の API の既定（0.5／0.75）とは違う。
- 声は `category=professional`（PVC）。`high_quality_base_model_ids` に Flash は入っていない（意味は資料で確認できなかった）。
- 文の区切りごとに `flush`（`speech_generator.ts`）、発話ごとに文脈を分ける。

## 資料で確認したこと（2026-11-09）

| 項目 | 内容 | 出典 |
|---|---|---|
| `seed` | HTTP: 「best effort で決定的に」「決定性は保証しない」、0〜4294967295。`multi-stream-input` にも同じ範囲のクエリ `seed` がある（効果の説明はない） | [stream](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)、[multi-stream-input](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input) |
| `voice_settings` | 文脈の初期化メッセージで渡せる（送信などの他のメッセージの型にはない）。speed は 0.7〜1.2 | [multi-stream-input](https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input) |
| stability | 低いと感情の幅が広がりランダム、高いと単調になりうる。「50 がよい出発点」。AI は非決定的で同じ設定でも結果は異なる | [製品ガイド](https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech) |
| style、speaker boost | style は 0 以外で遅延が増えうるので 0 推奨。speaker boost は「わずかに」遅延が増える（数値なし） | 同上 |
| `previous_text`／`next_text` | HTTP のみ。WS の資料に記載なし | [stream](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)、[request stitching](https://elevenlabs.io/docs/eleven-api/guides/how-to/text-to-speech/request-stitching) |
| `language_code` | HTTP の資料は `multilingual_v2` では非対応と記載 | [stream](https://elevenlabs.io/docs/api-reference/text-to-speech/stream) |
| モデル | Multilingual v2 は Flash より遅く高い。`eleven_v4_turbo` は別プロトコルで今回は測っていない | [models](https://elevenlabs.io/docs/overview/models)、[TTS vs TTD WS](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets) |

## 方法

- 文は試験用に自作（`tools/provider_probe/tts_consistency.mjs` の `SENTENCES`、1 文 40 字以内）。短い発話 5、中程度 3、長い発話 5。
- 本番と同じ手順: 条件ごとに WS を 1 本開き、空白で文脈を開く→本文→flush→close_context、`pcm_24000`。条件と文の順は混ぜた（固定の乱数）。最初の音声までの時間（TTFB）は「本文を送った時刻→最初の音声の受信」で、接続の最初の 1 回は除いた。
- 解析は `tools/provider_probe/tts_consistency_analyze.py`（Praat の自己相関、話者適応の 2 段階の F0 推定、10ms 刻み）。F0 は 100Hz 基準の半音。話速はモーラ／秒（手で数えた読み）。有音区間は RMS がピーク −35dB を超える範囲。
- 区間は bootstrap（繰り返しの再標本化、文の再標本化）。文数と繰り返しが少ないので区間は広い。

実 API の使用: **148 回**（上限 150、ElevenLabs 2700 文字）。内訳は下の各表の n、ほか「speed の確認」2 回と実装経由の確認 4 回。生成した音声はリポジトリに入れていない。

**速度の確認:** 文脈の最初のメッセージの `speed` 0.8 と 1.2 で 1 文ずつ生成し、音声長が 4.96 秒と 3.24 秒（比 1.53、設定の比 1.5）。`voice_settings` は文脈ごとに効いている。

## 結果

### 表 1. 同じ文を繰り返したときのばらつき（プールした SD）

5 文（短 2、中 1、長 2）。Flash、`multi-stream-input`。TTFB は warm の中央値／90 パーセンタイル（n）。

| 条件 | n（文×繰返し） | F0 中央値 SD（半音）[95%] | F0 範囲 SD（半音） | RMS SD（dB） | 話速 SD（モーラ/秒） | 重心 SD（Hz） | 同一の波形 | TTFB ms |
|---|---|---|---|---|---|---|---|---|
| base（変更前） | 5×4 | 0.89 [0.46, 0.96] | 2.16 | 2.06 | 0.155 | 80 | 0/30 | 161／168（19、外れ値 1213） |
| stability 0.9 | 5×4 | 0.73 [0.30, 0.81] | 1.98 | 0.90 | 0.098 | 89 | 0/30 | 163／175（19） |
| **seed（採用）** | 5×4 | **0.00** | 0.00 | 0.00 | 0.000 | 0 | **30/30** | 160／171（19） |
| stability 0.9 + seed | 5×4 | 0.00 | 0.00 | 0.00 | 0.000 | 0 | 30/30 | 162／175（19） |
| stability 1.0（参考） | 5×2 | 0.47 | 0.77 | 0.45 | 0.059 | 37 | 0/5 | 177／192（9） |
| Multilingual v2（参考） | 5×2 | 1.86 | 2.91 | 0.45 | 0.319 | 132 | 0/5 | 334／505（9） |
| HTTP + `previous_text`（参考） | 5×2 | 1.21 | 0.67 | 1.24 | 0.357 | 96 | 0/5 | 190／213（9、HTTP なので接続の条件が違う） |

stability 0.9 の base に対する比は F0 で 0.82 [0.36, 1.44]、話速で 0.63 [0.37, 1.51] で、ばらつきは区別できない。参考の行は 2 回ずつで区間が付かない。Multilingual v2 は資料に従い `language_code` なしで生成した。

実装（`ElevenLabsTtsProvider`、env の既定）を通した確認: 2 文を 2 回ずつ生成し、2 組とも同一の PCM、TTFB 169〜184ms（n=4）、失敗なし。

### 表 2. 別々の文の間のばらつき（文ごとの平均の SD）

追加の 8 文（短 3、中 2、長 3）を各条件 1 回ずつ生成。seed2 は別の seed（777）。比は base に対する値で、文の対応ありの bootstrap。

| 条件 | n（文×1） | F0 中央値 SD 半音（比 [95%]） | RMS SD dB（比 [95%]） | 話速 SD（比） | 重心 SD Hz（比） | TTFB ms |
|---|---|---|---|---|---|---|
| base | 8 | 3.17 | 1.85 | 0.49 | 256 | 168／172（7） |
| **seed** | 8 | 3.16（1.00 [0.59, 1.79]） | **0.89（0.48 [0.26, 0.83]）** | 0.60（1.21 [0.83, 2.15]） | 277（1.08 [0.82, 1.29]） | 163／168（7） |
| seed2 | 8 | 3.39（1.07 [0.79, 2.43]） | 0.99（0.54 [0.32, 1.18]） | 0.62（1.26 [0.91, 1.82]） | 280（1.09 [0.86, 1.43]） | 171／180（7） |
| stability 0.9 | 8 | 2.95（0.93 [0.71, 1.41]） | 1.65（0.89 [0.32, 1.55]） | 0.53（1.07 [0.58, 1.32]） | 318（1.24 [0.96, 1.48]） | 167／179（7） |

（表 1 の 5 文でも base に対する RMS の比は seed で 0.40 [0.23, 0.90]。）

別の文の間のばらつきの大半は文の中身の差で、ここで測っている SD はそれを含む。比が小さいほどよいとは限らない（イントネーションの差は自然な差でもある）。

### 表 3. 短い発話 − 長い発話（平均の差）

| 条件 | 5 文（表 1）F0 差（半音）、話速差 | 8 文（表 2）F0 差、話速差 |
|---|---|---|
| base | −5.64、+0.92 | −2.62、+0.65 |
| seed | −4.19、+1.28 | −1.85、+0.66 |
| stability 0.9 | −5.01、+1.07 | −3.48、+0.61 |
| Multilingual v2（2 回ずつ） | +1.64、−1.22 | 測っていない |

短い発話（「そうですね。」など）は長い発話より声が低く、話速が速い傾向。seed でも残る。「ブレ」と聞こえるものの一部がこれなら、今回の変更では直らない。

## 変更

- `ElevenLabsOptions.seed`（既定 20261109）と `voice_settings`（既定 null、送らない）。文脈の初期化メッセージと接続のクエリに載る。
- 環境変数: `ELEVENLABS_SEED`（整数、`off` で付けない）、`ELEVENLABS_STABILITY`、`ELEVENLABS_SIMILARITY_BOOST`、`ELEVENLABS_STYLE`、`ELEVENLABS_SPEED`、`ELEVENLABS_SPEAKER_BOOST`。不正な値は起動時に失敗する。省略した項目のサーバー側の扱いは資料に記載がないので、変えるなら全部指定するのが確実。
- manifest に `tts_settings`（モデル、`language_code`、`voice_settings` と出所、`seed`）を残す。
- 通常応答の開始を遅らせる変更はない（判定待ちも事前生成もしない）。

## 聞いて確かめる手順

1. 生成済みの比較（リポジトリの外の一時領域、消えていることがある）: `/tmp/claude-1000/-home-yuuto-projects-LLM-VAP-DEMO/decdc084-3db4-4dd0-b832-ab2a19777949/scratchpad/lane_voice/raw/wav/` の `main_base_*` と `main_seed_*`（同じ文の 4 テイク）、`panel_base_*` と `panel_seed_*`（別の文）。
2. 実会話: `.env` の `ELEVENLABS_SEED=off` と未設定（既定）で同じ話題を話し、声の変わり方を比べる。stability を試すなら `ELEVENLABS_STABILITY=0.9` など（単調さも聞く）。使った値は `sessions/<id>/manifest.json` の `tts_settings` にある。
3. 再測定: `tools/provider_probe/` で `node --env-file=../../.env tts_consistency.mjs --out <DIR> --conditions base,seed --sentences s1,s2,m1,l1,l2 --reps 4 --tag x --yes`（上限 `--max-calls`、既定 150）の後、`pip install --target <DIR2> praat-parselmouth` して `PYTHONPATH=<DIR2> ../../.venv/bin/python tts_consistency_analyze.py --raw <DIR> --tag x --out <FILE>`。

## 限界

- 文は 13 文、声は 1 つ、時刻は 1 回の実行だけ。別の声、別のプラン、別の地域では違いうる。
- 表 2 は文 8 件で、区間が広い。参考の条件は 2 回ずつ。
- seed の結果は、同じ文を順に生成した場合。LLM の応答はストリームの分割と読みの変換で送るテキストが毎回違うので、実会話で同じ波形にはならない。
- 複数の文脈を同時に生成した場合と、一つの応答の中の文の間（flush のたび）の変化は測っていない。
- F0 の範囲は発話末の下降を含む 12〜13 半音で、絶対値の解釈はしない。条件の比較にだけ使う。
- `previous_text` は WS の資料になく、比較は HTTP で行った。request stitching を使うには経路の変更が要る。
- 別の解釈（話している途中の揺れ、再生の揺らぎ）は未測定。
