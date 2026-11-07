# アーキテクチャ（骨子）

レーン F が作った骨子。提出版は K（統括）がまとめる。正本の設計は `docs/implementation_plan.md`。
未実装の箇所はその旨を書いている。ここの記述は動作の証拠ではない。

## 構成

```text
Browser (apps/web)
  AudioWorklet + Worker: mic / 書き込み済み sys を 16kHz の AUDIO 枠で上りへ、PCM 枠を再生
      │ WS（binary: AUDIO 枠、PCM 枠 / text: browser_rpc の JSON）
      ▼
Node orchestrator (apps/orchestrator)        ── emit() の本体はここだけ
  session / TurnManager / Negotiator / providers
      │ mic のみ            │ mic + sys                     │ テキスト
      ▼                     ▼                               ▼
  Google STT v2      MaAI ワーカー (workers/maai)    Gemini / ElevenLabs
                     WS（AUDIO 枠 / maai_rpc の JSON）
```

| 場所 | 内容 | 状態 |
|---|---|---|
| `packages/contracts` | 契約の正本。下の表 | F が実装 |
| `packages/testkit` | test double と偽サーバー。本番の検証に数えない | F が実装 |
| `apps/web` | Next.js の雛形 | 本体は A、H、I、J |
| `apps/orchestrator` | 雛形 | 本体は C、D、E、G、I、J |
| `workers/maai` | lock、`pyaudio` スタブ、`contract/`（検証と枠）を F が実装 | ワーカー本体は B |
| `config/` | `policy.hri2025.json`（原著値、変更不可）、`policy.ja.json`（雛形） | 節ごとの持ち主は計画 §3.1 |

## 契約の入口

| 内容 | ファイル（`packages/contracts/src/`） | 主な名前 |
|---|---|---|
| バイナリ枠（依存なし、Worklet から読める） | `binary.ts`（Python は `workers/maai/contract/frames.py`） | `encodeAudioFrame`, `decodeAudioFrame`, `encodePcmFrame`, `decodePcmFrame`, `isStaleGeneration` |
| Browser↔Node | `browser_rpc.ts` | `BrowserToNode`, `NodeToBrowser` |
| Node↔Python | `maai_rpc.ts`, `vap.ts` | `MaaiNodeToWorker`, `MaaiWorkerToNode`, `Vap2chState`, `Vap1chState` |
| イベント | `events.ts` | `ResearchEvent`, `EVENT_NAMES` |
| 発行 | `emit.ts`, `clock.ts`, `forwarding.ts` | `createEventEmitter`, `EventSink`, `TimeSource`, `EVENT_ROUTES` |
| TurnManager | `turn.ts`, `policy.ts` | `TurnStep`, `TurnInputs`, `TurnDecision`, `Policy` |
| プロバイダ | `providers.ts`, `vendor_shapes.ts` | `SttProvider`, `TtsProvider`, `LlmProvider`, `SpeechGenerator` |
| 履歴、候補 | `history.ts`, `candidates.ts` | `ConversationHistory`, `CandidateStore` |
| JSON Schema | `schema_registry.ts`、生成物は `schemas/`（`npm run gen:schemas`） | Python は `workers/maai/contract/validator.py` |

## 契約の規則

- 省略可能な項目を作らない。値が不要なら判別共用体で項目ごと持たず、値が得られなければ `{value: null, null_reason}`。
- モデルの出力は `ModelOutput`、コードの検証結果は `Verified` で包む。ゲートの判定にモデルの説明を使わない。
- `audio_frame` は 16kHz サンプルの連番で、STT、VAP、再生の時間軸を結ぶ。
- 世代はセッション内で単調増加し、停止のたびに増える。古い世代は全段で棄てる。
- 別プロセスの時刻は直接比較せず、`time_basis` に由来と誤差を残す。
- 契約の変更は統括を経由する。

## 未記入（後続レーンの材料待ち）

- 時計補正の実装と精度（A、J）
- 全二重音声の実測（A）
- STT のストリーム切替（C）、TTS の接続の持ち方（D）
- 状態機械（E）、発話希望（G）、吸気（H）
- 障害時の振る舞いと表示（各レーン、I）
