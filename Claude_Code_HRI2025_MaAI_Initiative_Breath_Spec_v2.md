# Claude Code実装仕様 v2｜HRI 2025ベースの内容依存・自発的発話意思＋吸気アバター

**作成基準日: 2026-11-08**  
**用途: 研究用リアルタイム音声対話プロトタイプ。外部APIの呼び出し・モデルの挙動・人間の体験は未実機検証。**  
**旧仕様:** `Claude_Code_Real_Conversational_Inhalation_Prototype_Spec.md`  
**旧デモ:** `BREATH_LLM_Inhale_Avatar_Demo.zip` は画面／動作概念の参考のみ。対話制御は作り直す。

## 0. 最重要ゴールと、作らないもの

**目標:** 人間1人とAIアバター1体が日本語で自然にリアルタイム会話できる。人間の発話が終わる前からAIが会話の**内容に基づいて**独自の質問・反論・確認などの発話希望を生成し、実際に言葉を発する前に**胸郭・肩・頸部・口の協調した吸気動作**として提示する。人間の会話継続・明示的な「どうぞ」・自然な譲渡・新情報に応じ、発言を開始、延期、内容変更、撤回できる。AI自身の音声を継続的に分析して、人間による割り込みに応答する。

- 目指すアーキテクチャは **Skantze & Irfan, HRI 2025のturn-taking / ahead-of-time preparation / self-monitoring を再構成し、`LLM_INITIATIVE` と `BREATH_SIGNAL` を追加** したもの。
- **HRI 2025の完全なコード複製ではない。** 公式のシステム一式の公開リポジトリは今回確認できていない。英語・Furhat・原著の機器構成と、日本語・ブラウザ3D・今回の構成の相違を記録すること。
- MaAIは**将来の音声活動の予測**であり、LLMが何を言いたいか、ユーザーが発話権を意図的に譲ったか、心理的に応答を望んでいるかを推定するものではない。
- 見た目がリアルなだけのモック、固定時間ごとの「質問したい」演出、VADをVAPと呼ぶダミー、録音完了後にだけLLMを呼ぶ疑似逐次処理は**不合格**。
- 本仕様は**仮説を検討できる体験品質の装置**を作るもの。AIの人間らしさ、独立性、信頼、親密さ、コンパニオン価値の向上を事実として事前に前提化しない。

## 1. 必ず参照する一次資料と公開実装

| 資産 | 原典／URL | 実装上の役割 | 注意事項 |
|---|---|---|---|
| Skantze & Irfan, *Applying General Turn-taking Models to Conversational Human-Robot Interaction*, HRI 2025 | https://arxiv.org/html/2501.08946 | **設計の主基盤**。III〜V節・Fig.1/3・Appendix Aの制御フロー、V-B逐次応答準備、V-C割り込み、V-D self-monitoringを読む | 実験・モデルは英語とFurhatの構成。本文の数字や実験結果を日本語版の性能として引用しない |
| MaAI-Kyoto/MaAI | https://github.com/MaAI-Kyoto/MaAI | **日本語VAP実装の第一候補**。`Maai`、`MaaiInput.Chunk`/`Tcp`、`get_result()`、必要に応じ`mode="vad"` | `mode="vap"`、2ch指定なら2chモデル。1chでは別モデル。必ず出力スキーマと符号を現物確認 |
| MaAI API docs | https://maai-kyoto.github.io/MaAI/api/model/ | `process`, `get_result`, `MaaiMultiple`等の詳細と出力確認 | `get_result()`は結果dictを返す。内部キューのブロックとworkerの終了処理に注意 |
| MaAI Input docs | https://github.com/MaAI-Kyoto/MaAI/blob/main/readme/input.md | ブラウザ→Pythonにマイク/TTS PCMを渡すInput bridge | 単純な`Mic()`ではブラウザ音声と二重管理になる。ChunkまたはTCP入力を使う |
| inokoj/VAP-Realtime | https://github.com/inokoj/VAP-Realtime | **代替／参考**。日本語・ノイズ頑健VAPのサンプル、リアルタイム構造を比較 | MaAIと二重採用しない。まずMaAIで通す。重み・学習条件・ライセンスを別途確認 |
| ErikEkstedt/VAP | https://github.com/ErikEkstedt/VAP | **原型・概念確認／検証用**。projection windowと出力理解、比較評価 | 日本語の主実装として直ちに採用しない。音声チャンネル前提が異なる |
| ErikEkstedt/TurnGPT | https://github.com/ErikEkstedt/TurnGPT | **HRI 2025のテキスト的なturn-completion推定**の実装候補 | 英語学習済み構成を日本語STTへ無検証で流用しない。実運用可否は最初に検証 |
| pixiv/three-vrm | https://github.com/pixiv/three-vrm | ブラウザでのリグ付きVRMアバター・表情・視線／口形 | 胸郭／鎖骨に自然な変形可能なモデル、リグ、blendshape等が必要 |

