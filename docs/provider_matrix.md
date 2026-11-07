# プロバイダ検証マトリクス（レーン R4）

- 確認日: **2026-11-08**（全項目共通）。§0〜§9 は公式資料と SDK のソースの確認で、**実呼び出しの結果は §10 に分けて書く**。§9 までの【要実測】のうち §10 で分かったものは、該当の行に「→ §10.x」と書く。資料と実測が違うときは実測を採る。
- 表記: **【確認】** 公式資料または SDK ソースに記載あり／**【記載なし】** 探した範囲の資料に記載がない／**【要実測】** 実呼び出しでしか確定しない（`tools/provider_probe/` で測る）／**【実測】** 実呼び出しの結果（§10）。
- 【確認】は「資料にそう書いてある」という意味で、実際の動作の保証ではない。
- 推定や計算は「**推定**」と明記する。遅延の値は公称値で、この環境の測定値ではない。

## 0. 出典

| 略号 | URL | 版 |
|---|---|---|
| G1 | https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3 | 最終更新 2026-10-26 |
| G2 | https://docs.cloud.google.com/speech-to-text/docs/quotas | 最終更新 2026-10-26 |
| G3 | https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages | 最終更新 2026-10-26 |
| G4 | https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/StreamingRecognitionResult | |
| G5 | https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize | 最終更新 2026-10-26 |
| G6 | https://docs.cloud.google.com/speech-to-text/docs/endless-streaming-tutorial | v1 と v1p1beta1 の内容 |
| G7 | https://docs.cloud.google.com/speech-to-text/docs/best-practices-provide-speech-data | |
| G8 | https://cloud.google.com/speech-to-text/pricing | |
| G9 | https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2 | 最終更新 2026-10-26 |
| G10 | https://docs.cloud.google.com/speech-to-text/docs/release-notes | |
| GS | npm `@google-cloud/speech` 8.2.1: `build/protos/google/cloud/speech/v2/cloud_speech.proto`、`build/src/helpers.js`、`package.json` | 2026-10-23 公開 |
| E1 | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input | |
| E2 | https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input | |
| E3 | https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket | |
| E4 | https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts | |
| E5 | https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization | |
| E6 | https://elevenlabs.io/docs/eleven-api/concepts/latency-methodology | 数値は 2026-10-29 更新 |
| E7 | https://elevenlabs.io/docs/overview/models | |
| E8 | https://elevenlabs.io/docs/api-reference/text-to-speech/stream | HTTP 版 |
| E9 | https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets | |
| E10 | https://elevenlabs.io/pricing/api | |
| A1 | https://aistudio.google.com/docs/models（`ai.google.dev/gemini-api/docs/*` はここへ転送される） | |
| A2 | https://aistudio.google.com/docs/pricing | |
| A3 | https://aistudio.google.com/docs/rate-limits | |
| A4 | https://aistudio.google.com/docs/structured-output | |
| A5 | https://aistudio.google.com/docs/thinking | |
| A6 | https://aistudio.google.com/docs/text-generation | |
| A7 | https://aistudio.google.com/docs/interactions.md | |
| A8 | https://aistudio.google.com/docs/migrate-to-interactions.md | |
| A9 | https://aistudio.google.com/docs/whats-new-gemini-3.6.md、https://aistudio.google.com/docs/whats-new-gemini-3.8.md | |
| A10 | https://aistudio.google.com/docs/terms | |
| A11 | https://aistudio.google.com/docs/api-key.md | |
| A12 | https://aistudio.google.com/api-reference/models.md | |
| AS | npm `@google/genai` 3.0.0: `package.json`、`dist/genai.d.ts` | |
| O1 | https://developers.openai.com/api/docs/guides/realtime-transcription | |
| T1 | https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-streaming | |

## 1. 計画の変更が必要な発見

