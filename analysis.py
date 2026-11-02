# -*- coding: utf-8 -*-
"""对爬取结果做快速统计，生成 data/summary.md

用法：
    python analysis.py [data/bangumi_anime_rank1-500.json]
"""

from __future__ import annotations

import collections
import glob
import json
import os
import sys


def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["data"]


def main() -> int:
    if len(sys.argv) > 1:
        path = sys.argv[1]
    else:
        cands = glob.glob(os.path.join("data", "bangumi_anime_rank*.json"))
        if not cands:
            print("找不到 data/bangumi_anime_rank*.json，请先运行 bangumi_crawler.py")
            return 1
        path = max(cands, key=os.path.getmtime)  # 取最新一份

    recs = load(path)
    n = len(recs)
    years = collections.Counter(r["year"] for r in recs if r.get("year"))
    tags = collections.Counter(t["name"] for r in recs for t in r.get("tags", []))
    studios = collections.Counter(
        s.strip() for r in recs for s in str(r.get("studios", "")).split("/") if s.strip()
    )
    platforms = collections.Counter(r.get("platform") or "未知" for r in recs)
    scores = [r["score"] for r in recs if r.get("score")]

    decades = collections.Counter(f"{y[:3]}0s" for y in years.elements())

    lines = []
    add = lines.append
    add(f"# Bangumi 动画排行数据速览\n")
    add(f"- 数据文件：`{os.path.basename(path)}`")
    add(f"- 条目数：**{n}**（排名 {recs[0]['rank']} – {recs[-1]['rank']}）")
    if scores:
        add(f"- 评分范围：{min(scores):.1f} – {max(scores):.1f}，均值 {sum(scores)/len(scores):.2f}")
    add("")

    add("## 年代分布\n")
    add("| 年代 | 条目数 |")
    add("| --- | --- |")
    for d, c in sorted(decades.items()):
        add(f"| {d} | {c} |")
    add("")

    add("## 平台分布\n")
    add("| 平台 | 条目数 |")
    add("| --- | --- |")
    for p, c in platforms.most_common():
        add(f"| {p} | {c} |")
    add("")

    add("## 标签 Top 20\n")
    add("| 标签 | 出现条目数 |")
    add("| --- | --- |")
    for t, c in tags.most_common(20):
        add(f"| {t} | {c} |")
    add("")

    add("## 制作公司 Top 15\n")
    add("| 公司 | 上榜条目数 |")
    add("| --- | --- |")
    for s, c in studios.most_common(15):
        add(f"| {s} | {c} |")
    add("")

    add("## 最老 / 最新上榜\n")
    dated = sorted((r for r in recs if r.get("year")), key=lambda r: r["year"])
    add("| 方向 | 排名 | 名称 | 年份 | 评分 |")
    add("| --- | --- | --- | --- | --- |")
    for r in dated[:5]:
        add(f"| 最早 | {r['rank']} | {r['name_cn']} | {r['year']} | {r['score']} |")
    for r in dated[-5:]:
        add(f"| 最新 | {r['rank']} | {r['name_cn']} | {r['year']} | {r['score']} |")
    add("")

    out = os.path.join(os.path.dirname(path), "summary.md")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\n已写入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
