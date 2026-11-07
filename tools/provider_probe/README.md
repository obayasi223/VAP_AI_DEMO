# provider_probe（レーン R4）

Google STT v2、ElevenLabs、Gemini の「資料では分からない挙動」を実 API で測ります。結果の読み方は `docs/provider_matrix.md` の §6 を参照してください。

- 認証情報は環境変数からのみ読みます。他のプロジェクトや `~/.gemini` は読みません。
- 認証情報がなければ、必要な変数を案内して終了します（終了コード 2）。
- 認証情報があっても、`--yes` がなければ実行内容と概算費用を表示するだけで呼び出しません（終了コード 3。Gemini のモデル一覧と STT のロケーション一覧は課金がないので不要）。
- キーはヘッダで送り、URL やログに入れません。ログは `out/`（gitignore 済み）に JSONL と要約 JSON で出ます。**`out/` には書き起こしと音声が残る**ので共有に注意してください。

## 準備

```bash
cd tools/provider_probe
nvm use 24          # @google-cloud/speech 8 は Node 22 以上が必要
npm install
node --env-file=../../.env check_env.mjs   # 設定の有無だけを表示（通信なし）
```

| 変数 | 用途 |
|---|---|
| `GOOGLE_CLOUD_PROJECT` | STT のプロジェクト ID |
| `GOOGLE_APPLICATION_CREDENTIALS`（または `GOOGLE_STT_USE_ADC=1`） | STT の認証。gcloud の既定認証は明示したときだけ使う |
| `GEMINI_API_KEY` | Gemini。**有料ティアのキーを使う**（無料ティアは入力がプロダクト改善と人のレビューの対象） |
| `ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID` | TTS |

音声は 30 秒以上の自然な日本語の発話を用意してください（16bit PCM の WAV）。16kHz 以外は簡易に変換し、要約に `resampled_from` が残ります。`models/ja.wav` は 8 秒しかないので動作確認向けです。

## 実行順（早く判断が変わるものから）

以下の `node` には `--env-file=../../.env` を付けるか、環境変数を設定して実行します。合計の費用は $0.50 未満の見込みです（STT を $0.016/分、Flash を $0.04/1千文字として計算）。

```bash
# 1. ja-JP のモデルと機能（課金なし）
node stt_locations.mjs

# 2. 最重要: chirp_3 で interim と stability が返るか。比較に long と chirp_2 も
node stt_probe.mjs --wav my.wav --model chirp_3 --location us --boundary-s 10 --posthoc-words --yes
node stt_probe.mjs --wav my.wav --model long --location us --word-offsets --boundary-s 10 --yes
node stt_probe.mjs --wav my.wav --model chirp_2 --location asia-southeast1 --word-offsets --boundary-s 10 --yes
node stt_probe.mjs --wav my.wav --model chirp_3 --location us --word-offsets --yes   # 拒否されるかの確認
node stt_probe.mjs --wav my.wav --model chirp_3 --location us --chunk-ms 100 --yes   # 送信単位の遅延差

# 3. ストリームの寿命と切替
node stt_long_probe.mjs --mode handover --wav my.wav --yes
node stt_long_probe.mjs --mode pause --wav my.wav --yes
node stt_long_probe.mjs --mode limit --wav my.wav --yes   # 約5.5分かかる

# 4. Gemini
node gemini_probe.mjs --mode models
node gemini_probe.mjs --mode latency --yes
node gemini_probe.mjs --mode abort --yes

# 5. ElevenLabs
node tts_probe.mjs --mode single --yes      # 出力の .wav は人が聞いて漢字の読みを確認
node tts_probe.mjs --mode multi --yes
node tts_probe.mjs --mode idle --yes
node tts_probe.mjs --mode billing --yes     # 他の利用が同時にない時間帯に
```

## 試験

```bash
npm test
```

偽サーバーとダミーキーで、要求の形とログの処理だけを確かめます。**実プロバイダの挙動の証拠にはなりません。** 次は試験の範囲外で、実 API で初めて動きます: `stt_locations.mjs`、`stt_probe --posthoc-words`、`tts_probe` の `multi`・`billing`・`idle`、`gemini_probe` の `models`・`abort`。`stt_long_probe` の3モードは偽サーバーで手動で流しただけで、`npm test` には入っていません。