**導入時のライセンス確認:** MaAIのソースはMITだが**学習済み重みには別のライセンスがありうる**。READMEはシステム開発／共同研究で井上昂治氏への連絡を案内している。モデル重み、CPC/Mimiエンコーダ、VRMモデル、音声のライセンスも確認し、`THIRD_PARTY_NOTICES.md`に残す。技術的利用可能と研究利用許諾を同一視しない。

**初手でClaude Codeが行うこと:** 上記URLで現時点のREADME、install手順、API、license、実際のexampleを開き、使用するcommit SHA、pip/npmパッケージのバージョン、checkpointを`DEPENDENCIES_LOCK.md`に記録。見つからない公式実装を存在すると仮定しない。

## 2. HRI 2025のどこを再現するか（原著の範囲）

原著Methodsの処理の要点:

1. 人間とAIの音声を**別々の2ch**でVAPに流し、`p_now`（近未来側）と`p_future`（それより先の未来側）を得る。音声だけのVAPと、逐次ASRから入力を得る**TurnGPT**を補完的に使用。
2. ASR途中結果を受けて、ターンが終わるより前に**仮のLLM返答生成とTTSを準備**。新しい内容に変わったら古い準備をキャンセル。原論文はTurnGPT準備閾値、ASR更新間隔、sentence embedding類似度を組み合わせて計算量を抑える。
3. 発話の実開始はVAP/TurnGPTと無音時間で判定。**返答が完成したことと発話開始許可は別**。
4. AI発話中も、人間音声と**実際に再生しているAI音声**をVAPに入力し、割り込みと相槌的な短い重なりを区別することを試みる。割り込まれたら次の語境界付近で停止し、**実際に声として出た箇所だけを会話履歴に反映**。
5. 自分の音声に基づくVAP予測を視線制御へ反映するself-monitoringも行う。ただし原著の視線は主として**ロボット側が自分のターンを保持する**ための制御。**人間の発話中にAIが自発的に発話希望を示す吸気とは別**。

原著の Appendix A は**重要な実装参照**。その閾値（例: response preparation時のTurnGPT判定0.2、類似度0.8、最小gap 500ms）は**原著の初期値として比較用に記録**する。ただし英語Furhatでパイロット調整された値で、日本語MaAI/WEBでそのまま最適とは断言しない。実行時Configへ切り出し、実ログで検証。

### 今回の追加（原著にはない提案処理）

原著の**先行応答生成**は「相手のターンが終わったら返す回答を早く準備する」処理。今回追加する`InitiativeMonitor`は**相手がまだターンを終えていない場合でも、今まさに内容上言いたいことができたか**を判断する処理で、目的が異なる。明確に別モジュール／別ログにする。

- `initiative.decided_at`：内容から発話希望が生成された時刻
- `initiative.reason/evidence`：何に反応したのか（ユーザーの発話断片と対応）
- `signal.started_at`：吸気合図が人に提示された時刻
- `speech.started_at`：実際に話し始めた時刻
- `initiative.updated_at / withdrawn_at`：発話候補の修正・撤回

