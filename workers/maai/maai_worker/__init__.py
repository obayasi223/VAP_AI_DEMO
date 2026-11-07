"""MaAI ワーカー（計画 §3.3）。

音声は Node から localhost の WS で届き、1スレッドが Maai.process(x1, x2) を直接呼ぶ。
start() は使わない。本番の入口は `python -m maai_worker` と `python -m maai_worker.replay`。
どちらも実 MaAI だけを読み込む。test double は tests/support にあり、ここからは参照しない。
"""