| # | 発見 | 根拠 | 影響する箇所と変更案 |
|---|---|---|---|
| 1 | **`chirp_3` はストリーミングで語時刻を出せない。** 語時刻は `Recognize` と `BatchRecognize` のみ | G1【確認】 | §3.6、§4.1。§4 のとおり `resultEndOffset`（発話単位）と事後の整列で代替 |
| 2 | **`chirp_3` の interim 対応を明記した資料がない。** 公式の streaming サンプルは `interim_results` なしまたは `False` のみ。`stability` も同じ | G1、G5【記載なし】 | 仕様§5 の前提。**最初に測る。** 返らなければ `long`（ja-JP、`us`／`eu`／`global`）へ切り替え、それも駄目なら代替を検討 |
| 3 | **`@google-cloud/speech` 8.x と `@google/genai` 3.x は Node 22 以上が必要。** 計画の環境は Node 20 | GS、AS【確認】 | §1.2、`engines`。推奨は Node 24（この環境の nvm に v24.21.0 あり）。Node 20 のままなら `@google-cloud/speech@7.5.0`（最後の Node 18 以上対応）に固定し、Gemini は REST で呼ぶ |
| 4 | **SDK の `client.streamingRecognize()` は v2 に使えない。** helper が v1 の形（`recognizer` なし、`audioContent`）で書き込む | GS `helpers.js`【確認】 | レーン C。`client._streamingRecognize()` を直接使い、先頭で `{recognizer, streamingConfig}`、以後 `{audio}` を送る。公式の Node 版 v2 サンプルは見当たらない |
| 5 | **20ms ごとの送信は 3,000 要求/分の上限にちょうど達する**（50 要求/秒）。切替で2本重ねると倍になる | G2 脚注【確認】。ただし同じ表に 1,000,000 ともあり資料内で矛盾 | §3.2 の 20ms は内部の単位として維持し、Node → Google は **40ms に束ねる**。公式の推奨は 100ms（G7）で、差は実測する |
| 6 | **（訂正）資料の表には日本国内の ja-JP の行がないが、`long` は `asia-northeast1`（東京）で動く。** 資料の表は `chirp_3` と `long` が `us`／`eu`／`global`、`chirp_2` が `asia-southeast1` ほか | G3【確認】。動作は【実測】§10.3 | 「国内リージョンなし」の当初の主張は誤り。既定を `long` + `asia-northeast1` とする |
| 7 | **Gemini の `generateContent` は「legacy」扱いになり、新規には Interactions API が推奨。Interactions は既定で要求を保存する**（有料 55 日、無料 1 日） | A7、A8【確認】 | レーン D。Interactions を使うなら **`store: false` を必須**にする（人の発話の書き起こしを送るため） |
| 8 | **無料ティアの入出力はプロダクト改善と人のレビューの対象**（日本はこの例外地域に入らない） | A10【確認】 | §9 の用意。参加者の発話を送るなら**有料ティアのキー**を必須にする |
| 9 | **ElevenLabs の `alignment` は語単位ではなく文字単位の配列。** 資料の時刻はチャンク相対だが、実測では flush をまたぐと文脈の累積（§10.1） | E1、E2 スキーマ【確認】。ガイド E4 の「word-level」とは表現が異なる | §1.1 の「語単位」を訂正。§4.3 の語境界は累積時刻と `Intl.Segmenter` などで自前で作る。基準の違いは C が吸収して chunk 相対で渡す |
| 10 | **`multi-stream-input` があり、1接続で 5 文脈まで先行生成できる。無通信の上限も 180 秒まで延ばせる** | E2、E3【確認】 | §4.3 の「生成後に閉じて開き直す」を「**セッションで1接続を維持し、文脈を `audio_playback_id`＋世代に対応させる**」へ変更（§5 参照）。接続の遅延がなくなる |
| 11 | **既定の `chunk_length_schedule` は先頭 120 文字。** 日本語の短文では `flush` か `auto_mode` なしだと音声が始まらない | E1、E5【確認】 | レーン D。`auto_mode=true` を既定にし、文末で `flush` |
| 12 | **Gemini の中断はクライアント側のみで課金は止まらない。** `temperature`、`top_p`、`top_k` は無視され、将来は 400 になる | AS、A9【確認】 | §4.5 の「途中で中断しない」方針と整合。`ResponsePrefetch` の取消は費用を節約しない。温度を指定しない |
| 13 | **`gemini-3.8-flash` は `thinking_level: minimal` がエラー**（最低は `low`）。2027-01-01 に料金が2倍 | A5、A9、A2【確認】 | 既定を `gemini-3.5-flash-lite` + `minimal` とする判断を補強 |

## 2. Google Speech-to-Text v2

### 2.1 モデルとリージョン（ja-JP）

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| `chirp_3` | ja-JP は GA。`StreamingRecognize`、`Recognize`、`BatchRecognize` に対応。ページのリージョンは `us`、`eu`（マルチリージョン）。endpoint は `{region}-speech.googleapis.com` | 【確認】 | G1、G3 |
| `chirp_3` の他のリージョン | リリースノートに `asia-south1` などの preview があるが、ja-JP の表にはない | 【確認】 | G10、G3 |
| `long`、`short`、`telephony`、`telephony_short` | ja-JP は `global`、`us`、`eu` | 【確認】 | G3 |
| `chirp_2` | ja-JP は `us-central1`、`europe-west4`、`asia-southeast1`。状態の表記は「Private GA」、streaming の言語は「Limited」の一覧に ja-JP あり | 【確認】 | G3、G9 |
| `asia-northeast1` の ja-JP | 表に行がない。**`long` は実際に動く → §10.3** | 【確認】＋【実測】 | G3 |
| 最新の対応状況 | Locations API で取得できると案内。`node stt_locations.mjs` | 【要実測】 | G1、GS |
| Node のクライアント | `new v2.SpeechClient({apiEndpoint})`。`_streamingRecognize()` を直接使用（§1 の #4） | 【確認】ソース。実動作は【要実測】 | GS |
| 要求の順序 | 最初は `recognizer`＋`streaming_config` のみ、以後 `audio` のみ。`recognizers/_` で暗黙の Recognizer | 【確認】 | GS |

