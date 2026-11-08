# 動かし方（runbook）

人とアバターが日本語で音声対話する試作を、WSL で起動して Windows の Chrome から使う手順です。
対象は wave 1（HRI 2025 の制御を土台にした版）です。

## 0. 準備するもの

### 0.1 最初に1回だけ（WSL）

リポジトリ直下で行います。

```bash
cd ~/projects/LLM_VAP_DEMO
source ~/.nvm/nvm.sh && nvm use      # .nvmrc の Node 24
npm ci
python3 -m venv .venv                # Python 3.12（DEPENDENCIES_LOCK.md）
.venv/bin/pip install --no-deps -r workers/maai/requirements.lock
.venv/bin/pip install --no-deps -r workers/maai/requirements-dev.lock   # 試験（npm run test:py）を回すときだけ
```

- **MaAI の重み**は Hugging Face のキャッシュ（`~/.cache/huggingface/hub/models--maai-kyoto--*`）から読みます。リポジトリには入っていません。
  - 起動時は `HF_HUB_OFFLINE=1` でネットに出ないので、キャッシュが空だと MaAI が起動しません（画面に「話者交替の予測が動いていません」）。
  - 版は `workers/maai/worker_config.json`（`continuous-mimi-onnx` の revision）と `DEPENDENCIES_LOCK.md` で固定しています。空のキャッシュから取得する手順はまだ文書にありません（未整備）。この機械のキャッシュには取得済みです（`docs/maai_validation.md`）。
- **アバターの VRM** は `apps/web/public/models/Sendagaya_Shino.vrm` に置きます（既定）。別のモデルは同じ場所に置き、`?model=/models/<ファイル名>.vrm` で開きます。ライセンスは `THIRD_PARTY_NOTICES.md`。

### 0.2 機器と鍵

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
- `ORCHESTRATOR_HOST`：既定は `127.0.0.1`。
- `ALLOWED_ORIGINS`：WS と `/health` を使える画面。既定は `http://localhost:3000,http://127.0.0.1:3000`。画面を別のポートで開くときに足します。
- `ORCHESTRATOR_CLIENT_TOKEN`：Origin のない接続（Node のスクリプトなど）を通す合言葉。既定はなし（断る）。使うときは `ws://localhost:8787/research?token=<値>`。

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

- `listening on 127.0.0.1:8787`（WSL の外の LAN には公開しません。Windows の Chrome からは WSL2 の localhost 転送で届きます）
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

### 研究者画面の見方

- **p の時系列**：直近 60 秒です。右端は受け取った最新のイベントの時刻です。
  - 上から p_now、p_future、vad の3段です。**AI は青の実線、利用者はオレンジの破線**です。
  - どちらの添字が AI かは、図の上の1行に出ます（orchestrator の方策の `policy.vap.p_ai_index`）。
    - 黄色の字で「仮定して描いています」と出たら、orchestrator から向きを受け取れていません。
  - 下の帯は、AI の発話、利用者の発話（VAP の判定）、発話の許可（turn.allowed）、出来事です。
    - 出来事の印：紫の丸は視線、黄色のひし形は発話希望、赤の縦線は割り込みで止まった所。
  - 図にポインタを置くと、その時刻の値が下に出ます。
  - 更新は 0.5 秒ごとです。タブが見えていない間は止まります（MaAI の計算を邪魔しないため）。
- **発話希望の候補**：LLM の判断と候補の状態の変化です。
  - 左の欄は実測の時刻とコードの検証結果です。
  - 右の「LLM 生成」の欄は、モデルが書いた文です。判定には使っていません。事実として扱わないでください。
- **準備の取消・空振り、割り込み**：今のセッションの累計です。
  - 取消率：取り消した準備 ÷（取消 ＋ 再生した準備）。
  - 空振り率：音声まで作ったのに使わなかった準備 ÷ 音声まで作って決着した準備。
  - データがない間は「未計測」と出ます（0% ではありません）。
- **研究者のメモ**：書いて「記録する」（Ctrl+Enter）を押すと、今のセッションの `events.jsonl` に `research.note` として残ります。
  - 「ログに記録済み」と出たら保存されています。
  - 「記録されていません（セッションなし）」は、参加者のセッションが始まっていません。
