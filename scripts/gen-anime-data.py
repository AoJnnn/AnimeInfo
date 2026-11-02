# -*- coding: utf-8 -*-
"""从 G:/AnimenData 的两个数据源生成站点的 data.json

输入
----
G:/AnimenData/output.xlsx   Bangumi 动画导出（26420 行）
G:/AnimenData/subject.json  条目详情（JSON Lines，717MB，用来补全缺失的番名）

输出
----
site/data.json  紧凑数组格式：[[id, 中文名, 原名, 年份, 评分, 排名, 平台码, nsfw], ...]

用法
----
python scripts/gen-anime-data.py
"""

from __future__ import annotations

import collections
import json
import os
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

XLSX = r"G:\AnimenData\output.xlsx"
SUBJECT = r"G:\AnimenData\subject.json"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "data.json")

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# Bangumi 平台码 → 站点分类
PLATFORMS = [("TV", {1}), ("OVA", {2}), ("剧场版", {3}), ("WEB", {5}), ("其他", {0, 2006})]
PLATFORM_INDEX = {code: i for i, (_, codes) in enumerate(PLATFORMS) for code in codes}


def read_xlsx(path: str) -> list[dict[str, str]]:
    z = zipfile.ZipFile(path)
    shared = [
        "".join(t.text or "" for t in si.iter(f"{NS}t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{NS}si")
    ]
    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))

    def value(cell):
        kind = cell.get("t")
        v = cell.find(f"{NS}v")
        if kind == "s" and v is not None:
            return shared[int(v.text)]
        if kind == "inlineStr":
            return "".join(x.text or "" for x in cell.iter(f"{NS}t"))
        return v.text if v is not None else ""

    rows = []
    for row in sheet.findall(f".//{NS}row"):
        item = {}
        for cell in row.findall(f"{NS}c"):
            col = re.match(r"[A-Z]+", cell.get("r")).group(0)
            item[col] = value(cell)
        rows.append(item)
    return rows[1:]  # 去掉表头


def load_subject_names(path: str, wanted: set[int]) -> dict[int, tuple[str, str]]:
    """流式读取 JSON Lines，只保留 wanted 里的 id → (name, name_cn)。"""
    found: dict[int, tuple[str, str]] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r'\{"id":(\d+)', line)
            if not m:
                continue
            sid = int(m.group(1))
            if sid not in wanted:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            found[sid] = ((obj.get("name") or "").strip(), (obj.get("name_cn") or "").strip())
            if len(found) >= len(wanted):
                break
    return found


def normalize_year(date_value: str, short_year: str) -> int:
    full = re.match(r"^(\d{4})-", date_value)
    if full:
        year = int(full.group(1))
        return year if 1900 <= year <= 2030 else 0  # 1877 这类异常日期当作未知
    if re.fullmatch(r"\d{2}", short_year):
        year = int(short_year)
        return 1900 + year if year > 30 else 2000 + year
    return 0


def main() -> int:
    if not os.path.exists(XLSX):
        print(f"找不到 {XLSX}")
        return 1

    raw = read_xlsx(XLSX)
    print(f"xlsx 数据行: {len(raw)}")

    wanted = {int(r["C"]) for r in raw if (r.get("C") or "").strip().isdigit()}
    print(f"需要补名的 id: {len(wanted)}")

    names = {}
    if os.path.exists(SUBJECT):
        names = load_subject_names(SUBJECT, wanted)
        print(f"subject.json 命中: {len(names)}/{len(wanted)}")

    items = []
    stats = collections.Counter()
    for r in raw:
        sid_raw = (r.get("C") or "").strip()
        if not sid_raw.isdigit():
            stats["skip_no_id"] += 1
            continue
        sid = int(sid_raw)
        jp, cn = names.get(sid, ("", ""))

        display = (r.get("D") or "").strip() or cn or jp
        if not display:
            display = f"条目 {sid}"
            stats["placeholder_name"] += 1
        elif not (r.get("D") or "").strip():
            stats["name_from_subject"] += 1

        original = jp if jp and jp != display else ""

        year = normalize_year((r.get("A") or "").strip(), (r.get("B") or "").strip())
        if not year:
            stats["no_year"] += 1

        try:
            score = round(float(r.get("I") or 0), 2)
        except ValueError:
            score = 0.0
        try:
            rank = int(float(r.get("H") or 0))
        except ValueError:
            rank = 0
        if score <= 0 or score > 10:
            score = 0.0
        if score == 0:
            stats["no_score"] += 1

        plat_raw = (r.get("G") or "").strip()
        plat = PLATFORM_INDEX.get(int(plat_raw) if plat_raw.isdigit() else -1, 4)

        nsfw = 1 if (r.get("M") or "").strip() == "是" else 0

        items.append([
            sid,
            display,
            original,
            year,
            int(round(score * 10)),   # 评分 × 10 存整数，前端 /10
            rank,
            plat,
            nsfw,
        ])

    # 默认顺序：有排名在前（排名升序），其余按评分降序、年份降序
    items.sort(key=lambda it: (it[5] == 0, it[5] if it[5] else 0, -it[4], -it[3]))

    payload = {
        "meta": {
            "count": len(items),
            "platforms": [name for name, _ in PLATFORMS],
            "updated": "2026-08",
            "source": "Bangumi (bgm.tv)",
        },
        "items": items,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(OUT)
    years = [it[3] for it in items if it[3]]
    print(f"写出 {OUT}: {size / 1024 / 1024:.2f} MB, {len(items)} 条")
    print(f"年份范围: {min(years)}–{max(years)} | 无年份: {stats['no_year']} | 无评分: {stats['no_score']}")
    print(f"补名: {stats['name_from_subject']} | 占位名: {stats['placeholder_name']} | 跳过: {stats['skip_no_id']}")
    print("平台分布:", collections.Counter(it[6] for it in items))
    return 0


if __name__ == "__main__":
    sys.exit(main())