### 2.2 interim と stability

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| `interim_results` の項目 | `streaming_features.interim_results` | 【確認】 | GS |
| モデル別の interim 対応 | モデルの表にも各モデルのページにも記載がない | 【記載なし】【要実測】 | G1、G9 |
| `stability` の定義 | interim のみ。0.0〜1.0。**既定の 0.0 は「未設定」の印** | 【確認】 | G4、GS |
| `chirp_3` で `stability` が返るか | 記載がない | 【記載なし】【要実測】 | G1 |
| 公式が使う安定の基準 | `stability > 0.8` を「stable partial」として正規化の条件に使用 | 【確認】 | GS |
| 1応答の構造 | `results` は「final 0〜1個 → interim 0個以上」で、連続した音声部分に対応。応答には `results`、`speech_event_type`、`error` のどれか1つ | 【確認】 | GS |
| interim の累積 | **final 済みの部分は次の interim に含まれない**。全文は「final の連結＋現在の interim の連結」。interim は高安定と低安定に分かれることがある（proto の例） | 【確認】（例示）。日本語と `chirp_3` は【要実測】 | GS |
| final の分割の規則 | 「発話の区切り」としか書かれていない。`endpointing_sensitivity`（STANDARD／SHORT／SUPERSHORT）で調整可 | 【確認】。日本語の長さは【要実測】 | GS、G1 |
| 句読点 | `chirp_3` は自動で付き、無効化可。**interim と final で句読点の有無が変わるか**は記載なし | 【記載なし】【要実測】 | G1 |

### 2.3 時刻

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| `resultEndOffset` の基準 | 「音声の先頭」からの相対。ストリーム切替でどう数えるかの v2 の記載はない。v1 のサンプルはストリームごとに戻る前提で補正 | 【確認】＋【要実測】 | G4、G6 |
| offset が送信音声の位置か壁時計か | 資料は「音声の先頭」とだけ書く。`--mode pause` で確認 | 【要実測】 | G4 |
| `chirp_3` の発話単位の時刻 | 「Utterance-level timestamps: StreamingRecognize のみ」。interim にも入るかは記載なし | 【確認】＋【要実測】 | G1 |
| `chirp_3` の語時刻 | ストリーミング不可。`Recognize`、`BatchRecognize` は可（`BatchRecognize` は語時刻ありで 20 分まで、精度低下あり） | 【確認】 | G1 |
| `long`／`chirp_2` の語時刻 | 機能としてはある。ストリーミング、特に interim で返るかは記載なし | 【記載なし】【要実測】 | GS、G9 |
| 語時刻の精度 | 「実験的で精度は変動する」 | 【確認】 | GS |
| 音声イベント | `enable_voice_activity_events` で `SPEECH_ACTIVITY_BEGIN/END` と `speech_event_offset`。`chirp_3` のサンプルでも有効にしている | 【確認】。offset の実際の値は【要実測】 | GS、G1 |

### 2.4 制限

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| ストリーム時間 | **最大 5 分**。それ以上は endless streaming のチュートリアルへ | 【確認】 | G2 |
| 切替の手順 | v2 の手順はない。v1 のサンプルは「閉じて、未確定の末尾を再送」（Python は 4 分で切替、Java は 290 秒） | 【確認】（v1 のみ） | G6 |
| 実際に切れる時刻とエラー | `--mode limit` で確認 | 【要実測】 | |
| 送信ペース | 「実時間に近い速さで送る」。無音時の許容時間は記載なし | 【確認】＋【要実測】 | G2 |
| チャンク上限 | **資料により異なる:** 25 KB（G2、G5）／15 KB（GS の proto）。40ms は 1,280 バイトなので問題なし | 【確認】（矛盾あり） | G2、G5、GS |
| 推奨のフレーム | 100ms が遅延と効率の均衡点。16kHz 以上、LINEAR16 か FLAC、AGC を使わない | 【確認】 | G7 |
| エンコーディング | `explicitDecodingConfig: {encoding: 'LINEAR16', sampleRateHertz: 16000, audioChannelCount: 1}`。16000 が最適 | 【確認】 | GS、REST 参照 |
| 同時セッション | 300／5 分（リージョン単位） | 【確認】 | G2 |
| 要求数 | 表は 1,000,000／60 秒だが、脚注は全セッション合計で 3,000／分。設定要求は数えない | 【確認】（矛盾あり。低い方で設計） | G2 |

### 2.5 料金

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| V2 の Standard | $0.016／分（0〜50 万分） | 【確認】 | G8 |
| `chirp_3` の区分 | 脚注の一覧は `default、…、chirp` で **`chirp_3` の名前がない** | 【記載なし】。Standard と仮定。請求の SKU で確認 | G8 |
| 丸め | 要求ごとに 1 秒単位で切り上げ | 【確認】 | G8 |
| 無料枠 | V1 の表には 60 分無料があるが、V2 の表にはない | 【確認】 | G8 |
| 課金の基準 | 送信した音声の長さ。重ねた2本は両方に課金される（**推定**。資料は「チャネルごとに別課金」のみ） | 【要実測】 | G8 |

