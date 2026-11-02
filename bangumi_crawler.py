# -*- coding: utf-8 -*-
"""Bangumi 动漫数据爬虫

按站内评分排名抓取 Bangumi（番组计划）动画条目，字段包含：
排名、评分、放送年份、标签、话数、平台、制作公司、导演等。

数据来源
--------
1) 排行榜列表页  https://bangumi.tv/anime/browser/?sort=rank&page=N
   提供：条目 id、站内排名、中文名/原名、评分、评分人数
2) 条目详情 API  https://api.bgm.tv/v0/subjects/{id}
   提供：全量标签（含打标人数）、评分分布、放送日期、话数、平台、制作公司、
        导演、收藏统计、系统标签（meta_tags，含国家标签「日本/美国/中国」）等

用法
----
    python bangumi_crawler.py --top 500
    python bangumi_crawler.py --max-rank 10443 --tag 日本 --fields lite
    python bangumi_crawler.py --max-rank all --tag 日本 --delay 0.3 --workers 5

--fields
    full  全部字段（含评分人数、想看/看过/在看/搁置/抛弃）
    lite  去掉 votes 与 wish/collect/doing/on_hold/dropped
    也可自定义：--fields rank,id,name_cn,score,year,tags

输出（默认 ./data）
-------------------
    bangumi_anime_rank{N}-{M}.csv   主表（UTF-8 BOM，Excel 可直接打开）
    bangumi_anime_rank{N}-{M}.json  完整数据
    tag_frequency.csv               标签词频
    raw/subjects/{id}.json          原始响应缓存（断点续爬用）

注意
----
* 请遵守 Bangumi 服务条款，控制请求频率，仅作个人学习/研究用途。
* 中断后重新执行同样命令即可续爬（已缓存条目跳过）。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

BASE = "https://bangumi.tv"
API = "https://api.bgm.tv"
UA = "AnimeInfo-crawler/0.2 (personal study; python-urllib)"

# 字段集
FULL_FIELDS = [
    "rank", "id", "name_cn", "name", "score", "votes", "year", "platform", "eps",
    "tags_top", "tags", "studios", "director", "original",
    "wish", "collect", "doing", "on_hold", "dropped", "nsfw", "url",
]
LITE_FIELDS = [
    "rank", "id", "name_cn", "name", "score", "year", "platform", "eps",
    "tags_top", "tags", "studios", "director", "original", "nsfw", "url",
]
DROPPED_IN_LITE = {"votes", "wish", "collect", "doing", "on_hold", "dropped"}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class RateLimiter:
    """全局限速：任意两次请求间隔不小于 delay 秒；可被 429 触发自适应降速。"""

    def __init__(self, delay: float) -> None:
        self.delay = delay
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            sleep = self.delay - (time.monotonic() - self._last)
            if sleep > 0:
                time.sleep(sleep)
            self._last = time.monotonic()

    def slow_down(self, reason: str) -> None:
        with self._lock:
            old = self.delay
            self.delay = min(max(self.delay * 1.8, 0.3), 5.0)
            if self.delay > old * 1.01:
                print(f"  ! {reason} -> 请求间隔 {old:.2f}s 提高到 {self.delay:.2f}s", flush=True)


def http_get(url: str, limiter: RateLimiter, retries: int = 5, timeout: int = 30) -> bytes:
    last_err: Exception | None = None
    for attempt in range(retries):
        limiter.wait()
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/html"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code == 404:
                raise
            if err.code in (403, 429, 500, 502, 503, 504):
                retry_after = err.headers.get("Retry-After")
                if err.code in (403, 429):
                    limiter.slow_down(f"HTTP {err.code}")
                wait = float(retry_after) if retry_after and retry_after.isdigit() else 2.0 * (attempt + 1)
                print(f"  ! HTTP {err.code} -> {wait:.1f}s 后重试 ({url})", flush=True)
                time.sleep(wait + random.random())
                continue
            raise
        except Exception as err:  # 网络抖动
            last_err = err
            time.sleep(1.5 * (attempt + 1) + random.random())
    raise RuntimeError(f"请求失败: {url}: {last_err}")


# --------------------------------------------------------------------------- #
# 解析
# --------------------------------------------------------------------------- #
_ITEM_RE = re.compile(r'<li id="item_(\d+)" class="item[^"]*"\s*>(.*?)</li>', re.S)

_WEEKDAY_TO_CN = {
    "星期一": "周一", "星期二": "周二", "星期三": "周三", "星期四": "周四",
    "星期五": "周五", "星期六": "周六", "星期日": "周日", "星期天": "周日",
}
_CN_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


def _text(fragment: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", fragment)).strip()


def parse_list_page(html: str) -> list[dict[str, Any]]:
    """解析排行榜列表页，返回按页面顺序排列的条目（含站内 rank）。"""
    out: list[dict[str, Any]] = []
    for m in _ITEM_RE.finditer(html):
        sid, body = int(m.group(1)), m.group(2)
        rank_m = re.search(r'<span class="rank"><small>Rank </small>(\d+)</span>', body)
        if not rank_m:
            continue
        names = re.findall(
            r'<h3>.*?<a href="/subject/\d+" class="l">(.*?)</a>(?:\s*<small class="grey">(.*?)</small>)?',
            body, re.S,
        )
        name_cn, name_jp = "", ""
        if names:
            name_cn, name_jp = _text(names[0][0]), _text(names[0][1])
        info = re.search(r'<p class="info tip">\s*(.*?)\s*</p>', body, re.S)
        score = re.search(r'<small class="fade">([\d.]+)</small>', body)
        votes = re.search(r"\((\d+)人评分\)", body)
        out.append(
            {
                "id": sid,
                "rank": int(rank_m.group(1)),
                "name_cn": name_cn,
                "name": name_jp,
                "list_info": _text(info.group(1)) if info else "",
                "list_score": float(score.group(1)) if score else None,
                "list_votes": int(votes.group(1)) if votes else None,
            }
        )
    return out


def _infobox_map(infobox: list[dict[str, Any]] | None) -> dict[str, str]:
    """把 infobox 的 key/value 展平成 {键: 文本}；list 值用 ' / ' 连接。"""
    result: dict[str, str] = {}
    for item in infobox or []:
        key = str(item.get("key", "")).strip()
        value = item.get("value")
        if isinstance(value, list):
            parts = []
            for v in value:
                if isinstance(v, dict):
                    v_text = str(v.get("v") or v.get("k") or "").strip()
                else:
                    v_text = str(v).strip()
                if v_text:
                    parts.append(v_text)
            value = " / ".join(parts)
        value = str(value or "").strip()
        if key:
            result[key] = value
    return result


def build_record(list_item: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
    box = _infobox_map(detail.get("infobox"))
    rating = detail.get("rating") or {}
    collection = detail.get("collection") or {}
    tags = sorted(detail.get("tags") or [], key=lambda t: t.get("count", 0), reverse=True)

    date = (detail.get("date") or box.get("放送开始") or "").strip()
    year = date[:4] if re.match(r"^\d{4}", date) else ""
    if not year:  # 剧场版/国产动画常用「上映年度」「上映时间」而非「放送开始」
        for key in ("上映年度", "上映时间", "放送开始", "发售时间"):
            m = re.search(r"(19|20)\d{2}", box.get(key, ""))
            if m:
                year = m.group(0)
                break
    weekday_raw = box.get("放送星期", "")
    weekday = _WEEKDAY_TO_CN.get(weekday_raw, weekday_raw)
    if not weekday and re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        weekday = _WEEKDAY_TO_CN[_CN_WEEKDAYS[datetime.strptime(date, "%Y-%m-%d").weekday()]]

    eps = detail.get("eps") or box.get("话数") or ""

    return {
        # 排名 / 评分
        "rank": list_item.get("rank"),
        "id": list_item["id"],
        "name_cn": detail.get("name_cn") or list_item.get("name_cn", ""),
        "name": detail.get("name") or list_item.get("name", ""),
        "score": rating.get("score", list_item.get("list_score")),
        "votes": rating.get("total", list_item.get("list_votes")),
        "rank_api": rating.get("rank"),
        # 放送时间
        "date": date,
        "year": year,
        "weekday": weekday,
        # 基础信息
        "platform": detail.get("platform") or "",
        "eps": eps,
        # 标签
        "tags": tags[:20],
        "tags_top": "; ".join(f"{t['name']}({t['count']})" for t in tags[:8]),
        # STAFF
        "studios": box.get("动画制作") or box.get("制作") or "",
        "director": box.get("导演") or box.get("监督") or "",
        "original": box.get("原作") or "",
        # 收藏统计（人气）
        "wish": collection.get("wish"),
        "collect": collection.get("collect"),
        "doing": collection.get("doing"),
        "on_hold": collection.get("on_hold"),
        "dropped": collection.get("dropped"),
        "nsfw": bool(detail.get("nsfw")),
        "url": f"{BASE}/subject/{list_item['id']}",
        # 附加：供 JSON 使用
        "rating": rating,
        "summary": (detail.get("summary") or "").strip(),
        "infobox": box,
        "images": detail.get("images") or {},
        "total_episodes": detail.get("total_episodes"),
        "meta_tags": detail.get("meta_tags") or [],
    }


def tag_set(rec: dict[str, Any]) -> set[str]:
    """用户标签 + 系统标签（meta_tags 含国家标签，如 日本/美国/中国）。"""
    names = {t["name"] for t in rec.get("tags") or []}
    names.update(rec.get("meta_tags") or [])
    return names


def matches_tags(rec: dict[str, Any], required: list[str]) -> bool:
    return all(tag in tag_set(rec) for tag in required)


# --------------------------------------------------------------------------- #
# 抓取
# --------------------------------------------------------------------------- #
def crawl_list(limiter: RateLimiter, max_rank: int | None, sort: str = "rank") -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        if max_rank is not None and items and items[-1]["rank"] > max_rank:
            break
        url = f"{BASE}/anime/browser/?sort={urllib.parse.quote(sort)}&page={page}"
        html = http_get(url, limiter).decode("utf-8", "replace")
        batch = parse_list_page(html)
        if not batch:
            print(f"  第 {page} 页无条目，停止翻页", flush=True)
            break
        items.extend(batch)
        print(f"  列表页 {page}: +{len(batch)} 条（累计 {len(items)}，当前 rank {batch[-1]['rank']}）", flush=True)
        if max_rank is not None and batch[-1]["rank"] >= max_rank:
            break
        page += 1
        if page > 3000:
            break
    if max_rank is not None:
        items = [it for it in items if it["rank"] <= max_rank]
    return items


def fetch_subject(sid: int, limiter: RateLimiter, cache_dir: str) -> dict[str, Any]:
    path = os.path.join(cache_dir, f"{sid}.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except (json.JSONDecodeError, OSError):
            pass  # 缓存损坏 -> 重新抓取
    data = json.loads(http_get(f"{API}/v0/subjects/{sid}", limiter).decode("utf-8"))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)
    return data


def crawl_details(items: list[dict[str, Any]], limiter: RateLimiter, cache_dir: str, workers: int):
    os.makedirs(cache_dir, exist_ok=True)
    results: dict[int, dict[str, Any]] = {}
    skipped: list[int] = []
    done = 0
    total = len(items)

    def work(it: dict[str, Any]):
        try:
            return it["id"], fetch_subject(it["id"], limiter, cache_dir), None
        except urllib.error.HTTPError as err:
            if err.code == 404:  # 条目已删除/不可见
                return it["id"], None, "404"
            print(f"  ! 条目 {it['id']} HTTP {err.code}", flush=True)
            return it["id"], None, str(err.code)
        except Exception as err:
            print(f"  ! 条目 {it['id']} 抓取失败: {err}", flush=True)
            return it["id"], None, "error"

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for sid, detail, err in pool.map(work, items):
            done += 1
            if detail is not None:
                results[sid] = detail
            else:
                skipped.append(sid)
            if done % 100 == 0 or done == total:
                rate = done / max(time.time() - crawl_details.t0, 1e-6)
                print(f"  详情 {done}/{total}（跳过 {len(skipped)}，{rate:.1f} 条/秒）", flush=True)

    records = []
    for it in items:
        detail = results.get(it["id"])
        if detail is None:
            continue
        records.append(build_record(it, detail))
    return records, skipped


crawl_details.t0 = time.time()


# --------------------------------------------------------------------------- #
# 导出
# --------------------------------------------------------------------------- #
def export(records: list[dict[str, Any]], outdir: str, fields: list[str], slug: str) -> tuple[str, str, str]:
    os.makedirs(outdir, exist_ok=True)
    stem = f"bangumi_anime_rank{records[0]['rank']}-{records[-1]['rank']}{slug}" if records else "bangumi_anime_empty"

    csv_path = os.path.join(outdir, stem + ".csv")
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for rec in records:
            row = {f: rec.get(f) for f in fields}
            row["tags"] = "/".join(t["name"] for t in rec.get("tags") or [])
            writer.writerow(row)

    json_path = os.path.join(outdir, stem + ".json")
    data = []
    for rec in records:
        item = {f: rec.get(f) for f in fields}
        item["date"] = rec.get("date")
        item["weekday"] = rec.get("weekday")
        item["summary"] = rec.get("summary")
        item["images"] = rec.get("images")
        item["infobox"] = rec.get("infobox")
        item["total_episodes"] = rec.get("total_episodes")
        item["meta_tags"] = rec.get("meta_tags")
        if "votes" in fields:
            item["rating"] = rec.get("rating")
        data.append(item)

    payload = {
        "source": "bangumi.tv anime browser (sort=rank) + api.bgm.tv/v0/subjects",
        "crawled_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "count": len(records),
        "fields": fields,
        "data": data,
    }
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)

    tag_path = os.path.join(outdir, "tag_frequency.csv")
    freq: dict[str, int] = {}
    for rec in records:
        for tag in rec.get("tags") or []:
            freq[tag["name"]] = freq.get(tag["name"], 0) + 1
    with open(tag_path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["tag", "count"])
        writer.writeheader()
        writer.writerows({"tag": k, "count": v} for k, v in sorted(freq.items(), key=lambda kv: -kv[1]))

    return csv_path, json_path, tag_path


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="抓取 Bangumi 动画排名/评分/年份/标签")
    ap.add_argument("--top", default=None, help="抓取排名前 N 条（等价于 --max-rank N）")
    ap.add_argument("--max-rank", default=None, help="抓取站内排名 <= N 的全部条目；all 表示不限")
    ap.add_argument("--tag", action="append", default=None, metavar="TAG",
                    help="只保留含该标签的条目（可重复）；如 --tag 日本")
    ap.add_argument("--fields", default="full", help="full / lite / 逗号分隔的字段名")
    ap.add_argument("--sort", default="rank", help="列表排序：rank / date / title")
    ap.add_argument("--delay", type=float, default=0.5, help="请求间隔秒数（默认 0.5）")
    ap.add_argument("--workers", type=int, default=3, help="详情并发数（默认 3）")
    ap.add_argument("--out", default="data", help="输出目录")
    args = ap.parse_args(argv)

    if args.fields == "full":
        fields = list(FULL_FIELDS)
    elif args.fields == "lite":
        fields = list(LITE_FIELDS)
    else:
        fields = [f.strip() for f in args.fields.split(",") if f.strip()]
        unknown = [f for f in fields if f not in FULL_FIELDS and f not in ("date", "weekday", "rank_api")]
        if unknown:
            ap.error(f"未知字段: {unknown}")

    raw_max = args.max_rank if args.max_rank is not None else args.top
    max_rank = None if raw_max is None or str(raw_max).lower() == "all" else int(raw_max)
    required_tags = args.tag or []

    outdir = os.path.abspath(args.out)
    cache_dir = os.path.join(outdir, "raw", "subjects")
    os.makedirs(cache_dir, exist_ok=True)

    limiter = RateLimiter(max(args.delay, 0.1))
    started = time.time()

    print(f"== 抓取排行榜列表（max_rank={max_rank or 'all'}，sort={args.sort}）", flush=True)
    items = crawl_list(limiter, max_rank, args.sort)
    print(f"== 列表完成：{len(items)} 条，用时 {time.time() - started:.0f}s", flush=True)

    crawl_details.t0 = time.time()
    print(f"== 抓取条目详情（并发 {args.workers}）", flush=True)
    records, skipped = crawl_details(items, limiter, cache_dir, max(args.workers, 1))
    records.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0))

    if required_tags:
        before = len(records)
        records = [r for r in records if matches_tags(r, required_tags)]
        print(f"== 标签过滤 {'+'.join(required_tags)}：{before} -> {len(records)} 条", flush=True)

    slug = "_" + re.sub(r"[^\w]+", "", "+".join(required_tags)) if required_tags else ""
    csv_path, json_path, tag_path = export(records, outdir, fields, slug)
    elapsed = time.time() - started
    print(f"\n完成：{len(records)} 条（跳过 {len(skipped)} 条），用时 {elapsed / 60:.1f} 分钟")
    print(f"  CSV : {csv_path}")
    print(f"  JSON: {json_path}")
    print(f"  标签词频: {tag_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