**基本ルール: `want_to_speak != permitted_to_speak != speaking`。**

## 3. 推奨する実装スタック（最小限・交換可能）

| 部品 | 推奨1本目 | 選定理由／代替 |
|---|---|---|
| ブラウザ・描画 | Next.js/React + Three.js + `@pixiv/three-vrm` + Web Audio AudioWorklet | UI、時刻付きモーション制御、デバッグと研究者用ビュー。レンダリングと音声推論を分離 |
| Backend orchestrator | Node.js/TypeScript WebSocket（セッション管理）、Python MaAIワーカー | 既存TSの経験を生かしつつVAPは公式Python環境で運用。Audio RPC契約を固定 |
| STT | **Google Cloud Speech-to-Text v2 streaming gRPC** | HRI 2025系に近く、`interim_results`、`stability`、`isFinal`を使える。代替はOpenAI `gpt-live-transcribe`。どちらも実測で選定 |
| Meaning / initiative | **Gemini Flash系の軽量テキストLLM**（現行バージョンはAPIから確認） | ユーザーが逐次生成に慣れた構成。通常の対話応答と`InitiativeMonitor`を別々の非同期要求にする。代替は高速OpenAIテキストモデル |
| VAP | **MaAI 日本語2ch VAP**、まず1ch smoke test | HRI 2025のuser/system self-monitoringに近づけるため本命は2ch。1ch出力を2者間の確率として扱わない |
| TurnGPT | 原著実装を動作確認→**日本語入力で検証に合格した場合だけ使用** | 英語pretrainingの日本語転移が不明。成立しない場合は「代替の発話完了推定器」と明記し、HRI忠実再現と区別する |
| TTS | **ElevenLabsのストリーミングWebSocket TTS** | HRI 2025で採用。LLMのテキストが逐次生成されても音声を先行生成できる。別候補 Google Cloud TTS Chirp 3 HD streaming |
| 音声I/O | PCM、音声出力はWebAudio経由、ヘッドホン＋近接マイクを基本 | システム発話チャンネルに**再生済み/再生予定のPCMのどちらを入力したかを記録**。できれば実際に再生したサンプルを時刻付きでフィードバック |
| 保存 | JSONLイベント＋任意のオプトイン録音WAV＋UIリプレイ | VAP/STT/LLM/吸気/TTSを時刻で突き合わせる。API費用も記録 |

**API注意:** OpenAIの旧Speech APIの複数TTSモデルには**2027-01-06の廃止予定**が公表されている。将来用プロトタイプで安易に旧モデルをハードコードしない。ElevenLabsのWebSocketではモデルごとにエンドポイント互換性が異なる。GoogleのストリーミングTTSはChirp 3 HDのみ等の制約がある。最終採用前に最新の公式ドキュメントを確認。

**原則:** 最初から「OpenAI Realtime全自動会話」に任せきると、**LLMが発話希望を決定した瞬間と人間への吸気提示の因果関係、VAPの制御寄与が見えなくなる**。研究用にはSTT→意味判断→VAP→TTSを明示的に分離したカスケード方式が適している。Realtime音声会話方式はベースライン／将来の比較にとどめる。

## 4. 時刻同期したイベントとモジュールの契約

必須: セッション単位の単調増加時刻 `t_monotonic_ms` とWallClock、`segment_id`, `transcript_revision`, `candidate_id`, `audio_playback_id`、`model_version`をすべて関連づける。

```text
Browser audio input (mic PCM) ---+----> STT stream --> interim/final transcript
                                 |                      |                |
                                 |                      +--> TurnCompletion estimator
                                 |                      +--> InitiativeMonitor (LLM): new/keep/revise/withdraw
                                 |                      +--> ResponsePrefetch (LLM/TTS), ordinary turn
                                 +----> MaAI VAP user ch                    |
Browser played AI PCM ----------------> MaAI VAP system ch                  |
                                          |                                  |
                                          v                                  v
                         TurnManager / InitiativeNegotiator <------- semantic candidates
                                |  |  |
             cue/start ------------ |  +-- cancel/defer/withdraw/update
                                |  +---- start/end/interruption decisions
                                v
                  3D Breath + gaze + TTS playback (audio timestamp tracking)
```