## 3. ElevenLabs

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| `stream-input` の `output_format` | WS のスキーマは型の記載なし（"Any type"）。HTTP 版は `pcm_8000/16000/22050/24000/32000/44100/48000` を列挙。`pcm_44100` は有料の上位プラン | 【確認】。**WS で `pcm_16000`、`pcm_24000` が通るか → §10.1** | E1、E8 |
| PCM の形式 | S16LE | 【確認】 | SDK `OutputFormat` |
| 高音質の形式と遅延 | 高音質の形式は遅延が増えることがある | 【確認】 | E5 |
| `alignment`／`normalizedAlignment` | `{chars: string[], charStartTimesMs: int[], charDurationsMs: int[]}`。文字単位。**時刻は返されたチャンク内の相対値**。音声チャンクと同じメッセージ。`sync_alignment` はクエリ（既定 false） | 【確認】 | E1、E2 |
| 日本語の単位 | `chars` に漢字と仮名がどう入るか、`normalizedAlignment` で読みに展開されるか、語境界の精度はいずれも記載なし。**単位と展開 → §10.1**。語境界の精度は未測定 | 【記載なし】＋【実測】 | E1 |
| `eleven_flash_v2_5` の日本語 | 対応（`ja`）。40,000 文字まで。**Flash 系の中で多言語対応はこれ** | 【確認】 | E7 |
| 代替モデル（同じ WS） | `eleven_multilingual_v2`（`ja` 対応、高品質で遅く料金は2倍）。`eleven_turbo_v2_5` は非推奨（Flash へ移行） | 【確認】 | E7 |
| 代替モデル（別プロトコル） | `eleven_v4_turbo`（約 100ms、90 以上の言語）と `eleven_v3_conversational` は Text to Dialogue WS のみ。項目が snake_case で、開いた接続ごとにセッションを消費。音声開始に約 40 文字と 8 語のバッファ | 【確認】 | E7、E9 |
| `eleven_v3`／`eleven_v4` | `stream-input` 不可 | 【確認】 | E4、E9 |
| 日本語の読みの補正 | `apply_language_text_normalization`（日本語のみ、「遅延が大きく増える」）は **HTTP 版のみ**。WS のクエリ一覧にない | 【確認】。漢字の読みの質は人の確認が必要 | E8、E1 |
| `language_code` | WS のクエリにある | 【確認】 | E1 |
| `auto_mode` | クエリ、既定 false。生成の契機を自動で扱い、チャンク管理が不要に | 【確認】。遅延と音質への効果は【要実測】 | E1、E5 |
| `chunk_length_schedule` | 既定 `[120, 160, 250, 290]`、各値 50〜500。**閾値に届くまで生成が止まる** | 【確認】 | E1、E5 |
| 最初の音声までの遅延（公称） | Flash v2.5 は約 100ms（中央値、サーバー側のみ、WS、使用済みの声）。ネットワークは含まない。料金ページは約 75ms と記載 | 【確認】（資料間で差あり） | E6、E7、E10 |
| 地域別の公称 TTFB | 北東アジア 150〜200ms、東南アジア 100〜150ms（Flash＋WS）。配信地域は米国、オランダ、シンガポール。`x-region` ヘッダで確認可 | 【確認】。実値は【要実測】 | E5 |
| `multi-stream-input` | あり。`context_id` で複数の文脈。**1接続 5 文脈まで**。割り込み時は `close_context` して新しい文脈を作るのが推奨。1ユーザーセッション1接続を推奨 | 【確認】 | E2、E3 |
| 文脈の取消 | `{context_id, close_context: true}`。flush 済みなら flush は続く。**送信中の音声がすぐ止まるかは記載なし → 止まらない、§10.1** | 【確認】＋【実測】 | E2 |
| 取消した分の課金 | 記載なし | 【記載なし】【要実測】（`tts_probe --mode billing`） | |
| 課金の単位 | 文字単位。Flash／Turbo は $0.04／1千文字、Multilingual v2 は $0.08。プラン同梱: Free 2 万字、Starter（$6）15 万字、Creator（$22）55 万字 | 【確認】 | E10 |
| 無通信の切断 | 既定 20 秒。`inactivity_timeout` で最大 180 秒 | 【確認】 | E1、E2、E3 |
| keep-alive | **`stream-input` は空白1文字**（空文字列を送ると接続が閉じる）／**multi は `{context_id, text: ""}`** | 【確認】 | E4、E2 |
| 並行接続の上限 | Flash は Free 4、Starter 6、Creator 10、Pro 20。**生成中の時間だけが数えられ、開いているだけの接続は数えない** | 【確認】 | E7、E9 |
| ログの保持 | `enable_logging=false`（保持なし）はエンタープライズのみ | 【確認】 | E8 |

## 4. Gemini