- 「録音・条件の切替・WoZ」の欄はまだ空です（後の段階で追加します）。
- 表示の確認だけなら `http://localhost:3000/research?source=fake` で偽のデータを流せます。
  - 赤い帯の「偽データの表示です」が出ている間の値は、すべて作り物です。

## 3. ログ

- セッションごとに `sessions/<session_id>/` ができます。
  - `session_id` は画面右下に小さく出ています。
- フォルダの中身です。
  - `events.jsonl`：すべてのイベント
  - `manifest.json`：条件（`condition`）、方策（`policy_id`）、プロバイダごとの区分（`providers`、`production`／`test_double`／`unavailable`）、版、終了の状態。`log:check` はこの区分を必ず見て、`production` 以外が1つでもあれば受け入れの証拠に数えません。
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
| 「この会話は別のタブで開かれています」 | 参加者画面を2つのタブで開いています。使わないほうのタブを閉じる（断られたタブは再接続しません。使うなら再読み込み） |
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

## 7. 調整画面（開発用、`/tune`）

VAP の予測と方策の閾値、「なぜ AI が話し始めた／まだ話さないか」、発話希望（initiative）の流れを見て、録音を別の方策で再生し直す画面です。参加者には見せません。録音には利用者の発話が入っているので、画面の写しや書き出しを外へ出さないでください。

**起動（ターミナル3）**

```bash
npm run dev:tune
```

- 再生の口が `http://127.0.0.1:8790` で開きます。127.0.0.1 からだけ受け、`ALLOWED_ORIGINS`（既定は `http://localhost:3000` と `http://127.0.0.1:3000`）の画面からだけ答えます。参加者の経路（8787 の `/ws`）とは別のプロセスで、MaAI、STT、LLM、TTS は開きません。
- Chrome で `http://localhost:3000/tune` を開きます。宛先を変えるときは `?dev=http://127.0.0.1:<port>` と `?ws=ws://localhost:<port>/research?tune=1` を付けます。

**ライブ**（orchestrator が動いているとき）

- `/research` の WS に `?tune=1` を付けてつなぎます。直近 30 秒の p_now、p_future（AI は実線、利用者は破線）、vad と、いま使っている方策の閾値（点線）を出します。
- 「間（ms）」の段: 利用者の発話の終わりからの間、L74 の待ち（completion と start_guard から）、最小の間、L64 が続いた時間。
- 表: その時刻の分岐（L56、L59、L64、L67、L74、招待、U1、準備、断片）ごとの成立と、値と閾値、VAP の鮮度。TurnManager の state から計算し直した読み出しです。判断の正本は `turn.allowed` の理由です。
- 発話希望の流れ: 起動、LLM の判定の種類、候補の状態、撤回と保留を時刻の順に出します。理由、なぜ今、待つ損失、緊急度は「LLM 生成」の欄に分けています。数値の「話したい度合い」は出しません。

**録音の再生**

- セッションを選ぶと、記録の入力（VAP、STT、準備と再生の時刻）を Node 側で TurnManager の `step` に流し直します。左の欄で方策を変えると、0.3 秒後に計算し直します（1 セッションで 0.2 秒ほど）。LLM と TTS は呼びません。
- 左の欄の項目は、契約のスキーマから並べています。方策に項目が増えても、自動で並びます。
- 記録の判断と比べるときは、元にする方策に「git HEAD」（記録したときの方策）を選びます。開始の対応（一致、記録だけ、再計算だけ）と、食い違った点を出します。
- 準備の待ちと発話の長さは、記録に同じ準備があればその値を使います。なければ仮定の値を使います。仮定の値は欄で変えられ、画面に出ます。
- 発話希望は記録の判定を出すだけです。`initiative.trigger` を変えたときは、記録の STT から起動の回数だけを数え直します。そのとき LLM がどう判定するかは分かりません。
- **反実仮想の限界**: AI の話し始めが変わっても、利用者の声、STT、VAP は記録のままです。実際には変わるはずです。開始が記録から離れるほど、指標は近似になります。

**指標**（記録と再計算に同じ定義を使います）