**LLM意図判定の入出力**（プロバイダのstructured output方式は選定後確認）:

```json
{
  "type": "INITIATIVE_DECISION",
  "transcript_revision": 42,
  "decision": "NEW",
  "candidate_id": "c_0007",
  "intent_type": "CLARIFICATION",
  "evidence_span": "…先ほどの説明のうち、月額料金の話…",
  "reason": "途中で確認しないと以後の説明理解に影響する疑問がある",
  "proposed_utterance": "それは月額料金にも含まれていますか？",
  "expiry_policy": "RECHECK_ON_NEW_INFORMATION",
  "urgency": "NORMAL"
}
```

有効なdecisionは`NONE | NEW | KEEP | REVISE | WITHDRAW`。`NEW`は**発話内容や会話上の価値が本当にある場合だけ**。`evidence_span`が入力に存在しない、話題に無関係、既に解決済み、transcriptが古い場合はcueを出さない。単に各文節ごとに質問を自動生成する仕様は禁止。不要な発話希望がないことも正しい挙動。

### 初期状態遷移案

```text
IDLE/LISTENING
  --[content-driven initiative NEW, fresh, valid]-->
INTENT_READY
  --[signal gate allows; avatar available]-->
BREATH_INHALE (one short inhale; do NOT loop)
  --> BREATH_HOLD_OR_READY (short natural preparatory posture)
  --[user invites or robust floor-availability evidence]--> SPEAKING
  --[user continues]--> DEFERRED (relax, no long frozen inhale)
  --[new transcript invalidates candidate]--> WITHDRAWN --> IDLE
SPEAKING --[user actual interruption]--> STOP_AT_SAFE_AUDIO_BOUNDARY
  --> LISTENING (only actually-played words enter history)
```

**重大な設計上の課題:** 人間の発話途中に「吸気」を出し、実際の発話が数秒後になるなら、吸気を何秒も保持するのは身体的に不自然。**一度の自然な準備吸気を完結させ、軽い発話待機姿勢へ移る**。それでも実際に人間らしい発話希望として知覚されるかは予備観察で確かめる。合図直後に発言できなかったからといって無限に吸気を繰り返さない。

**発話許可:** 明示的な「どうぞ」「何か言いたい？」は音声文字起こしから検出できるが、STTは誤認しうる。VAPの音声活動予測は自然な隙間の選択を助けるが**譲渡の心理的意思を証明しない**。`turn_allowed`は、明示的な招待・ユーザー音声の状態・VAP・テキスト的turn-completion・発言の緊急性ではない会話上の優先度を統合した**システムの暫定判断**としてログへ残す。

## 5. 音声認識・LLM先行生成・逐次精製・TTSの具体処理

**STT:** マイク音声を20-40ms程度のチャンクで送信（サイズは実機調整）。interimには`revision`を振り、`stability`が低い場合は内容依存の合図を出さず、文字修正によるfalse-triggerを避ける。確定トランスクリプトのみを待つ方式は禁止。

**2つのLLMタスクは必ず分離:**

- `ResponsePrefetch`: 原著V-Bの延長。**普通にターンが終わったとき**に返す回答を、最新interim ASRとTurnGPT等に応じ先行生成。更新で前のLLM/TTSをキャンセルする。
- `InitiativeMonitor`: **まだユーザーが話している途中**に、内容上「今発言を申し出たいこと」が生じたかを判定。`NEW`の時点で合図を発動できる。ターン完了確率が高い時だけ判定すると**今回の研究現象を消してしまう**ので、起動条件をResponsePrefetchと共通化しない。