| 項目 | 内容 | 状態 | 出典 |
|---|---|---|---|
| モデル ID | `gemini-3.5-flash-lite`（Stable、既定 thinking は minimal）、`gemini-3.8-flash`（Stable、既定 medium）、`gemini-3.6-flash`（Stable）。別名 `gemini-flash-latest` あり | 【確認】 | A1、A5 |
| モデル一覧の取得 | `GET /v1beta/models`（`supportedGenerationMethods` など）。`node gemini_probe.mjs --mode models` | 【確認】＋【要実測】 | A12 |
| トークン上限 | 両モデルとも入力 1,048,576、出力 65,536 | 【確認】 | A1 |
| API の選択 | Interactions が推奨（2026-06 に GA）、`generateContent` は legacy だが「完全にサポート」 | 【確認】 | A7 |
| Streaming（Interactions） | `POST /v1beta/interactions?alt=sse`、`stream: true`、`Api-Revision: 2026-05-20`。`step.delta` の `delta.type=text`、最後に `interaction.completed` | 【確認】 | A6、A8 |
| Streaming（generateContent） | `POST /v1beta/models/{id}:streamGenerateContent?alt=sse`。SDK は `generateContentStream` | 【確認】 | A8 |
| Structured output（Interactions） | `response_format: {type: 'text', mime_type: 'application/json', schema}` | 【確認】 | A4 |
| Structured output（generateContent） | `responseMimeType`、`responseJsonSchema` | 【確認】 | A4 |
| Structured output の制限 | `enum` は可（多いと複雑度で拒否）。`minLength` 等は無視。ストリームの断片は連結で JSON になる。項目順の保証は未確認 | 【確認】＋【要実測】 | A4 |
| 3.5 Flash-Lite の対応 | Structured outputs、thinking、caching | 【確認】 | モデルページ |
| Thinking の指定 | Interactions は `generation_config.thinking_level`、generateContent は `thinkingConfig.thinkingLevel`。`thinking_budget` からの移行が案内されている | 【確認】 | A5、A9 |
| Thinking の下限 | flash-lite は `minimal`。3.8-flash は `low`（`minimal` はエラー）。**完全な無効化は不可**。思考トークンも課金 | 【確認】 | A5、A9 |
| 要求の中断 | SDK は `abortSignal`（Interactions は fetch の `signal`）。**クライアント側のみで課金は続く** | 【確認】 | AS |
| サンプリング | `temperature`、`top_p`、`top_k` は 3.6／3.5-lite 以降で無視され、将来 400。`candidate_count` と model の先頭埋めも不可 | 【確認】 | A9 |
| 料金 3.5-flash-lite | 入力 $0.30、出力 $2.50（100 万トークン）。キャッシュ $0.03。無料枠あり | 【確認】 | A2 |
| 料金 3.8-flash | 入力 $0.75、出力 $3.75 → **2027-01-01 から $1.50、$7.50** | 【確認】 | A2 |
| Priority | 上記の 1.8 倍程度（3.5-lite は $0.54／$4.50）。低遅延向け。上限は標準の 0.3 倍 | 【確認】 | A2、A3 |
| レート制限 | テキストモデルの RPM／TPM は資料に数値なし。**AI Studio の画面で確認**。ティアは Free、Tier 1（支払い設定で上限 $250）ほか | 【記載なし】AI Studio で確認 | A3 |
| データの扱い | 無料ティアは改善と人のレビューの対象。有料は学習に使わないが、不正利用の検知で一定期間記録 | 【確認】 | A10 |
| 保存 | Interactions は既定 `store=true`（有料 55 日、無料 1 日。有料は 7〜55 日で設定可）。`store=false` で無効 | 【確認】 | A7 |
| API キー | AI Studio の新しいキーは 2026-05-28 以降 auth key。制限のない standard key は拒否 | 【確認】 | A11 |
| 実際の遅延（最初のトークン、`decision` の確定） | 公称値なし | 【要実測】 | |
| 日本語 ASR の途中文からの判定の質 | | 【要実測】（§4.5a のスパイク） | |

## 5. 代替の概要

| 候補 | 要点 | 状態 | 出典 |
|---|---|---|---|
| OpenAI `gpt-live-transcribe` | `wss://api.openai.com/v1/realtime?intent=transcription`。PCM 24kHz の例。`delta` と `completed` イベント。`delay` で遅延を調整。**語時刻と信頼度なし**、サーバー VAD なし（クライアントが commit）。`stability` に相当するものなし | 【確認】 | O1 |
| Google TTS Chirp 3 HD streaming | streaming は Chirp 3 HD のみ。文字を順に送る。出力形式、制限、時刻情報はそのページに記載なし | 【確認】 | T1 |
| （資料で気づいた候補）Gemini Live `gemini-3.5-transcribe-live` | interim の書き起こしあり、一覧に ja-JP あり。検討範囲外で、確認はこれだけ | 【確認】 | aistudio.google.com/docs/live-api/live-transcribe |

## 6. 計画の未確認事項への回答

**いずれも資料からの設計案で、`【要実測】` の項目が確定したら見直す。** `tools/provider_probe/` の要約 JSON の項目名を併記する。

### 6.1 `stability` 不在時の扱い（§4.5）

1. **`stability === 0` を「不安定」と扱わない。** 資料上 0.0 は未設定の印。`> 0` のときだけ値として使う。そうしないと、返らないモデルで合図が永久に出なくなる。
2. 返るモデル: 先頭から連続して `stability ≥ θ` の interim の部分を「安定テキスト」とする。θ の初期値は 0.8【暫定】（公式の正規化の基準）。
3. 返らないモデル: **「連続 N revision で不変の接頭部」＋「経過時間の下限」** を安定テキストとする（初期値 N=3、300ms【暫定】）。revision の間隔が短いと N だけでは時間の保証がないため、両方を要求する。比較は句読点と空白を除いて行う。
4. **F の契約への変更依頼:** `stt.interim` の `stability` を nullable にし、`stability_source: provider | derived` を追加する。§4.5a の「ASR 誤認で吸気を抑止」の試験はどちらの経路でも通す。
5. 判断の項目: `stability.returned`、`interim_gap_ms`、`revision_behaviour.rewritten`。

### 6.2 ストリーム切替の設計（§8）

資料にあるのは v1 の「閉じて再送」のみ。ここでは「実時間に近い速さで送る」制約（G2）に触れる再送を避け、計画どおり**重ねて切り替える**方式を推奨する。

