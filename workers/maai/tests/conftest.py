import sys
from pathlib import Path

# workers/maai を import の起点にする（contract パッケージと compat のスタブ）。
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "compat"))