| 指標 | 定義 |
| --- | --- |
| 開始 | AI が話し始めた回数 |
| 発話の途中での開始 | 開始から 1.5 秒以内に届いた利用者の STT のうち、開始より後の音声で、同じ ASR 区間の文が伸びたものがある開始 |
| 同（vad、参考） | 開始から 1.5 秒以内に vad[0] が `vap.speaking_threshold` 以上になった開始 |
| 遅れ | 最後に vad[0] が閾値以上だった時刻から開始まで（30 秒以内） |
| AI の連続発話 | 前の AI の発話が終わってから開始まで、利用者の声（vad[0]）が一度もない開始 |
| 視線を逸らした回数と長さ | `gaze.decision` が away に変わった回数と、user へ戻るまでの長さ |

**良い値を使う**

1. 画面の「config/policy.ja.local.json に保存」を押します。いまの作業ツリーの `config/policy.ja.json` との差分だけが書かれます。このファイルは git に入りません。正本の `config/policy.ja.json` は書き換えません。
2. orchestrator を上書き付きで起動し直します。

   ```bash
   POLICY_OVERRIDE_FILE=config/policy.ja.local.json npm run dev:orchestrator
   ```

3. 起動ログに `policy override config/policy.ja.local.json (N items): ...` が出ます。セッションの manifest の `policy_override` にも、ファイルと上書きした項目が残ります。
4. ファイルが読めないときや契約に合わないときは、orchestrator は起動しません（黙って正本で動くことはありません）。`policy_id` と `immutable` は上書きできません。

**再生で分かっていること**

- 2026-11-08 の録音（`s20261108T045055-ca6e12`）を記録したときの方策で再生すると、開始 5 件は時刻のずれ 0ms で一致しました。`turn.allowed` は 42 件すべて一致し、起動の回数は 10 件で一致しました。
- 視線は近似です。system チャネルの無音を、vap.state の x2_peak（80ms 窓）から作っているためです。記録で使うのは 20ms 枠の RMS です。
- VAP の鮮度が切れたときと、助走中の fallback は再生しません。`fallback_energy` が記録にないためです。

## 8. 発話希望の評価画面（`npm run review:initiative`）

自然な実音声での発話希望の妥当性を、研究者が1判定ずつ見て評価する画面です。**回数や発生率ではなく、内容と申し出る時点の適切さを見るための道具です。** 画面に件数の集計は出しません。

```bash
npm run review:initiative                 # http://127.0.0.1:8791/ で開きます（Ctrl+C で止める）
npm run review:initiative -- --port 8792  # ポートを変えるとき
```

- 127.0.0.1 からだけ受けます。`sessions/` の外へは何も送りません。実 API も使いません。画面の写しや書き出しを外へ出さないでください（利用者の発話が入っています）。
- 評価者の名前を入れると評価できます。別の人の評価の中身は画面に出しません（独立に評価するため）。
- 絞り込み: 会話の種類とプロンプトの版。会話の種類は `manifest.json` の `conversation_kind`（`initiative` の下でも可）を使います。まだ記録されていないセッションは `persona: <persona_id>` と出ます（推測で種類を当てません）。
- 音声: `sessions/<id>/` に音声（`.wav`、`.webm`、`.ogg`、`.oga`、`.mp3`、`.m4a`、`.flac`）を置くと、判定の時点の少し前から再生できます。音声の先頭が音声枠 0 の時刻である前提です。

**評価の欄**（別々に保存します。計画 §4.5a の3列）

| 欄 | 内容 |
| --- | --- |
| ① 内容の妥当性 | その立場で言う価値があるか。NONE の判定では「言わない判断の妥当性」 |
| ② 申し出る時点の適切さ | この時点でよい／早い／遅い／話し終わってからでよい |
| ③ 待機・撤回の妥当性 | 妥当／待たずに言うべきだった／撤回すべきだった／撤回すべきでなかった |
| ④ 自由記述 | 自由に |

**見逃しの印**: 判定が NONE の区間でも、「ここで言いたいことがあったはず」と印を付けて内容を書けます。判定の詳細の「見逃しの印」のボタン、または前後の会話の各行の「＋ 見逃しの印」から付けます。

**保存**: `sessions/<id>/initiative_review/<評価者>.json`（`sessions/` ごと git の対象外）。評価者ごとに別のファイルです。入力すると 0.5 秒後に自動で保存します。同じ評価者を2つの画面で開いて編集すると、後から保存した方は「別の画面で先に保存された」と出ます。

**試験**: ルートの vitest の対象に入っていないので、`npx vitest run --config tools/initiative_review/vitest.config.ts` で動かします。
