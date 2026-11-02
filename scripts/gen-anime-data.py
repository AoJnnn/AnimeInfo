# -*- coding: utf-8 -*-
"""从 G:/AnimenData 生成站点数据 site/data.json

数据源
------
output.xlsx                     主表（26,420 行）
subject.json                    补番名、取「动画制作 / 制作」
person-characters.jsonlines     subject → 声优（cv）关系
person.jsonlines                声优姓名（含中文名）

输出（拆成两份，首屏只等第一份）
----
site/data.json   { meta, items: [[id, 中文名, 原名, 年份, 评分×10, 排名, 平台码, nsfw, 名字长度, 首字], ...] }
site/cast.json   { studios: [...], people: [...], items: [[id, 公司索引, [声优索引...]], ...] }

用法：python scripts/gen-anime-data.py
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
PERSON_CHARS = r"G:\AnimenData\person-characters.jsonlines"
PERSONS = r"G:\AnimenData\person.jsonlines"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "data.json")
CAST_OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "cast.json")

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PLATFORMS = [("TV", {1}), ("OVA", {2}), ("剧场版", {3}), ("WEB", {5}), ("其他", {0, 2006})]
PLATFORM_INDEX = {code: i for i, (_, codes) in enumerate(PLATFORMS) for code in codes}
MAX_CV = 12  # 每部最多保留 12 位声优，控制体积
DATA_VERSION = 3  # 前端会校验；改结构时同步改 site/assets/app.js


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


def studio_from_infobox(text: str) -> str:
    """只取「动画制作」这个干净字段；「製作 / 制作 / 制作公司」是制作委员会，留给后续按词表匹配。"""
    for key in ("动画制作",):
        m = re.search(r"\|\s*" + key + r"\s*=\s*([^\r\n|]+)", text or "")
        if m:
            value = re.sub(r"\[\[|\]\]", "", m.group(1)).strip()
            value = re.sub(r"\s+", " ", value)
            if value:
                return value
    return ""


def committee_text(text: str) -> str:
    """「製作 / 制作 / 制作公司」原文，用来从制作委员会里捞出动画公司。"""
    for key in ("製作", "制作公司", "制作"):
        m = re.search(r"\|\s*" + key + r"\s*=\s*([^\r\n|]+)", text or "")
        if m:
            return m.group(1).strip()
    return ""


# 常见别名 → 统一名，用于剧组表 / 标签匹配
STUDIO_ALIASES = {
    "sunrise": "SUNRISE",
    "サンライズ": "SUNRISE",
    "日本サンライズ": "SUNRISE",
    "bones": "BONES",
    "ボンズ": "BONES",
    "mapaa": "MAPPA",
    "マッパ": "MAPPA",
    "ufotable": "ufotable",
    "ユーフォーテーブル": "ufotable",
    "shaft": "SHAFT",
    "シャフト": "SHAFT",
    "gainax": "GAINAX",
    "ガイナックス": "GAINAX",
    "trigger": "TRIGGER",
    "トリガー": "TRIGGER",
    "京都アニメーション": "京都アニメーション",
    "kyoto animation": "京都アニメーション",
    "kyoani": "京都アニメーション",
    "京阿尼": "京都アニメーション",
    "production i.g": "Production I.G",
    "プロダクション・アイジー": "Production I.G",
    "igi": "Production I.G",
    "madhouse": "MADHOUSE",
    "マッドハウス": "MADHOUSE",
    "j.c.staff": "J.C.STAFF",
    "ジェー・シー・スタッフ": "J.C.STAFF",
    "a-1 pictures": "A-1 Pictures",
    "エー・ワン・ピクチャーズ": "A-1 Pictures",
    "東映アニメーション": "東映アニメーション",
    "toei animation": "東映アニメーション",
    "スタジオジブリ": "スタジオジブリ",
    "ghibli": "スタジオジブリ",
    "ジブリ": "スタジオジブリ",
    "production ig": "Production I.G",
    "pierrot": "ぴえろ",
    "ぴえろ": "ぴえろ",
    "silver link": "SILVER LINK.",
    "silver link.": "SILVER LINK.",
    "tms": "トムス・エンタテインメント",
    "トムス・エンタテインメント": "トムス・エンタテインメント",
    "satelight": "サテライト",
    "サテライト": "サテライト",
    "doga kobo": "動画工房",
    "動画工房": "動画工房",
    "white fox": "WHITE FOX",
    "ホワイトフォックス": "WHITE FOX",
    "cloverworks": "CloverWorks",
    "クローバーワークス": "CloverWorks",
    "wit studio": "WIT STUDIO",
    "ウィットスタジオ": "WIT STUDIO",
    "studio bind": "スタジオバインド",
    "スタジオバインド": "スタジオバインド",
}


def canonical_studio(name: str) -> str:
    return STUDIO_ALIASES.get(name.strip().lower(), name.strip())


def tidy_studio(name: str) -> str:
    """「A→B / C」这类多公司长串只留第一家，过长的截断。"""
    value = re.sub(r"\s+", " ", name or "").strip()
    value = re.split(r"\s*(?:→|/|、|;|；)\s*", value)[0].strip()
    return value[:40]


def match_known_studio(text: str, vocab: list[str], vocab_map: dict[str, str]) -> str:
    """在制作委员会文本里找已知动画公司（长名优先，避免误匹配）。"""
    if not text:
        return ""
    lowered = text.lower()
    for name in vocab:
        if len(name) < 4:
            continue
        if name.lower() in lowered:
            return vocab_map.get(name, name)
    return ""


def studio_from_tags(tags: str, vocab_map: dict[str, str], vocab_set: set[str]) -> str:
    """标签里常直接带公司名（SUNRISE / 京阿尼 / ufotable…）。"""
    for raw in (tags or "").split(","):
        name = raw.strip()
        if not name:
            continue
        canon = canonical_studio(name)
        if canon in vocab_set:
            return canon
        found = vocab_map.get(canon.lower())
        if found:
            return found
    return ""


def load_subjects(path: str, wanted: set[int]) -> dict[int, tuple[str, str, str, str]]:
    """id → (name, name_cn, 动画制作, 製作原文)"""
    found = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r'\{"id":(\d+)', line)
            if not m:
                continue
            sid = int(m.group(1))
            if sid not in wanted:
                continue
            obj = json.loads(line)
            box = obj.get("infobox") or ""
            found[sid] = (
                (obj.get("name") or "").strip(),
                (obj.get("name_cn") or "").strip(),
                studio_from_infobox(box),
                committee_text(box),
            )
    return found


def load_cv_links(path: str, wanted: set[int]) -> dict[int, list[int]]:
    """subject_id → [person_id...]（按角色出场顺序近似保留）"""
    links: dict[int, list[int]] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = obj.get("subject_id")
            pid = obj.get("person_id")
            if sid in wanted and isinstance(pid, int):
                bucket = links.setdefault(sid, [])
                if pid not in bucket:
                    bucket.append(pid)
    return links


def load_person_names(path: str, needed: set[int]) -> dict[int, str]:
    """person_id → "中文名|日文名"（两个都有且不同才拼接）"""
    names = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            m = re.match(r'\{"id":(\d+)', line)
            if not m:
                continue
            pid = int(m.group(1))
            if pid not in needed:
                continue
            obj = json.loads(line)
            jp = (obj.get("name") or "").strip()
            box = obj.get("infobox") or ""
            cn = ""
            mm = re.search(r"\|\s*简体中文名\s*=\s*([^\r\n|]+)", box)
            if mm:
                cn = mm.group(1).strip()
            if cn and jp and cn != jp:
                names[pid] = f"{cn}|{jp}"
            else:
                names[pid] = cn or jp
    return names


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
    print(f"目标 id: {len(wanted)}")

    subjects = load_subjects(SUBJECT, wanted) if os.path.exists(SUBJECT) else {}
    print(f"subject.json 命中: {len(subjects)}")

    cv_links = load_cv_links(PERSON_CHARS, wanted) if os.path.exists(PERSON_CHARS) else {}
    needed_people = {pid for pids in cv_links.values() for pid in pids}
    print(f"有 CV 的条目: {len(cv_links)} | 声优人数: {len(needed_people)}")

    people_names = load_person_names(PERSONS, needed_people) if os.path.exists(PERSONS) else {}
    print(f"声优姓名命中: {len(people_names)}")

    studio_index: dict[str, int] = {"": 0}
    studios: list[str] = [""]
    person_index: dict[str, int] = {}
    people: list[str] = [""]

    # 用「动画制作」字段建立词表，供后面从制作委员会 / 标签里捞公司
    vocab_map: dict[str, str] = {}
    for _, _, clean, _ in subjects.values():
        if clean:
            tidy = tidy_studio(clean)
            canon = canonical_studio(tidy)
            vocab_map.setdefault(tidy.lower(), canon)
            vocab_map.setdefault(canon.lower(), canon)
    vocab_list = sorted(vocab_map, key=len, reverse=True)
    vocab_set = set(vocab_map.values())
    print(f"制作公司词表: {len(vocab_set)} 个")

    items = []
    stats = collections.Counter()
    for r in raw:
        sid_raw = (r.get("C") or "").strip()
        if not sid_raw.isdigit():
            stats["skip_no_id"] += 1
            continue
        sid = int(sid_raw)
        jp, cn, clean_studio, committee = subjects.get(sid, ("", "", "", ""))

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
        if score <= 0 or score > 10:
            score = 0.0
        if score == 0:
            stats["no_score"] += 1

        plat_raw = (r.get("G") or "").strip()
        plat = PLATFORM_INDEX.get(int(plat_raw) if plat_raw.isdigit() else -1, 4)
        nsfw = 1 if (r.get("M") or "").strip() == "是" else 0

        studio = canonical_studio(tidy_studio(clean_studio)) if clean_studio else ""
        if not studio:
            studio = match_known_studio(committee, vocab_list, vocab_map)
            if studio:
                stats["studio_from_committee"] += 1
        if not studio:
            studio = studio_from_tags(r.get("K") or "", vocab_map, vocab_set)
            if studio:
                stats["studio_from_tags"] += 1

        studio_id = 0
        if studio:
            studio_id = studio_index.get(studio)
            if studio_id is None:
                studio_id = len(studios)
                studio_index[studio] = studio_id
                studios.append(studio)

        cvs = []
        for pid in cv_links.get(sid, [])[:MAX_CV]:
            name = people_names.get(pid)
            if not name:
                continue
            index = person_index.get(name)
            if index is None:
                index = len(people)
                person_index[name] = index
                people.append(name)
            cvs.append(index)

        items.append([
            sid,
            display,
            original,
            year,
            int(round(score * 10)),
            int(float(r.get("H") or 0) or 0),
            plat,
            nsfw,
            studio_id,
            cvs,
        ])

    items.sort(key=lambda it: (it[5] == 0, it[5] if it[5] else 0, -it[4], -it[3]))

    # 主数据：筛选/列表必须的字段，外加预计算的名字长度与首字（省掉前端逐条处理）
    core_items = []
    cast_items = []
    for sid, name, _original, year, score10, rank, plat, nsfw, studio_id, cvs in items:
        chars = list(name)
        first = chars[0] if chars else ""
        if "a" <= first <= "z":
            first = first.upper()
        core_items.append([sid, name, year, score10, rank, plat, nsfw, len(chars), first])
        if studio_id or cvs:
            cast_items.append([sid, studio_id, cvs])

    payload = {
        "v": DATA_VERSION,
        "meta": {
            "count": len(items),
            "platforms": [name for name, _ in PLATFORMS],
            "updated": "2026-08",
            "source": "Bangumi (bgm.tv)",
        },
        "items": core_items,
    }
    cast_payload = {"v": DATA_VERSION, "studios": studios, "people": people, "items": cast_items}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    with open(CAST_OUT, "w", encoding="utf-8") as fh:
        json.dump(cast_payload, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(OUT)
    cast_size = os.path.getsize(CAST_OUT)
    years = [it[2] for it in core_items if it[2]]
    print(f"写出 {OUT}: {size / 1024 / 1024:.2f} MB, {len(core_items)} 条")
    print(f"写出 {CAST_OUT}: {cast_size / 1024 / 1024:.2f} MB, {len(cast_items)} 条有声优或公司")
    print(f"制作公司: {len(studios) - 1} 家 | 声优: {len(people) - 1} 人 | 有 CV 的条目: {sum(1 for it in items if it[9])}")
    print(f"公司来源: 动画制作 {stats['studio_from_committee'] + 0} 之外，委员会补 {stats['studio_from_committee']}，标签补 {stats['studio_from_tags']}")
    print(f"年份范围: {min(years)}–{max(years)} | 无年份: {stats['no_year']} | 无评分: {stats['no_score']}")
    print(f"补名: {stats['name_from_subject']} | 占位名: {stats['placeholder_name']} | 跳过: {stats['skip_no_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
