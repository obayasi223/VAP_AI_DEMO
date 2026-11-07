#!/usr/bin/env bash
# 手順書（docs/initiative_spike.md）の入口。Node の版と .env をここで揃える。
#   bash tools/initiative_spike/run.sh check       録音ファイルの確認（課金なし）
#   bash tools/initiative_spike/run.sh transcribe  録音を Google STT へ流して保存（課金あり。確認あり）
#   bash tools/initiative_spike/run.sh replay ...  保存した逐次 ASR で判定を実行（課金あり）
#   bash tools/initiative_spike/run.sh report ...  結果の表と評価シートを作る
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$HOME/.nvm/nvm.sh" >/dev/null
nvm use >/dev/null
mkdir -p recordings/initiative
ENV_ARG=()
[ -f .env ] && ENV_ARG=(--env-file=.env)
cmd="${1:-}"
shift || true
case "$cmd" in
  check) exec node "${ENV_ARG[@]}" --import tsx tools/initiative_spike/transcribe_wav.ts --check-only "$@" ;;
  transcribe) exec node "${ENV_ARG[@]}" --import tsx tools/initiative_spike/transcribe_wav.ts "$@" ;;
  inject) exec node --import tsx tools/initiative_spike/inject_misrecognition.ts "$@" ;;
  replay) exec node "${ENV_ARG[@]}" --import tsx tools/initiative_spike/run_replay.ts "$@" ;;
  report) exec node --import tsx tools/initiative_spike/report.ts "$@" ;;
  *) sed -n '2,6p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