1. **開始:** 240 秒で新しいストリーム B を開き、以後は同じ音声を A と B の両方へ送る。A の期限は 285 秒【暫定】。
2. **切替点 H:** 重複中に A から `SPEECH_ACTIVITY_END` または final が来て、VAP も無音なら、その位置を H とする。期限までに無音がなければ、期限で H を決める。
3. **時刻:** 各ストリームに `base_frame`（B に最初に送った音声の `audio_frame`）を持ち、`audio_frame_end = base_frame + offset × 16000` とする。**送信の欠落があると offset がずれるので、送信済みサンプル数と `audio_frame` の対応表を持つ。**
4. **採用の規則:** A は end ≤ H の結果を採用して閉じる。B は end > H の結果を採用する。B の final が H をまたいだら、A の最後の final の接尾部と B の接頭部を比較して重複を除き（句読点を除いて比較）、`handover_precision` をログへ残す。
5. **`segment_id` と revision は切替で変えない。** `stt.interim` はストリームを意識させない。切替中の A の未確定 interim は、B の結果が H を越えるまで保持する。
6. **費用:** 重複 10 秒で約 $0.003（**推定**）。5 分対話で1回。
7. **要求数:** 40ms 送信なら通常 25 要求/秒、重複中 50 要求/秒で、1分あたりの上限（3,000）に収まる。
8. 判断の項目: `--mode handover` の `b_max_end_ms`／`b_sent_audio_ms`（offset の基準）、`text_overlap_chars`。`--mode limit` の `closed_at_s`。

### 6.3 §4.1 の segment の境界規則

`chirp_3` では語時刻がないので、**語の位置ではなく revision の単位でしか分けられない。**

1. 境界 B（AI の発話開始、`audio_frame`）で、**`end ≤ B` の最新の revision の本文（全文のうち未確定部分）をスナップショット**として記録する。
2. 後から来た結果の所属:
   - `end ≤ B` の final → 旧 segment。
   - `end > B` の final で、本文がスナップショットで始まる → スナップショット分を旧へ、残りを新へ。
   - `end > B` の final で、本文がスナップショットで始まらない（訂正が入った）→ **共通接頭部までを旧へ**、残りを新へ。`segment_boundary_precision: revision` を記録する。
   - `end > B` の interim → スナップショットとの差分を新 segment へ。
3. 「累積の接頭部を差し引く」は**未確定部分の中だけ**に適用する。final 済みの部分は次の interim に含まれない（§2.2）ので、全文から差し引くと語尾を失う。
4. 精度の上限は `precision_ms`（境界と直前の revision の差）。`interim_gap_ms` と同程度の見込み（**推定**）。
5. `SPEECH_ACTIVITY_*` の `speech_event_offset` が実用的なら、ユーザーが B の前後で話していない判定に使う。無音で B を越えたら、未確定の全体を旧 segment に確定してよい。
6. 判断の項目: `segment_boundary`（`final_starts_with_snapshot`、`precision_ms`）、`speech_events`。

### 6.4 §3.6 の `t_content_evidence`

| 区分 `evidence_time_precision` | 求め方 | 使える時 |
|---|---|---|
| `word_offset` | `long`／`chirp_2` で interim に語時刻が返るなら、その語の `end_offset` | 【要実測】。`chirp_3` では不可（§1 の #1） |
| `result_end_offset` | その span を初めて含む revision の `resultEndOffset`。**証拠の実時刻以降の値になる（上限）。** 計画の近似のとおり | interim に offset が入るなら。`result_end_offset.on_interim_share` |
| `arrival_minus_rtt` | offset がない場合の代替。受信時の送信済み音声位置。さらに粗い | 最後の手段 |
| `posthoc_alignment` | **保存した音声を `chirp_3` の `Recognize`（1 分まで）または `BatchRecognize` で語時刻つきで再認識**するか、ローカルの ReazonSpeech で整列し、span の末尾を求める | 分析時。録音がオプトインのセッションのみ |

- **オンラインのゲートには `t_content_evidence` を使わない**（判定は `t_transcript` と鮮度の規則で足りる）。これは報告用の値なので、**事後整列を正式な値、オンラインの値を近似**として別々に記録する案を推奨する。
- 近似の誤差は `stt_probe --posthoc-words` の `evidence_time` で測れる。論文などの報告には区分を必ず併記する。
- `t_transcript − t_content_evidence` には、STT 処理に加えて日本と米国の往復が入る（§1 の #6）。

### 6.5 §4.3 の語時刻（発話済みテキスト）

1. `sync_alignment=true` を指定する。**チャンク相対なので、文脈ごとに「それまでの PCM のサンプル数 ÷ サンプルレート」を各チャンクの時刻に足して累積**する。
2. 語境界は `alignment` の文字列に `Intl.Segmenter('ja', {granularity: 'word'})` をかけて作る。Node に標準であり、追加の依存がない。形態素の精度が足りなければ見直す。
3. **発話済みテキストは `alignment`（入力文字）を基準にする**。`normalizedAlignment` は読みに展開される可能性があり（【要実測】）、履歴と対応しない恐れがある。
4. 再生位置からの逆引きで「聞いた文字数」を求め、語の途中なら直前の語境界まで、と定義する。精度の区分は `alignment_char` とし、文字時刻の精度そのものは未検証と明記する（§4.3 の「精度を明記」）。
5. §4.1 の停止点（語境界）にも同じ表を使える。alignment が音声より遅れて届く場合に備え、境界が不明なら上限時間でフェードに落とす（計画どおり）。

### 6.6 §4.3 の接続の持ち方（変更案）

