# AnimeInfo · 番剧索引

主站 [aojnnn.github.io](https://aojnnn.github.io/) 的子站点，按**播出年份、评分、番名长度、首字**筛选 Bangumi 收录的动画。

线上地址：<https://aojnnn.github.io/AnimeInfo/>

风格与主站一致：米色纸张底、衬线标题、朱红强调、青色点缀，色板直接复用主站的 `src/style.css`（本仓库 `site/assets/base.css` 是它的副本）。

## 目录

```
AnimeInfo/
├── site/                      # 站点根目录（GitHub Pages 部署这个文件夹）
│   ├── index.html             # 页面骨架：头部导航 / 筛选面板 / 列表 / 底部说明
│   ├── favicon.svg
│   ├── data.json              # 生成物，1.9 MB，26,360 条
│   └── assets/
│       ├── base.css           # 主站 style.css 原样复制，保证设计令牌一致
│       ├── anime.css          # 本页样式
│       └── app.js             # 筛选 / 排序 / 加载更多
├── scripts/
│   ├── gen-anime-data.py      # 数据生成脚本（xlsx + subject.json → data.json）
│   └── ...                    # 由主站沿用（feed 生成等）
├── .github/workflows/pages.yml
└── bangumi_crawler.py         # 另一套数据源：Bangumi 排行榜爬虫（见文末）
```

## 页面功能

| 控件 | 说明 |
| --- | --- |
| 搜索 | 匹配中文名与原名，忽略大小写，防抖 160 ms |
| 播出年份 | 起止年份下拉，任一端留空即不限；选了年份后「年份未知」的条目会自动排除 |
| 评分 | `≥7.0 / 7.5 / 8.0 / 8.5 / 9.0` 快捷筛选，无评分条目不会被选中 |
| 番名长度 | 1–4 / 5–8 / 9–12 / 13 字以上（按中文名字符数，Unicode 码点计） |
| 首字 | 数据中出现频率最高的 18 个首字做快捷 chip，也可以直接输入任意首字 |
| 排序 | 排名（默认，未排名排最后）/ 评分 / 年份 / 片名长度 |
| 含 R18 | 默认关闭，隐藏 2,854 条 R18 条目 |
| 清空筛选 | 有任意筛选生效时出现在计数行右侧 |

计数行显示「共 26,360 部 · 当前 N 部」；列表每次渲染 60 条，点「加载更多」追加，不会一次性塞两万多个节点。
列表项点击标题会在新标签页打开对应 Bangumi 条目页。

## 数据

数据快照来自 Bangumi 动画导出：

| 来源 | 用途 |
| --- | --- |
| `G:/AnimenData/output.xlsx` | 主表：日期、年份、id、中文名、平台、排名、评分、标签、R18 标记（26,420 行） |
| `G:/AnimenData/subject.json` | 补全缺失的中文名 / 原名（717 MB JSON Lines，只流式读取需要的 26,360 个 id） |

`site/data.json` 为紧凑数组格式：

```json
{
  "meta": { "count": 26360, "platforms": ["TV","OVA","剧场版","WEB","其他"], "updated": "2026-08" },
  "items": [[326, "攻壳机动队 S.A.C. 2nd GIG", "攻殻機動隊 S.A.C. 2nd GIG", 2004, 92, 1, 0, 0]]
}
```

`items` 每行 8 个字段：`[id, 中文名, 原名, 年份, 评分×10, 排名, 平台码, nsfw]`。评分乘 10 存整数，前端再除回去，省体积。

### 清洗规则

- **缺中文名 6,612 条**：从 `subject.json` 补 `name_cn`，再退回日文原名；最终没有一条是占位名。
- **`fst` 列大量 `#REF!`**：整列丢弃，首字与长度都按最终显示名重新计算（与 xlsx 里的 `len` 完全一致）。
- **`year` 列是两位年份**（`08`、`79`）：优先用 `date` 的 4 位年份；`18xx` 这类异常日期按「未知」处理，不作猜测。
- **`platform` 有 `2006` 脏值**：按 `1=TV / 2=OVA / 3=剧场版 / 5=WEB` 映射，`0`、`2006`、空值归入「其他」。
- **`rank=0`（17,128 条）**：表示没有排名，排序时排在最后，列表里显示为横线。
- **`score=0`（4,330 条）**：表示还没有人评分，显示「暂无」，不参与「≥ N 分」筛选。

### 更新数据

```bash
python scripts/gen-anime-data.py     # 读 G:/AnimenData，重写 site/data.json
```

脚本只依赖 Python 标准库（xlsx 用 zipfile + XML 解析，subject.json 逐行流式读取），一分钟内跑完。

## 本地预览

```bash
python -m http.server 8765 --directory site
# 打开 http://127.0.0.1:8765/
```

不要直接双击 `index.html`：`fetch('./data.json')` 在 `file://` 下会被浏览器拦掉。

## 部署

仓库是一个独立的 GitHub 项目站点（仓库名 `AnimeInfo` → `https://aojnnn.github.io/AnimeInfo/`）：

1. 推送本仓库到 GitHub 的 `AnimeInfo` 仓库（默认分支 `main`）。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
3. `.github/workflows/pages.yml` 会在每次 push 后把 `site/` 发布上去。

`site/.nojekyll` 已就位，避免 Pages 用 Jekyll 处理静态文件。

## 另一个数据源：bangumi_crawler.py

仓库里还留着一套独立的爬虫，用来抓 Bangumi 排行榜（评分、排名、放送年份、标签）：

```bash
python bangumi_crawler.py --max-rank 10443 --tag 日本 --fields lite
```

它产出 CSV/JSON 到 `data/`（已在 `.gitignore` 里忽略），与本页面的 `site/data.json` 无关，可单独使用。
