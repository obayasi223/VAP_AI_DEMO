# 動かし方（runbook）

人とアバターが日本語で音声対話する試作を、WSL で起動して Windows の Chrome から使う手順です。
対象は wave 1（HRI 2025 の制御を土台にした版）です。

## 0. 準備するもの

- **有線のヘッドセット**（マイク付き）。スピーカーや Bluetooth の機器は使わないでください。
  - スピーカーだと AI の声をマイクが拾ってしまいます。この試作はエコーキャンセルを切って動かします。
  - Bluetooth は遅延が大きく、通話モードに切り替わると音質も落ちます。
- Windows の「設定 → システム → サウンド」で、**入力と出力の既定をヘッドセットにする**。
  - Chrome は既定の機器を使います。ページの中では機器を選べません。
- リポジトリ直下に `.env` を置き、次の値を入れておく。
  - 値は人に見せないでください。ログにも書かれません。

| 変数 | 用途 |
|---|---|
| `GEMINI_API_KEY` | 応答の生成（Gemini） |
| `GOOGLE_APPLICATION_CREDENTIALS` | 音声認識（Google Speech-to-Text v2）のサービスアカウント JSON のパス |
| `GOOGLE_CLOUD_PROJECT` | 同じく、プロジェクト ID |
| `ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID` | 音声合成（ElevenLabs） |

任意の変数です。ふだんは書かなくてかまいません。

- `ORCHESTRATOR_PORT`：既定は 8787。
- `POLICY_FILE`：既定は `config/policy.ja.json`。
- `CONDITION`：既定は `reactive`。
- `*_PROVIDER_CLASS`：`test_double` にすると台本の偽物になります。
- `ELEVENLABS_LANGUAGE_NORMALIZATION`：既定は 0。11-08 の実測では、1 にしても読みは変わりませんでした。

## 1. 起動（WSL のターミナルを2つ使う）

どちらのターミナルでも、最初にリポジトリへ移って Node を合わせます。

```bash
cd ~/projects/LLM_VAP_DEMO
source ~/.nvm/nvm.sh && nvm use
```

**ターミナル1: Orchestrator（会話の制御と MaAI）**

```bash
npm run dev:orchestrator
```

次の2行が出れば準備完了です。

- `listening on 0.0.0.0:8787`
- `MaAI worker: ready`（数秒かかります）

`providers: STT=production TTS=production LLM=production` の行で、実 API を使っていることを確認できます。

**ターミナル2: 画面（Next.js）**

```bash
npm run dev:web
```

`Ready` が出たら準備完了です。

## 2. Windows の Chrome で開く

1. Chrome で **http://localhost:3000** を開く（`localhost` のまま開いてください。IP アドレスで開くとマイクが使えません）。
2. アバターが出たら「**はじめる**」を押す。
3. マイクの許可を聞かれたら「**許可**」。
4. 「どうぞ話してください」と出たら、ふつうに話しかける。以降はボタン操作はいりません。

注意点です。

- 始めてから **10 秒ほど**は、話者交替の予測（VAP）が準備中なので、AI が返事をしにくいです。画面にもそう出ます。
- AI が話している最中に話しかけると、AI は話すのをやめます。そのとき履歴に入るのは、実際に話した所までです。
- 右の「マイクの設定」を開くと、次のものを確認できます。
  - エコーキャンセル／ノイズ抑制／自動音量調整が **OFF** になっているか。ON と出たら警告も出ます。
  - 使用中のマイクの名前。
- 黄色の「試験用の設定です」が出ていたら、台本の偽物で動いています。本番の記録には使えません。

研究者向けの状態表示は、別のタブで次の URL を開きます。

http://localhost:3000/research?source=ws&url=ws://localhost:8787/research

## 3. ログ

- セッションごとに `sessions/<session_id>/` ができます。
  - `session_id` は画面右下に小さく出ています。
- フォルダの中身です。
  - `events.jsonl`：すべてのイベント
  - `manifest.json`：条件、プロバイダ、版
  - `quarantine.jsonl`：契約に合わなかったもの。空が正常です。
- 記録が契約どおりかを調べ、遅延の内訳を出すコマンドです。

```bash
npm run log:check -- sessions/<session_id>
```

- 動作の確認です。
  - `curl http://localhost:8787/health` でサーバーの状態が JSON で返ります（MaAI の状態、今のセッション）。

## 4. 止める

- ブラウザで「終了する」を押すか、タブを閉じる。
  - タブを閉じても、20 秒以内に開き直せば同じセッションに戻ります。
  - 再読み込みすると新しいセッションになります。
- 各ターミナルで **Ctrl+C** を押す。
  - Orchestrator は、開いているセッションのログを閉じ、MaAI ワーカーを止めてから終わります。

## 5. うまくいかないとき

| 症状 | 確かめること |
|---|---|
| 「マイクの使用が許可されませんでした」 | アドレスバー左のアイコン →「マイク」を「許可」→ 再読み込み |
| 「マイクが見つかりません」 | ヘッドセットを挿し直し、Windows の既定の入力を確認 → 再読み込み |
| 「マイクを開けませんでした」 | Teams や Zoom などがマイクを掴んでいないか |
| 「切断（自動で再接続します）」のまま | ターミナル1が動いているか。`curl http://localhost:8787/health` |
| AI がまったく話さない | ターミナル1に `stt_unavailable` / `llm_unavailable` / `tts_unavailable` が出ていないか（`.env` の値） |
| 画面に「話者交替の予測が動いていません」 | ターミナル1の `MaAI worker:` の行。起動し直す |
| ターミナル1や `/health` に `rtf_above_1` / `recent_overload_drop` | MaAI（CPU）の推論が実時間に追いついていない。ほかの重い処理（推論、ビルド、ブラウザのタブ）を止める |
| エコーキャンセルが ON と出る | Chrome の拡張機能や、Windows の「オーディオの拡張」を切る |

## 6. 試験（開発者向け）

- `npm run test:e2e` で、一連の流れをまとめて確かめます。
  - 偽のマイク（`models/ja.wav`）をヘッドレスの Chromium に流し、実 MaAI と台本のプロバイダで、画面から再生と口の動きまで通します。
  - メモリを多く使います。空きが 2.5GB 以上あるときに、ほかの重い処理と重ねずに実行してください。
- `E2E_REAL=1 E2E_SECONDS=40 npm run test:e2e` にすると実 API を使います。課金されます。
- `npm run dev:orchestrator:scripted` で、台本のプロバイダで起動します。キーがなくても動きます。