- **セッションごとに `multi-stream-input` を1接続。** `inactivity_timeout=180`、`auto_mode=true`、`sync_alignment=true`、`language_code=ja`。文脈 ID は `audio_playback_id` と世代から作る。
- 文脈の上限は 5。`ResponsePrefetch`、発話候補、再生中の3本が基本で、**古い文脈は即座に `close_context`**。上限時の振る舞いは【要実測】なので、D 側で4本を超えないようにする。
- 取消後も音声が届く可能性があるので（【要実測】）、`contextId` と世代の照合で棄てる（計画の世代管理のまま）。
- 接続が切れたら再接続し、保持中の PCM は Node 側のものを使う。未完了の文脈は作り直す。
- 接続の切断や上限に当たった場合のみ、計画の「`stream-input` を要求ごとに開く」方式へ落とせるよう、D のインターフェースで隠す。

## 7. 推奨の設定（STT と TTS の代替は §10 の実測で更新）

| 部品 | 第1候補 | 代替 |
|---|---|---|
| Node | 24 | 20 + `@google-cloud/speech@7.5.0` + Gemini は REST |
| STT | **`long`、`asia-northeast1`（実測 §10.3）**、`ja-JP`、LINEAR16 16kHz、`interim_results=true`、`enable_voice_activity_events=true`、40ms 送信。当初の第1候補 `chirp_3` は 8 秒で interim が1回のみで外した | `long`（`us`）→ `chirp_2`（`asia-southeast1`）→ `gpt-live-transcribe` |
| `endpointing_sensitivity` | STANDARD のまま（SHORT は人の間で切れる恐れ。G1 の注意） | 実測で比較 |
| LLM | `gemini-3.5-flash-lite`、Interactions、`store: false`、`thinking_level: minimal`、有料ティア | `gemini-3.8-flash` + `low`（質が足りないとき。§4.5a のスパイクで判断） |
| TTS | `eleven_flash_v2_5`、`multi-stream-input`、`auto_mode=true`、`pcm_24000`（16kHz へは §3.2 の変換を通す）、`sync_alignment=true` | `pcm_16000`（遅延に差があれば）／`eleven_multilingual_v2`（日本語の品質が足りなければ。ただし遅い）／**Gemini TTS（キーがないとき。§10.2、語時刻は推定）** |

## 8. 費用の見込み（5 分の対話 1 回。**推定**）

料金は【確認】（§2.5、§3、§4）。回数や文字数は仮定で、実測で置き換える。

| 項目 | 仮定 | 計算 | 費用 |
|---|---|---|---|
| STT | 5 分＋切替の重複 10 秒、`chirp_3` は Standard と仮定 | 5.17 分 × $0.016 | **$0.08** |
| LLM（flash-lite） | ユーザー発話 3 分、Monitor 120 回＋Prefetch 60 回、1回あたり入力 1,500／出力 150（思考を含む） | 27 万 × $0.30/M ＋ 2.7 万 × $2.50/M | **$0.15** |
| LLM（3.8-flash の場合） | 同上（思考が増えれば上がる） | 2026 年 $0.30／2027 年 $0.61 | （参考） |
| TTS | 実発話 2 分 ≈ 800 文字（約 6〜7 文字/秒）、先行生成の無駄で 3 倍、取消分も全額と仮定 | 2,400 字 × $0.04/千字 | **$0.10** |
| **合計** | flash-lite | | **約 $0.33／回**（3.8-flash では 2026 年 $0.48、2027 年 $0.79） |

- 感度が最も高いのは LLM の呼び出し回数と入力長、次に TTS の取消分の課金（資料に記載がない）。
- ElevenLabs は Starter（$6／月、15 万字）で約 60 回分（2,400 字として）。
- `tools/provider_probe/` の一通りの実行は合計 $0.50 未満の見込み。

## 9. 実呼び出しでしか分からない残項目と測定手段

| # | 項目 | コマンド | 結果で変わること |
|---|---|---|---|
| 1 | ja-JP の最新のモデルと機能 | `stt_locations` | リージョンの候補 |
| 2 | `chirp_3` の interim と `stability` | `stt_probe --model chirp_3` | **STT モデルの選定**、§6.1 の経路 |
| 3 | interim の `resultEndOffset`、語時刻（モデル別） | `stt_probe --word-offsets` | §6.3、§6.4 の区分 |
| 4 | interim の間隔と音声に対する遅れ、日本語の final の長さ | `stt_probe` | N と鮮度の上限、`t_transcript` |
| 5 | `--word-offsets` が `chirp_3` で拒否されるか | `stt_probe` | C のエラー処理 |
| 6 | 40ms と 100ms の遅延の差 | `stt_probe --chunk-ms` | 送信単位 |
| 7 | 実際に切れる時刻とエラーの種類 | `stt_long_probe --mode limit` | 切替の時刻 |
| 8 | offset の基準（ストリーム単位か）、重複の量 | `--mode handover` | §6.2 の規則 |
| 9 | 無音や送信停止の許容、offset が音声基準か | `--mode pause` | 切替と欠落の扱い |
| 10 | モデル一覧、実 ID の有効性 | `gemini_probe --mode models` | ID の固定 |
| 11 | 最初のトークンと `decision` の遅延、API 間の差、thinking 別 | `gemini_probe --mode latency` | LLM の選定、実行間隔 |
| 12 | 中断の挙動 | `gemini_probe --mode abort` | 確認のみ |
| 13 | レート制限の実数 | AI Studio の画面 | Monitor の頻度の上限 |
| 14 | WS の PCM 形式、最初の音声までの遅延、`auto_mode` の効果 | `tts_probe --mode single` | `output_format`、スケジュール |
| 15 | 日本語の `alignment` の単位、正規化の展開、チャンク相対の確認 | `tts_probe --mode single` | §6.5 |
| 16 | 漢字の読みの質（**人が聞く**） | `single` の出力 WAV | モデルの選定、かな変換の要否 |
| 17 | `close_context` 後の音声、並行文脈、6 本目の扱い | `tts_probe --mode multi` | §6.6 |
| 18 | 取消した文脈の課金 | `tts_probe --mode billing` | 費用の見込み、先行生成の頻度 |
| 19 | 切断の時刻、keep-alive の効果 | `tts_probe --mode idle` | §6.6 |
| 20 | `chirp_3` の請求 SKU | 請求画面 | 費用の見込み |

