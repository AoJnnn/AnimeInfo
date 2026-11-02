# AnimeInfo · 番剧索引

主站 [aojnnn.github.io](https://aojnnn.github.io/) 的子站点，按**播出年份、评分、番名长度、首字**筛选 Bangumi 收录的动画。
主站的入口在「工具」页里，所以本站导航不再单列「番剧」，只保留主站的五个栏目。

线上地址：<https://aojnnn.github.io/AnimeInfo/>

风格与主站一致：米色纸张底、衬线标题、朱红强调、青色点缀，色板直接复用主站的 `src/style.css`（本仓库 `site/assets/base.css` 是它的副本）。

## 目录

```
AnimeInfo/
├── site/                      # 站点根目录（GitHub Pages 部署这个文件夹）
│   ├── index.html             # 页面骨架：头部导航 / 筛选面板 / 列表 / 底部说明
│   ├── favicon.svg
│   ├── data.json              # 首屏数据，1.5 MB（gzip 后 ~0.64 MB）
│   ├── cast.json              # 声优 / 制作公司，0.63 MB，首屏之后后台加载
│   └── assets/
│       ├── base.css           # 主站 style.css 原样复制，保证设计令牌一致
│       ├── anime.css          # 本页样式
│       └── app.js             # 筛选 / 排序 / 加载更多
├── scripts/
│   ├── gen-anime-data.py      # 数据生成脚本（xlsx + subject.json → data.json / cast.json）
│   └── ...                    # 由主站沿用（feed 生成等）
├── .github/workflows/pages.yml
└── bangumi_crawler.py         # 另一套数据源：Bangumi 排行榜爬虫（见文末）
```

## 页面功能

| 控件 | 说明 |
| --- | --- |
| 搜索 | 匹配番名、**声优**、**制作公司**，忽略大小写，防抖 160 ms；命中声优/公司时条目下方会标出 |
| 播出年份 | 单个输入框，填 2011 就只看 2011 年的番 |
| 评分 | 单个输入框，填 8.5 就只看 8.5 分的番（精确匹配） |
| 番名长度 | 单个输入框，填 4 就只看 4 个字的番名（按中文名 Unicode 码点计） |
| 首字 | 只需输入一个字（拉丁字母自动大写） |
| 排序 | 排名（默认，未排名排最后）/ 评分 / 年份 / 片名长度；手机端收成下拉框 |
| 加载 | 滚动到底自动续 100 条，底部显示「已显示 X / Y 部」或「已显示全部」 |
| 含 R18 | 默认关闭，隐藏 2,854 条 R18 条目 |
| 清空筛选 | 有任意筛选生效时出现在计数行右侧 |

四个筛选都是**定值匹配**，不做区间；想换条件改数字或点「清空筛选」即可。

计数行显示「共 26,360 部 · 当前 N 部」；列表每批渲染 100 条，滚到底自动追加，不会一次性塞两万多个节点。
列表项点击标题会在新标签页打开对应 Bangumi 条目页。

手机端（≤720px）做了压缩：搜索独占一行，排序变成下拉框并与「含 R18」同一行；四个筛选收进「筛选条件」折叠面板，
面板标题带生效项数量的小红点。

## 加载策略（为什么不再卡在「正在读取数据」）

- **拆包**：`data.json` 只放列表/筛选必须的字段（含预计算的名字长度与首字），声优与制作公司拆到 `cast.json`，
  首屏画完再在后台补，不挡渲染。
- **双线竞速**：本地 Pages 和 jsDelivr（`cdn.jsdelivr.net/gh/AoJnnn/AnimeInfo@main/site/`）同时发起请求，
  谁先返回用谁，另一条立刻中止。国内访问 GitHub Pages 经常长时间卡住，这条 CDN 线路通常几百毫秒就回来。
- **超时保护**：本地 30 s、CDN 12 s；慢但能用的线路不会被过早掐断，两条都失败才报错。
- **版本校验**：两份数据都带 `v` 字段，线路返回旧版本会被拒绝，避免 CDN 缓存滞后导致字段错位。
- **状态提示**：3.5 s 后提示「网络有点慢」，8 s 后提示「还在加载（约 1 MB）」，失败时给出「点此重试」。

实测（无头 Chrome 冷缓存、模拟手机网速）：8 Mbps 约 3.0 s、4 Mbps 约 2.8 s、1.5 Mbps 约 5.9 s 出现列表；
断掉本地线路只留 jsDelivr 也能正常打开。第二次访问走浏览器缓存，基本瞬开。

> **改数据时要同步两处**：把 `site/assets/app.js` 里的 `DATA_VERSION` 加一，并把 `CDN_BASE` 的
> `@c6b046e` 换成包含新数据的提交号——否则 CDN 上仍是旧数据，只能走本地线路。

## 数据

数据快照来自 Bangumi 动画导出：

| 来源 | 用途 |
| --- | --- |
| `G:/AnimenData/output.xlsx` | 主表：日期、年份、id、中文名、平台、排名、评分、标签、R18 标记（26,420 行） |
| `G:/AnimenData/subject.json` | 补全中文名 / 原名，取「动画制作」与制作委员会文本（717 MB JSON Lines，流式读） |
| `G:/AnimenData/person-characters.jsonlines` | 条目 → 声优关系（21 万行） |
| `G:/AnimenData/person.jsonlines` | 声优姓名（含中文名） |

`site/data.json` 是首屏数据（含 `v` 版本号），`site/cast.json` 是声优 / 制作公司，两者都是紧凑数组 + 字典编码：

```json
// data.json
{ "v": 2, "meta": { "count": 26360, ... },
  "items": [[326, "攻壳机动队 S.A.C. 2nd GIG", 2004, 92, 1, 0, 0, 20, "攻"]] }

// cast.json
{ "v": 2, "studios": ["", "MAPPA", ...], "people": ["", "花泽香菜|花澤香菜", ...],
  "items": [[326, 5, [64, 65, 67]]] }
```

`data.json` 每行 10 个字段：`[id, 中文名, 原名, 年份, 评分×10, 排名, 平台码, nsfw, 名字长度, 首字]`；
`cast.json` 每行 `[id, 制作公司索引, [声优索引...]]`，公司/声优名放在两个字符串表里。
名字长度与首字在生成时就算好，前端不用再逐条处理；日文原名不再入库（列表不显示，也省掉三成体积）。

覆盖情况：**11,076 部**有制作公司（42%）、**8,959 部**有声优（34%），数据源本身没有的更老/更冷门条目就是空的。

### 清洗规则

- **缺中文名 6,612 条**：从 `subject.json` 补 `name_cn`，再退回日文原名；最终没有一条是占位名。
- **`fst` 列大量 `#REF!`**：整列丢弃，首字与长度都按最终显示名重新计算（与 xlsx 里的 `len` 完全一致）。
- **`year` 列是两位年份**（`08`、`79`）：优先用 `date` 的 4 位年份；`18xx` 这类异常日期按「未知」处理，不作猜测。
- **`platform` 有 `2006` 脏值**：按 `1=TV / 2=OVA / 3=剧场版 / 5=WEB` 映射，`0`、`2006`、空值归入「其他」。
- **`rank=0`（17,128 条）**：表示没有排名，排序时排在最后，列表里显示为横线。
- **`score=0`（4,330 条）**：表示还没有人评分，显示「暂无」，不参与「≥ N 分」筛选。
- **制作公司三级回退**：先取 infobox 的「动画制作」；没有再在「製作 / 制作」的制作委员会文本里匹配已知公司词表（+1,958）；
  最后用标签里的公司名匹配（+4,183）。别名表把 `サンライズ`、`SUNRISE`、`京阿尼` 这类写法归一。
- **声优**：走 `person-characters` 的条目→人物关系，姓名取「中文名|日文名」，每部最多留 12 位控制体积。

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
