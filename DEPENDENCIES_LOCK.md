# 依存の固定（骨子）

計画 §7 の提出物。提出版は K（統括）がまとめる。確認日 2026-11-08。

## 実行環境

| 項目 | 版 | 状態 |
|---|---|---|
| Node | 24.21.0（`.nvmrc`、各 `package.json` の `engines` は `>=24 <25`） | この環境の nvm で確認。シェルの既定は v20.19.5 のままなので `nvm use` が必要 |
| npm | 11.19.0（Node 24 に付属） | 確認 |
| Python | 3.12.3 | `.venv` で確認 |

Node 24 の理由は `docs/provider_matrix.md` §1 の #3（`@google-cloud/speech` 8.x と `@google/genai` 3.x が Node 22 以上を要求）。

## npm（レーン F が入れた分。完全な固定は `package-lock.json`）

| パッケージ | 版 | 用途 |
|---|---|---|
| next | 16.4.5 | apps/web |
| react, react-dom | 19.3.1 | apps/web |
| zod | 4.6.7 | packages/contracts |
| ws | 8.22.1 | apps/orchestrator, packages/testkit |
| typescript | 5.9.3 | 型検査。最新の 7.x は Next との組み合わせを未確認なので 5 系に固定 |
| tsx | 4.23.15 | TS の実行 |
| vitest | 4.1.12 | 試験 |
| @types/node | 24.19.2 | 型 |
| @types/ws | 8.18.2 | 型 |
| @types/react, @types/react-dom | 19.3.0 | 型 |

## npm（後続のレーンが入れた分）

版とライセンスは `node_modules` の `package.json` で確認した（2026-11-08）。

| パッケージ | 版 | ライセンス | 用途 |
|---|---|---|---|
| three | 0.187.0 | MIT | apps/web のアバター（H） |
| @pixiv/three-vrm | 3.5.5 | MIT | apps/web のアバター（H） |
| @types/three | 0.187.0 | MIT | 型 |
| @google-cloud/speech | 8.2.1 | Apache-2.0 | apps/orchestrator の STT（C） |
| playwright | 1.65.0 | Apache-2.0 | apps/web の実ブラウザ試験（A） |
| esbuild | 0.28.2 | MIT | apps/web の Worklet と Worker の束ね（A） |

**VRM モデルのライセンス:** 埋め込みメタは CC0。VRoid 公式ページでの確認は未了（`THIRD_PARTY_NOTICES.md`）。上の表はライブラリのライセンスで、モデルの確認の代わりにならない。

## Python（MaAI ワーカー）

固定は `workers/maai/requirements.lock`（`pip install --no-deps -r` で入れる）と `workers/maai/requirements-dev.lock`。

| 項目 | 値 |
|---|---|
| maai | 0.2.25 |
| MaAI の commit | 113efb75293f166ad4a15240d7a3b145886ad37f |
| torch | 2.15.0+cpu |
| onnxruntime | 1.31.1 |
| transformers | 5.5.3 |

- 空の venv に lock だけを入れ（53 パッケージ）、スタブのみで `Maai(mode="vap", lang="jp_kyoto", model_type="normal-ver2", frame_rate=12.5)` の読み込みと無音 30 フレームの `process()` を確認した（2026-11-08）。依存の確認であり、推論の品質や速度の確認ではない。
- `pyaudio` は `workers/maai/compat/pyaudio.py` のスタブ。`MaaiInput.Mic()` は使えない。
- `PyQt5`、`pyqtgraph`、`matplotlib`、`seaborn`、`fastapi`、`pydub` は maai のメタデータにあるが、`process()` を直接呼ぶ構成では読み込まないので固定しない。GUI 出力（`maai.output` の GUI 系）は使えない。
- Kokoro、misaki、spacy は含めない。

## モデルの重み（checkpoint）

R2 の結果で記入する。commit とファイルのハッシュは未記入。

| 重み | 配布元 | 状態 |
|---|---|---|
| `vap_jp_kyoto`, `vap_mc_jp_kyoto` | Hugging Face `maai-kyoto` | 既定の候補（計画 §9-1 の判断待ち）。リビジョン未記入 |
| `vap_jp`, `vap_mc_jp` | Hugging Face `maai-kyoto` | 比較用（区分の確認後）。リビジョン未記入 |
| `continuous-mimi-onnx` | Hugging Face `maai-kyoto` | リビジョン未記入 |

## 外部 API

`docs/provider_matrix.md` を参照。実呼び出しの結果は同 §10。