**逐次精製:** 新しい部分トランスクリプトが来たとき、(a) 候補発言がまだ関連するか、(b) 人間がすでにその疑問に答えたか、(c) 言う内容を更新すべきか、(d) 撤回すべきかを軽量なLLMまたは追加評価で判定する。必ず`candidate_id`と`transcript_revision`を比較する。遅い結果は破棄し、複数リクエストが競合して「過去の合図に対して新しい文章を話す」不整合を防ぐ。

**重要:** `InitiativeMonitor`の出力待ちが長すぎると、文章に関係ないタイミングの吸気となる。`t_content_evidence → t_transcript → t_initiative_decision → t_breath_start → t_speech_start`の各遅延を測る。平均だけでなく分位点と、取り消し率・空振り率を報告。

**TTS:** 質問候補の音声を先行生成できるが、ユーザーが話し続けて候補が陳腐化したら**未再生のPCMを確実に破棄**。文字の更新と音声再生の更新を一対一で管理。音声開始の合図は音声波形と3D口形に結びつける。発話の中断では再生キューを排出し、ユーザーが実際に聞いた内容だけを対話履歴へ反映（厳密な音素境界がなければ時間と語境界の近似、精度を明記）。

**音声I/O:** マイクchとシステム実再生chを別々に確保し、2ch MaAIに供給。まずヘッドセットを必須にして音声回り込みを減らす。PC内蔵スピーカーではAECが必要になるが、AECとVAPの出力分布への影響も検証。MaAIが要求するサンプルレート・フレーム周期に適切に再サンプリングし、データ欠損とデバイス遅延を記録。

## 6. MaAI統合の具体的なステップ

1. **Smoke test:** `pip install maai`→公式READMEの`Maai(mode="vap", lang="jp", frame_rate=10, audio_ch1=MaaiInput.Mic(), device="cpu")`で`get_result()`を実行。最初の実モデルロード、出力、CPU処理時間、ログを確認。
2. **入力の一本化:** ブラウザのAudioWorklet PCM→Node WS→Python MaAI Input (`Chunk`や`Tcp`) を構築。PCの`Mic()`を別に開いてUIの音声とずれる構成は原型で止める。
3. **2ch self-monitoring:** user PCM＋実際に発声したsystem PCMをチャンネル分離して供給。無音の間はsystem chを0で埋める。monoモデルと2chモデルの`p_now/p_future`の意味と出力構造が違うので、**同じ閾値を自動流用しない**。
4. **signal adapter:** MaAI結果を `VAP_STATE{t,p_now,p_future,user_speaking,system_speaking,model_variant,channel_layout}`へ正規化。ただし値の向きと解釈をREADME/実出力で確認してから正規化を実装する。`Maai(mode="vad")`を加える場合はVAD専用結果として分離する。
5. **turn manager:** 初期は原著Appendix Aを参考にしたconfigurable policyを実装。閾値は原論文由来と日本語調整値を別ファイルにする。生のモデル出力・制御判断の双方をログに残す。
6. **replay:** 録音した人間音声＋記録したAI発話音声を再生してVAP出力の再現性を比較。MaAIが動いていない時に擬似的に動いていると表示することは禁止。

MaAI `get_result()`が返すdictの実フィールドは、使用するバージョン・mode・single/dualで確認して`docs/maai_output_schema.json`とテストに固定すること。

## 7. TurnGPTの検証戦略（日本語問題は未解決）

HRI 2025のTurnGPTはテキストのターン完了予測を担当。公開の `ErikEkstedt/TurnGPT` はあるが、**英語で学習されたモデルを日本語の途中認識にそのまま入れても論文相当の予測が出るとは限らない**。以下の順序で進める。

1. GitHubの既存checkpoint・推論スクリプト・ライセンス・依存関係を確認し、原著の学習モデルと一致するかも確認。
2. 日本語で「意味がまだ続く」「文法的に終わるが続きがある」「明確に質問が終わる」などの短いサンプルを収録し、推論が合理的か検証。
3. 不適なら**代替のcompletion estimator**（小型日本語モデル／LLM等）を独立インターフェースで実装。精度の再計測とモデル名の開示を必須とし、TurnGPT再現とは表現しない。
4. `TurnCompletionEstimator`がない初期ステップもMaAI+明示的な招待で動かせるようにする。ただしその場合**HRI 2025近似度は下がる**と明記。