## 10. 実測の結果（2026-11-08）

ここは実呼び出しの結果で、§0〜§9 の資料の確認とは分ける。**回数が少なく、日本の1回線、短文での値**で、分布の主張ではない。

**出所:** STT と Gemini LLM は `tools/provider_probe/out/` の JSONL と要約（git の対象外）。ElevenLabs と Gemini TTS は**レーン C の報告と `apps/orchestrator/src/providers/tts/` の実装の注記**で、`live_*_check.ts` の出力は標準出力のみで `out/` にファイルが残っていない（数値を後から照合できない）。

### 10.1 ElevenLabs（`multi-stream-input`）

| 項目 | 実測 | 資料との関係 | 出所 |
|---|---|---|---|
| 最初の音声 | 176〜286ms（4回） | 公称の地域別 TTFB は §3 | レーン C |
| 配信地域 | `asia-southeast1` | 資料はシンガポールを含むと記載 | レーン C |
| PCM 形式 | `pcm_16000`、`pcm_24000` は可。`pcm_44100` は Pro 以上で拒否（接続後に `output_format_not_allowed`） | 資料は WS の型の記載なし | レーン C |
| `isFinal` | flush では来ず、`close_context` の後に来る（80〜100ms） | 資料に記載なし | レーン C |
| `close_context` 後の音声 | flush 済みの分は届く（3.7 秒ぶんが 420ms 以内、`isFinal` は 607ms 後）。取消は受信側で棄てる | 資料は「すぐ止まるか記載なし」 | レーン C |
| `alignment` の時刻 | flush をまたぐ chunk で文脈の累積（2番目の chunk の先頭が 1161ms、それまでの PCM は 1153ms） | **資料（チャンク相対）と違う** | レーン C |
| `alignment` の単位 | 入力の1文字ごとで、末尾に空白が付く | 資料に記載なし | レーン C |
| `normalizedAlignment` | ローマ字に展開される。発話済みの計算に使わない | §6.5 の懸念のとおり | レーン C |
| 6本目の文脈 | 接続ごと閉じられる（`max_active_conversations`） | 資料は上限 5 のみ | レーン C |
| エラー | 多くは接続が開いた後のメッセージ `{message, error, code: 1008}` で、続いて閉じる。不正なキーも HTTP では拒否されない。HTTP 403 が権限とは限らない（`invalid_output_format` も 403） | 資料に記載なし | レーン C |

**未確認:** クォータ超過の実際のコード、取消分の課金（今のキーに `user_read` がなく、`/v1/user/subscription` を読めない）、keep-alive の長時間の効果、日本語の読みの質（人が聞く）。

### 10.2 Gemini TTS（代替）

| 項目 | 実測 | 出所 |
|---|---|---|
| モデル | `gemini-3.8-flash-tts`、`gemini-3.8-flash-lite-tts` | レーン C |
| 経路 | Interactions API の stream。`step.delta` の `delta.type=audio` に base64 | レーン C |
| 形式 | `audio/l16`、24kHz | レーン C |
| 最初の音声 | 0.87〜1.23 秒 | レーン C |
| alignment | なし。語時刻は文字数と音声の長さからの推定で、`playback.alignment` に `source: 'estimated_time_proportional'` を付ける。発話済みの精度は `time_proportional` | レーン C |

**未確認:** 無料枠の制限の実際のエラー、中断した分の課金、話し方の質。

### 10.3 Google Speech-to-Text v2（`long` + `asia-northeast1`）

| 項目 | 実測 | 出所 |
|---|---|---|
| interim（8 秒の `ja.wav`、1回） | interim 46 件、`stability` は 0.9 と 0.01 の2値、音声に対する遅れ p50 280ms／p95 340ms | `stt-asia-northeast1-long-*.summary.json` |
| ストリームの上限 | 302.2 秒で `ABORTED`（`Max duration of 5 minutes reached for stream.`） | `stt-long-limit-long-*.summary.json` |
| 課金の項目 | 応答の `metadata.totalBilledDuration`（累積） | 同上、`stt-c-handover-*.jsonl` の `billed` |
| 切替（無音、63 秒で実施） | A の最後の final から B の最初の出力まで**空白 1170ms（話者の無音を含む）** | `stt-c-handover-2026-11-07T19-14-11-584Z.jsonl` |
| 切替（期限 285 秒） | **空白 236ms** | 同上 |
| 継ぎ目の文字 | 切替2回とも欠落なし。期限の切替は重なり 256 文字を `suffix_match` で除去 | 同上 |

空白は結果の受信時刻の差で計算した。各1回の値。切替と別に、Google が打つ final の直後に文字が欠ける（計6文字）。`docs/known_gaps.md` を参照。