## 8. VRMの「吸気」をモックにしないための品質条件

- アバターは表情を持つ胸から上の3Dモデル。胸郭／肋骨・鎖骨／肩・首・顎・口を協調制御できるよう、必要ならBlenderでリグとblendshapeを作る。
- 微弱な通常呼吸と、LLMの発話希望による**準備吸気**の運動を別のパラメータで実装。胸郭の体積変化が視覚的に確認でき、頭・肩・視線との相対的なタイミングが揃っていること。
- `INHALE`は瞬間的なアニメーション切り替えではなく、速度曲線を持つ時系列モーション。長時間holdせず、短い準備姿勢／静かな呼気で戻る。
- 吸気時には常に音声で息音を付けない。実際に吸気音が必要かは別パラメータ（比較条件）とし、呼吸の視覚表現と混同しない。
- TTSの実音声出力と口形、発話停止と口の停止、再開のタイミングを同期。アバターの待機中にも瞬き・微小姿勢変更を実装するが、発話希望と誤認されないように制御。
- モーションの美しさだけで「何か言いたいと自然に感じる」ことを主張しない。**初見での自由解釈**、合図による自発的な譲渡／継続、違和感を実参加者に観測させる。

## 9. 実装順序：先行研究に忠実な順で積み上げる

**Phase 0｜証拠調査と凍結:** HRI 2025 Appendix A、MaAI、VAP/TurnGPT、APIの現行確認。依存バージョンと機能可否、費用、ライセンス、OS/CPU/GPU要件を表にする。未確認仕様を事実としてコード化しない。

**Phase 1｜HRIの土台（音声制御）:** 日本語interim STT、2ch MaAI、普通のLLM応答先行生成、ElevenLabs streaming TTS、全二重、割り込み時の停止、self-monitoringを実機で通す。3Dは簡易でもよい。**この時点で5分連続対話とログ検証**。

**Phase 2｜今回の本体（発話希望）:** `InitiativeMonitor`・候補の更新/撤回・時刻付き`NEW`イベントを導入。まず研究者画面に生じた瞬間だけ表示し、発話しなくても候補が生じることを検証。**固定周期の強制介入は不合格**。

**Phase 3｜自然な吸気:** リグ付きVRMの胸郭/肩/頭/口の同期モーションを接続。人間が会話継続しても自然にhold/relax/withdrawする。発声時刻と吸気時刻が一致しない場合にも破綻しない。

**Phase 4｜交渉と評価:** VAP/TurnCompletion/明示的発話招待による開始／延期／撤回。研究者操作によるWizard-of-Oz overrideを残し、LLM意図発生の問題と対話制御の問題を分けてデバッグ。複数条件・イベントリプレイ・探索的観察を実装。

## 10. 合格基準・実機で出す証拠

- [ ] Browserで日本語5分間ハンズフリー対話、音声入出力が途切れず連続。参加者は内部UI操作不要。
- [ ] 人間が長く話している途中で、**意味のある異なる内容**に対応した`initiative.NEW`が生じ、理由と発話断片をログで確認できる。
- [ ] LLMの判断→吸気開始が妥当な時刻に到達している。音声認識・LLM・アニメーションの遅延分布を実測。未計測の「低遅延」を宣言しない。
- [ ] 生成候補が人間の続きの説明で解消したら`WITHDRAW`し、古い音声が出ない。
- [ ] 人間が「どうぞ」と発言した場合、声を使った招待・VAP・発話制御の理由がログに残り、AIが不自然に重ならず開始する。
- [ ] AI発話中に人間が割り込める。再生バッファと口形が停止し、発話済みの内容だけを履歴に反映する。
- [ ] **真のMaAI推論**が稼働し、user＋system 2chの入力と`p_now/p_future`を時系列にプロットできる。
- [ ] TurnGPT（または明示した代替）を正しく分類し、その転移適性・不適性の検証結果を示せる。
- [ ] 吸気動作がリグと音声に同期して自然で、相槌・待機呼吸との区別を研究者が自由回答で確認可能。
- [ ] STT／LLM／VAP／TTSの一部失敗を隠さず、失敗・再試行・realtime degradationを研究者ビューとログで示せる。
- [ ] **同じ音声ログをリプレイ**し、少なくとも制御イベントと各予測器出力を追跡できる。
- [ ] 「この体験によって信頼が向上した」等の未実証結論を完成報告に記載しない。

**必須提出:** `README.md`、起動手順、`.env.example`、`DEPENDENCIES_LOCK.md`、`THIRD_PARTY_NOTICES.md`、`docs/architecture.md`、API/provider切替設定、実ログ（匿名）、録画または動作確認手順、テスト結果表、未完了項目一覧。

## 11. Claude Codeに対する作業指示（そのまま入力可能）

> この仕様書の一次資料URLを実際に開いてください。先にHRI 2025 V節とAppendix A、MaAIとTurnGPTの現在のREADME/examples/API/licenseを確認し、再利用できる部分と、日本語用に再実装／検証が必要な部分を表にまとめてください。**その後すぐに動作する縦切り実装を作ってください。** Phase 1（日本語音声対話＋本物のMaAI/VAP）を先に実機テストし、完了を偽らないでください。Phase 2では HRIの先行応答生成とは別に、LLMの内容依存発話意思イベントを実装してください。Phase 3では見た目だけでない自然な吸気モーションを追加してください。Phase 4で発話希望後の開始・延期・変更・撤回を閉ループ制御してください。各段階で失敗時のログと受け入れ結果を出してください。APIキー・学習済みモデル・VRMモデルを勝手に公開コミットせず、必要なユーザー操作は明示してください。モデル学習やHRI論文同等の性能を根拠なく約束しないでください。

## 12. 参照ドキュメント（API）

- HRI 2025 本文とAppendix A: https://arxiv.org/html/2501.08946
- MaAI Github: https://github.com/MaAI-Kyoto/MaAI
- MaAI API: https://maai-kyoto.github.io/MaAI/api/model/
- MaAI Input: https://github.com/MaAI-Kyoto/MaAI/blob/main/readme/input.md
- MaAI VAP example: https://github.com/MaAI-Kyoto/MaAI/tree/main/example/vap
- inokoj VAP-Realtime: https://github.com/inokoj/VAP-Realtime
- original VAP: https://github.com/ErikEkstedt/VAP
- TurnGPT: https://github.com/ErikEkstedt/TurnGPT
- Three VRM: https://github.com/pixiv/three-vrm
- Google Speech-to-Text streaming: https://docs.cloud.google.com/speech-to-text/docs/overview
- Google interim result API: https://docs.cloud.google.com/speech-to-text/docs/reference/rest/v2/StreamingRecognitionResult
- OpenAI live transcription (alternate): https://developers.openai.com/api/docs/guides/realtime-transcription
- ElevenLabs text streaming + audio streaming: https://elevenlabs.io/docs/eleven-api/concepts/audio-streaming
- ElevenLabs websocket: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
- Google TTS streaming (alternate): https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-streaming
- Gemini streaming text: https://ai.google.dev/gemini-api/docs/text-generation

## 13. 実装上、確定していない点を正直に明示する

1. MaAI 2chモデルの実機安定性、日本語環境での最良パラメータ、CPU/GPU実測は未確認。
2. HRI2025のTurnGPT checkpointを日本語へ流用可能か未確認。公式完成コードも未確認。
3. Geminiや他LLMから有意義な自発的発話候補を**発話途中に必要な速さで**安定生成できるか未検証。
4. 3D吸気が視覚的に伝わることと、「AIが自分から発話したい」を伝えることは別。後者は実参加者で評価する。
5. サンプルレート・AEC・ネットワークRTT・利用APIの料金と制限は、動かす環境で実測して決める。
