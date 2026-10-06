#!/usr/bin/env node
/**
 * 交易博客生成器：把 posts/ 里的 Markdown 渲染成一套静态多页 HTML 站点。
 *
 * 输出的是一套「真博客」，而不是一本一次加载完的单页书：
 *   index.html         首页：顶栏 + 左侧栏（置顶 / 栏目 / 统计）+ 栏目标题 + 按时间倒序的简明文章列表
 *   posts/<slug>.html  文章页：标题 + 元信息 + 正文（小节 ≥2 时带左侧目录）+ 「更新的一篇 / 更早的一篇」两个链接
 *   stats.html         写作统计：按月发文 / 栏目 / 标签分布（构建时算好，纯静态、无脚本）
 *   feed.xml           订阅源（RSS 2.0，全文进 content:encoded，地址全部绝对化）
 *   assets/            正文图片压缩后的成品
 * 首页只放简洁条目（标题 / 一行摘要 / 日期 · 栏目 · 标签），正文留在文章页；frontmatter 写 pin: true 可置顶。
 * 列表超过 20 篇时出现「加载更多」，分批显示；筛选 / 搜索时自动回到第一批。
 *
 * 视觉沿用 cdyforever/how-to-live-better 那套阅读页：明暗主题、手机端自适应、
 * 可打印、图片压缩 + 懒加载 + 点击放大。零外部资源，断网可读。
 *
 * 用法：
 *   node build.ts                      # 读取 ./posts，输出 ./index.html 与 ./posts/*.html
 *   node build.ts -o dist/index.html   # 指定首页文件；站点根 = 该文件所在目录
 *   node build.ts --content ./posts    # 指定内容目录
 *   node build.ts --watch              # 监听内容目录，改动即重建（本地写作时用）
 *   node build.ts --allow-empty        # 确认要清空站点时才用（默认：一篇都找不到但还有旧页面时会中止）
 *
 * 运行环境：Node.js ≥ 22.18（原生直跑 TypeScript，无需编译，零依赖）。
 *
 * 内容怎么放：
 *   posts/记录/2026-09-26-标题.md    ← 文件夹名 = 栏目名，改名 / 新建都会自动生效
 *   posts/文章/任意标题.md
 *   每个文件开头可写 frontmatter（title / date / tags 都可省略）：
 *   ---
 *   title: 标题
 *   date: 2026-09-26
 *   tags: BTC, 止损
 *   ---
 *
 * 图片：正文里的 ![说明](相对路径) 会在构建时自动压缩，输出到 assets/：
 *   · 长边压到 1600px 以内（只缩不放），转 WebP（质量 82）；常见截图能小 80% 以上
 *   · 文件名带内容+配置的哈希：改图/改配置即换名，缓存永不失效
 *   · HTML 里自动带宽度高度（加载时不跳动）、懒加载（不拖慢首屏）、点击可放大
 *   · 显示尺寸随文章自适应：宽图不溢出、小图不放大、竖长图限高，图注居中
 *   · 原图放哪都行，只要能相对 md 文件找到；建议留在 posts/ 里（推上 GitHub 才能自动重建）
 *
 * 配乐（可选，自托管）：frontmatter 写一行 `music: 曲名 | 文件名.mp3`（只写文件名则用文件名当曲名），
 *   写 http(s) 链接则直接引用不复制。本地音频按内容哈希复制到 assets/，不转码；
 *   文章页默认折叠成一行「♪ 配乐 · 曲名」，展开才出现播放条（preload="none"，不点不产生请求）；
 *   滚动离开后右下角出现带进度环的小圆钮，可随时播放 / 暂停。无 JS 时退回原生 <audio>。
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ═══════════════════ 站点配置：改这里就行 ═══════════════════ */

const SITE = {
  name: '12传说',   // 站点名字（顶栏标题）
  tagline: '',            // 顶栏小字；留空时自动显示「共 N 篇」
  description: '',        // 搜索引擎描述；留空时自动生成
  // 线上绝对地址（分享卡片 og:url / canonical / 图片绝对链接用）；留空则退回相对地址。
  // 换域名或换仓库名时改这里，并在下面 OG_CARD 处确认默认分享图还在。
  url: 'https://upsincos.github.io/2026t/',
};

// 栏目 = posts/ 下的文件夹，自动识别：新建 / 改名 / 移动文件夹都会自动生效，不需要改这里。
// 这个列表只控制「显示顺序」：先按这里的名字排，没列到的按名称排在后面。
const SECTION_ORDER: string[] = ['记录', '文章', '几何'];

// 文章语气：只调结构标记的「冷暖 + 呼吸」，不动正文字号 / 行高 / 段距（那套曾被用户否掉）。
// 键是 posts/ 下的文件夹名，改了文件夹名只会回落成默认语气（不报错、不影响构建）。
const SECTION_TONE: Record<string, string> = {
  那座山: 'prose',
};

// 图片处理
const IMAGES = {
  enabled: true,     // 关掉则完全不处理图片（原样引用）
  maxSide: 1600,     // 长边上限（像素）；只缩不放
  quality: 82,       // WebP / JPEG 质量
  dir: 'assets',     // 压缩后的图片目录（与 index.html 同级）
};

const CONTENT_DIR = 'posts';   // 内容目录（可用 --content 覆盖）

/* ══════════════════════════════════════════════════════════ */

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printHelp(): void {
  console.log(`用法：node build.ts [-o 首页文件] [--content 内容目录] [--watch] [--allow-empty]

把 posts/ 里的 Markdown 渲染成一套静态多页 HTML 站点（首页列表 + 每篇一页）。
栏目 = posts/ 下的文件夹（自动识别，改名 / 新建 / 移动都会自动跟随）。

示例：
  node build.ts                      # 读取 ./posts，输出 ./index.html 与 ./posts/*.html
  node build.ts -o dist/index.html   # 站点根 = 首页文件所在目录（文章页与 assets/ 都在它下面）
  node build.ts --content ./posts
  node build.ts --watch              # 监听内容目录变化，自动重建（生成的 .html 不会触发）
  node build.ts --allow-empty        # 确实要清空站点时才加（默认：没有文章却还有旧页面时中止，防误删）

产物结构：
  index.html          首页：顶栏 + 左侧栏（置顶 / 栏目）+ 栏目标题 + 按时间倒序的简明文章列表
  posts/<slug>.html   文章页：标题 + 元信息 + 正文（≥2 个小节带左侧目录）+ 「更新的一篇 / 更早的一篇」链接
  assets/             正文图片压缩后的成品（WebP、长边 ≤1600px）

内容目录也可用环境变量 BLOG_CONTENT 指定（优先级低于 --content）。`);
}

const argv = process.argv.slice(2);
let outArg: string | null = null;
let contentArg: string | null = null;
let watchMode = false;
let allowEmpty = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o' || a === '--out') {
    if (i + 1 >= argv.length) die(`参数 ${a} 需要跟一个值`);
    outArg = argv[++i];
  } else if (a === '--content') {
    if (i + 1 >= argv.length) die(`参数 ${a} 需要跟一个值`);
    contentArg = argv[++i];
  } else if (a === '-w' || a === '--watch') {
    watchMode = true;
  } else if (a === '--allow-empty') {
    allowEmpty = true;
  } else if (a === '-h' || a === '--help') {
    printHelp();
    process.exit(0);
  } else {
    die(`未知参数：${a}（用 --help 查看用法）`);
  }
}

const CONTENT = contentArg || process.env.BLOG_CONTENT || join(HERE, CONTENT_DIR);

// 首页文件路径（-o 可指定）；站点根 = 首页所在目录，文章页与 assets/ 都相对它输出
const OUT_FILE = outArg ? (isAbsolute(outArg) ? outArg : join(HERE, outArg)) : join(HERE, 'index.html');
const SITE_ROOT = dirname(OUT_FILE);
const PAGES_DIR = 'posts';          // 文章页目录（站点根下）
const PAGES_OUT = join(SITE_ROOT, PAGES_DIR);
const PAGE_PREFIX = '../';          // 文章页引用站点根资源（assets/）的相对前缀
const STATIC_DIR = join(HERE, 'static');   // 原样复制进站点根的静态文件（目前只有分享卡片）

/* ─────────────── 读取与解析 ─────────────── */

interface Entry {
  title: string;
  date: string;
  tags: string[];
  body: string;
  file: string;
  dir: string;      // md 所在目录（用于解析图片相对路径）
  relPath: string;  // 相对内容根目录的路径（用于提示信息）
  pinned: boolean;  // frontmatter 写 pin: true 时置顶
  music?: { title: string; src: string };  // frontmatter music: 曲名 | 文件名.mp3
  musicAbs?: string;                       // 解析到的本地音频绝对路径（外链时不设）
  musicRel?: string;                       // 输出的站点根相对路径（或原样的外链）
}

interface Section {
  dir: string;
  label: string;
  idx: number;
  entries: Entry[];
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return { meta: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*[:：]\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (m[2].trim() === '') {
      // Obsidian 风格的 YAML 列表：tags:\n  - a\n  - b
      const items: string[] = [];
      let j = i + 1;
      while (j < end) {
        const it = /^\s*-\s+(.+?)\s*$/.exec(lines[j]);
        if (!it) break;
        items.push(it[1].replace(/^['"]|['"]$/g, ''));
        j++;
      }
      if (items.length) {
        meta[key] = items.join(',');
        i = j - 1;
        continue;
      }
    }
    meta[key] = m[2].trim();
  }
  return { meta, body: lines.slice(end + 1).join('\n') };
}

function splitTags(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 递归收集一个目录下的全部 .md（跳过隐藏目录/文件），顺序固定（构建可复现）
function listMdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let items: string[] = [];
    try {
      items = readdirSync(d);
    } catch {
      return;
    }
    items.sort();
    for (const it of items) {
      if (it.startsWith('.')) continue;
      const p = join(d, it);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.md$/i.test(it)) out.push(p);
      } catch {
        /* 忽略 */
      }
    }
  };
  walk(dir);
  return out;
}

// 栏目 = posts/ 下包含 .md 的文件夹（含其子目录里的 md）。
// 文件夹怎么改名 / 移动 / 新建都会自动生效，不需要改任何配置。
// 例外：`.` 与 `_` 开头的文件夹一律不当栏目（`_drafts` / `_素材` 这类不会意外上线）。
function discoverSections(): { dir: string; label: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(CONTENT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch {
    die(`内容目录不存在或无法读取：${CONTENT}\n提示：posts/ 是否被改名或移走了？`);
  }
  // posts/ 根目录直接放的 md 不属于任何栏目——明确提示，避免“写完没显示”
  const rootMd = readdirSync(CONTENT).filter((n) => /\.md$/i.test(n));
  if (rootMd.length > 0) {
    console.warn(
      `提示：posts/ 根目录下的 ${rootMd.length} 个 md 不会被收录（${rootMd.join('、')}）；把它们放进栏目文件夹（如 posts/记录/）才会显示。`,
    );
  }
  const dirs = names.filter((n) => listMdFiles(join(CONTENT, n)).length > 0);
  const rank = (n: string): number => {
    const i = SECTION_ORDER.indexOf(n);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  dirs.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return dirs.map((n) => ({ dir: n, label: n }));
}

// 读取一个栏目（文件夹）下的全部文章
// `music: 曲名 | 文件名.mp3` 或 `music: 文件名.mp3`（分隔符 | 或 ｜ 都认）
function parseMusic(raw: string): { title: string; src: string } | undefined {
  if (!raw) return undefined;
  const [a, b] = raw.split(/[|｜]/).map((s) => s.trim());
  const src = (b || a).trim();
  if (!src) return undefined;
  const title = (b ? a : '').trim() || src.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return { title, src };
}

function loadSection(sec: { dir: string; label: string }): Entry[] {
  const dir = join(CONTENT, sec.dir);
  const entries: Entry[] = [];
  for (const full of listMdFiles(dir)) {
    const name = basename(full);
    const raw = readFileSync(full, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const stem = name.replace(/\.md$/i, '');
    // 2026-09-28 或 2026-9-28 都认；统一规范化成 YYYY-MM-DD（排序用）
    const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})[-_ ]?(.*)$/.exec(stem);
    const pad2 = (x: string) => x.padStart(2, '0');
    const fileDate = dm ? `${dm[1]}-${pad2(dm[2])}-${pad2(dm[3])}` : '';
    const date = (meta['date'] || fileDate)
      .trim()
      .replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_s: string, y: string, mo: string, d: string) => `${y}-${pad2(mo)}-${pad2(d)}`);
    let title = (meta['title'] || '').trim();
    if (!title) title = dm && dm[4] ? dm[4].trim() : stem;
    const tags = splitTags(meta['tags']);
    const pinVal = (meta['pin'] || '').trim().toLowerCase();
    const pinned = ['true', '1', 'yes', 'y', '是'].includes(pinVal);
    const music = parseMusic((meta['music'] || '').trim());
    entries.push({
      title, date, tags, body, file: name, dir: dirname(full), relPath: relative(CONTENT, full), pinned, music,
    });
  }
  // 有日期的新的在前；无日期的排在后面，按文件名
  entries.sort((a, b) => {
    if (a.date && b.date) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    }
    if (a.date) return -1;
    if (b.date) return 1;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return entries;
}

/* ═══════════════ 图片流水线：找到 → 压缩 → 输出到 assets/ ═══════════════ */

interface ImgInfo { rel: string; w: number; h: number }

const IMG_INFOS = new Map<string, ImgInfo>();          // 源文件绝对路径 → 输出信息
const IMG_JOBS = new Map<string, { abs: string }>();   // 去重后的待处理图片
const IMG_MISSING: { src: string; from: string }[] = []; // 找不到的引用
const RESOLVE_CACHE = new Map<string, string | null>();  // (raw路径|md目录) → 绝对路径

const assetsDir = join(SITE_ROOT, IMAGES.dir);

// 匹配 ![alt](src) 或 ![alt](<src with space>)；可带 "title"
const RE_IMG = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
// Obsidian 式图片引用：![[名称]]（可带别名 |xxx）
const RE_WIKI = /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;

function cleanSrc(raw: string): string {
  let p = raw.trim();
  if (p.startsWith('<') && p.endsWith('>')) p = p.slice(1, -1).trim();
  return p;
}

// 通用的本地资源解析：同目录 → 同目录的 <sub>/ 子目录 → 内容根 → 仓库根 → 全库按文件名兜底
function resolveLocalPath(rawSrc: string, mdDir: string, sub: string): string | null {
  const key = rawSrc + '\u0000' + mdDir + '\u0000' + sub;
  const hit = RESOLVE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const compute = (): string | null => {
    let p = cleanSrc(rawSrc);
    if (/^(https?:|data:|mailto:)/i.test(p)) return null;   // 外链/内嵌：不处理
    try {
      p = decodeURIComponent(p);
    } catch {
      /* 原样 */
    }
    if (isAbsolute(p)) {
      try {
        return statSync(p).isFile() ? p : null;
      } catch {
        return null;
      }
    }
    const tries = [join(mdDir, p), join(mdDir, sub, p), join(CONTENT, p), join(HERE, p)];
    for (const t of tries) {
      try {
        if (statSync(t).isFile()) return t;
      } catch {
        /* 下一个 */
      }
    }
    // 兜底：只写了文件名（Obsidian / Typora 常见）→ 在内容目录里按文件名找唯一命中
    if (!p.includes('/') && !p.includes('\\')) {
      const hit = fileIndex().get(p);
      if (hit) return hit;
    }
    return null
  };
  const res = compute();
  RESOLVE_CACHE.set(key, res);
  return res;
}

function resolveImagePath(rawSrc: string, mdDir: string): string | null {
  return resolveLocalPath(rawSrc, mdDir, 'images');
}

// 内容目录「文件名 → 绝对路径」索引（懒构建；重名时先到先得）。
// 供只写文件名的引用兜底——Obsidian / Typora 常见写法：![](btc-4h.png)、![[btc-4h.png]]
const FILE_INDEX = new Map<string, string>();
let FILE_INDEX_READY = false;
function fileIndex(): Map<string, string> {
  if (!FILE_INDEX_READY) {
    const walk = (d: string): void => {
      let items: string[] = [];
      try {
        items = readdirSync(d);
      } catch {
        return;
      }
      for (const it of items) {
        if (it.startsWith('.')) continue;
        const p = join(d, it);
        try {
          if (statSync(p).isDirectory()) walk(p);
          else if (!FILE_INDEX.has(it)) FILE_INDEX.set(it, p);
        } catch {
          /* 忽略 */
        }
      }
    };
    walk(CONTENT);
    FILE_INDEX_READY = true;
  }
  return FILE_INDEX;
}

function resolveWikiImage(name: string, mdDir: string): string | null {
  const key = 'wiki\u0000' + name + '\u0000' + mdDir;
  const hit = RESOLVE_CACHE.get(key);
  if (hit !== undefined) return hit;
  let res: string | null = null;
  const tries = [join(mdDir, name), join(mdDir, 'images', name), join(CONTENT, name)];
  for (const t of tries) {
    try {
      if (statSync(t).isFile()) {
        res = t;
        break;
      }
    } catch {
      /* 下一个 */
    }
  }
  if (!res) res = fileIndex().get(name) ?? null;
  RESOLVE_CACHE.set(key, res);
  return res;
}

function collectImageJobs(entries: Entry[]): void {
  for (const e of entries) {
    for (const m of e.body.matchAll(RE_IMG)) {
      const src = cleanSrc(m[2]);
      if (/^(https?:|data:|mailto:)/i.test(src)) continue;
      const abs = resolveImagePath(src, e.dir);
      if (!abs) {
        IMG_MISSING.push({ src, from: e.relPath });
        continue;
      }
      if (!IMG_JOBS.has(abs)) IMG_JOBS.set(abs, { abs });
    }
    for (const w of e.body.matchAll(RE_WIKI)) {
      const name = w[1].trim();
      const abs = resolveWikiImage(name, e.dir);
      if (!abs) {
        IMG_MISSING.push({ src: name, from: e.relPath });
        continue;
      }
      if (!IMG_JOBS.has(abs)) IMG_JOBS.set(abs, { abs });
    }
  }
}

/* ─────────────── 配乐：自托管音频（不转码，按内容哈希复制到 assets/） ─────────────── */

const MUSIC_INFOS = new Map<string, string>();          // 源文件绝对路径 → 站点根相对路径
const MUSIC_JOBS = new Map<string, { abs: string }>();  // 去重后的待复制音频
const MUSIC_KEEP = new Set<string>();                   // 输出文件名（图片清理步骤据此跳过）
const MUSIC_MISSING: { src: string; from: string }[] = [];
const MUSIC_BIG: { name: string; bytes: number }[] = [];
const MUSIC_MAX_BYTES = 8 * 1024 * 1024;                // 超过就提示压缩（仓库 / Pages 都有体积上限）

function collectMusicJobs(entries: Entry[]): void {
  for (const e of entries) {
    if (!e.music) continue;
    const src = e.music.src;
    if (/^https?:/i.test(src)) {
      e.musicRel = src;   // 外链直接引用，不复制（自托管优先，但留条后路）
      continue;
    }
    const abs = resolveLocalPath(src, e.dir, 'music');
    if (!abs) {
      MUSIC_MISSING.push({ src, from: e.relPath });
      continue;
    }
    e.musicAbs = abs;
    if (!MUSIC_JOBS.has(abs)) MUSIC_JOBS.set(abs, { abs });
  }
}

function processAudio(): { n: number; fresh: number; bytes: number } {
  let fresh = 0;
  let bytes = 0;
  if (MUSIC_JOBS.size === 0) return { n: 0, fresh: 0, bytes: 0 };
  mkdirSync(assetsDir, { recursive: true });
  for (const { abs } of MUSIC_JOBS.values()) {
    const buf = readFileSync(abs);
    bytes += buf.length;
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const base = safeName(basename(abs).replace(/\.[^.]+$/, '')) || 'music';
    const ext = ((/\.([^.]+)$/.exec(abs)?.[1] ?? 'mp3') as string).toLowerCase();
    const name = `${base}-${hash}.${ext}`;
    const dst = join(assetsDir, name);
    if (!existsSync(dst)) {
      copyFileSync(abs, dst);
      fresh++;
    }
    MUSIC_KEEP.add(name);
    MUSIC_INFOS.set(abs, `${IMAGES.dir}/${name}`);
    if (buf.length > MUSIC_MAX_BYTES) MUSIC_BIG.push({ name: basename(abs), bytes: buf.length });
  }
  return { n: MUSIC_KEEP.size, fresh, bytes };
}

/* ── 尺寸解析（PNG / JPEG / GIF / WebP 头部，纯 Node，无依赖）── */

function sizeFromBuffer(b: Buffer): { w: number; h: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) };
      }
      const len = b.readUInt16BE(o + 2);
      if (len < 2) return null;
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = b.toString('ascii', 12, 16);
    if (fmt === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (fmt === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

// sips 兜底（HEIC 等格式）；只在需要时调用
function sipsSize(p: string): { w: number; h: number } | null {
  if (!hasCmd('sips')) return null;
  const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', p], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const w = /pixelWidth:\s*(\d+)/.exec(r.stdout || '');
  const h = /pixelHeight:\s*(\d+)/.exec(r.stdout || '');
  if (!w || !h) return null;
  return { w: Number(w[1]), h: Number(h[1]) };
}

function readDims(abs: string, buf: Buffer): { w: number; h: number } | null {
  return sizeFromBuffer(buf) ?? sipsSize(abs);
}

/* ── 压缩工具探测与调用 ── */

function hasCmd(cmd: string): boolean {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && Boolean((r.stdout || '').trim());
}

interface Encoder {
  name: string;
  ext: string;
  run: (src: string, dst: string, dims: { w: number; h: number } | null) => boolean;
}

function runCmd(cmd: string, args: string[]): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 120_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function fitDims(w: number, h: number, maxSide: number): { w: number; h: number; resized: boolean } {
  const m = Math.max(w, h);
  if (m <= maxSide) return { w, h, resized: false };
  const k = maxSide / m;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), resized: true };
}

function magickEncoder(bin: string, ext: 'webp' | 'jpg'): Encoder {
  return {
    name: bin,
    ext,
    run: (src, dst, dims) => {
      const args: string[] = [src, '-strip'];
      if (dims) {
        const f = fitDims(dims.w, dims.h, IMAGES.maxSide);
        if (f.resized) args.push('-resize', `${f.w}x${f.h}`);
      }
      args.push('-quality', String(IMAGES.quality), dst);
      return runCmd(bin, args);
    },
  };
}

function encoders(): Encoder[] {
  const list: Encoder[] = [];
  if (hasCmd('cwebp')) {
    list.push({
      name: 'cwebp',
      ext: 'webp',
      run: (src, dst, dims) => {
        const args = ['-quiet', '-q', String(IMAGES.quality)];
        if (dims) {
          const f = fitDims(dims.w, dims.h, IMAGES.maxSide);
          if (f.resized) args.push('-resize', String(f.w), String(f.h));
        }
        args.push(src, '-o', dst);
        return runCmd('cwebp', args);
      },
    });
  }
  if (hasCmd('magick')) {
    list.push(magickEncoder('magick', 'webp'), magickEncoder('magick', 'jpg'));
  }
  if (hasCmd('convert')) {
    list.push(magickEncoder('convert', 'webp'), magickEncoder('convert', 'jpg'));
  }
  if (hasCmd('sips')) {
    // 注意：sips 的 -Z 会「放大」小图，所以只在确实需要缩小时才带上
    list.push({
      name: 'sips',
      ext: 'jpg',
      run: (src, dst, dims) => {
        const args: string[] = [src];
        if (dims) {
          const f = fitDims(dims.w, dims.h, IMAGES.maxSide);
          if (f.resized) args.push('-Z', String(IMAGES.maxSide));
        }
        args.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(IMAGES.quality), '--out', dst);
        return runCmd('sips', args);
      },
    });
  }
  return list;
}

function validOut(p: string, ext: string): boolean {
  try {
    const b = readFileSync(p);
    if (b.length < 64) return false;
    if (ext === 'webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
    if (ext === 'jpg') return b[0] === 0xff && b[1] === 0xd8;
    return true;
  } catch {
    return false;
  }
}

function safeName(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

interface ImgStat { src: string; out: string; srcBytes: number; outBytes: number; cached: boolean; tool: string; dims: string }

function processImages(): { stats: ImgStat[]; pruned: number; prunedBytes: number; outside: string[] } {
  const stats: ImgStat[] = [];
  const outside: string[] = [];
  if (!IMAGES.enabled || IMG_JOBS.size === 0) {
    return { stats, pruned: 0, prunedBytes: 0, outside };
  }
  mkdirSync(assetsDir, { recursive: true });
  const encs = encoders();
  const referenced = new Set<string>();

  for (const { abs } of IMG_JOBS.values()) {
    const buf = readFileSync(abs);
    const srcBytes = buf.length;
    // 哈希包含配置：改了压缩参数也会生成新文件，旧文件由下面的清理步骤带走
    const hash = createHash('sha1')
      .update(buf)
      .update(`|${IMAGES.maxSide}|${IMAGES.quality}`)
      .digest('hex')
      .slice(0, 8);
    const base = safeName(basename(abs).replace(/\.[^.]+$/, '')) || 'img';
    const ext0 = (/\.([^.]+)$/.exec(abs)?.[1] ?? '').toLowerCase();
    const dims = readDims(abs, buf);
    const fitted = dims ? fitDims(dims.w, dims.h, IMAGES.maxSide) : null;

    // 已经足够小的 jpg / 本身就是 webp / svg / gif：原样复制，不重复压缩
    const copyAsIs =
      !IMAGES.enabled ? true :
      ext0 === 'svg' || ext0 === 'gif' || ext0 === 'webp' ||
      (['jpg', 'jpeg'].includes(ext0) && srcBytes <= 300 * 1024);

    let chosen: { name: string; outBytes: number; cached: boolean; tool: string } | null = null;

    if (copyAsIs) {
      const ext = ext0 === 'jpeg' ? 'jpg' : ext0 || 'png';
      const name = `${base}-${hash}.${ext}`;
      const dst = join(assetsDir, name);
      const cached = existsSync(dst);
      if (!cached) copyFileSync(abs, dst);
      chosen = { name, outBytes: statSync(dst).size, cached, tool: 'copy' };
    } else {
      for (const enc of encs) {
        const name = `${base}-${hash}.${enc.ext}`;
        const dst = join(assetsDir, name);
        if (existsSync(dst) && validOut(dst, enc.ext)) {
          chosen = { name, outBytes: statSync(dst).size, cached: true, tool: enc.name };
          break;
        }
        try {
          if (existsSync(dst)) rmSync(dst);   // 清掉上次的残留文件
        } catch {
          /* 忽略 */
        }
        if (enc.run(abs, dst, dims) && validOut(dst, enc.ext)) {
          const outBytes = statSync(dst).size;
          // 压缩后反而变大（少见：极小的图 / 纯色图）→ 弃用压缩结果，保留原文件
          const webFriendly = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext0);
          if (outBytes >= srcBytes && webFriendly) {
            rmSync(dst);
            break;   // chosen 保持 null → 走下面的原样复制
          }
          chosen = { name, outBytes, cached: false, tool: enc.name };
          break;
        }
        try {
          if (existsSync(dst)) rmSync(dst);
        } catch {
          /* 忽略 */
        }
      }
      if (!chosen) {
        // 一个压缩工具都没有：原样复制（站点仍可用，只是文件大）
        const ext = ext0 || 'png';
        const name = `${base}-${hash}.${ext}`;
        const dst = join(assetsDir, name);
        const cached = existsSync(dst);
        if (!cached) copyFileSync(abs, dst);
        chosen = { name, outBytes: statSync(dst).size, cached, tool: 'copy' };
      }
    }

    referenced.add(chosen.name);
    const outW = fitted ? fitted.w : 0;
    const outH = fitted ? fitted.h : 0;
    IMG_INFOS.set(abs, { rel: `${IMAGES.dir}/${chosen.name}`, w: outW, h: outH });
    stats.push({
      src: basename(abs),
      out: `${IMAGES.dir}/${chosen.name}`,
      srcBytes,
      outBytes: chosen.outBytes,
      cached: chosen.cached,
      tool: chosen.tool,
      dims: dims ? `${dims.w}×${dims.h}${fitted && fitted.resized ? ` → ${fitted.w}×${fitted.h}` : ''}` : '尺寸未知',
    });
    if (!abs.startsWith(CONTENT + sep) && !abs.startsWith(CONTENT)) outside.push(abs);
  }

  // 清理：assets/ 里带我们命名特征（-8位hex）、但这次没被引用的旧文件
  let pruned = 0;
  let prunedBytes = 0;
  const genRe = /^.+-[0-9a-f]{8}\.[a-z0-9]+$/i;
  for (const f of readdirSync(assetsDir)) {
    if (!genRe.test(f) || referenced.has(f) || MUSIC_KEEP.has(f)) continue;
    const p = join(assetsDir, f);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      prunedBytes += st.size;
      rmSync(p);
      pruned++;
    } catch {
      /* 忽略 */
    }
  }
  return { stats, pruned, prunedBytes, outside };
}

function lookupImage(rawSrc: string, mdDir: string): ImgInfo | null {
  if (!IMAGES.enabled) return null;
  const abs = resolveImagePath(rawSrc, mdDir);
  if (!abs) return null;
  return IMG_INFOS.get(abs) ?? null;
}

/* ═══════════════ Markdown → HTML ═══════════════ */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function cpLen(s: string): number {
  return Array.from(s).length;
}
function cpSlice(s: string, a: number, b?: number): string {
  return Array.from(s).slice(a, b).join('');
}

// alt 看起来像文件名/截图默认名时，不作为图注显示
function captionOf(alt: string): string {
  const t = alt.trim();
  if (!t) return '';
  if (/\.(png|jpe?g|webp|gif|heic|heif|bmp|tiff?|svg)$/i.test(t)) return '';
  if (/^(image|img|screenshot|pasted|paste|unbenannt|截图|截屏|屏幕快照|未命名)[\s_\-0-9.:：()（）at]*$/i.test(t)) return '';
  return t;
}

// prefix 是「当前页面 → 站点根」的相对前缀：文章页在 posts/ 里，取 '../'
function imgTagFor(rawSrc: string, alt: string, mdDir: string, prefix = ''): string {
  const src = cleanSrc(rawSrc);
  const info = lookupImage(src, mdDir);
  const url = info ? prefix + info.rel : src;
  const dims = info && info.w > 0 && info.h > 0 ? ` width="${info.w}" height="${info.h}"` : '';
  return `<img src="${escAttr(url)}" alt="${escAttr(alt)}"${dims} loading="lazy" decoding="async">`;
}

function imgTagForWiki(rawName: string, alt: string, mdDir: string, prefix = ''): string {
  const name = rawName.trim();
  const abs = resolveWikiImage(name, mdDir);
  const info = abs ? IMG_INFOS.get(abs) ?? null : null;
  const url = info ? prefix + info.rel : name;
  const dims = info && info.w > 0 && info.h > 0 ? ` width="${info.w}" height="${info.h}"` : '';
  return `<img src="${escAttr(url)}" alt="${escAttr(alt)}"${dims} loading="lazy" decoding="async">`;
}

// 正文里的第一张图（压缩后的输出信息）：分享卡片拿它当 og:image；没有就返回 null
function firstImage(e: Entry): ImgInfo | null {
  for (const m of e.body.matchAll(RE_IMG)) {
    const src = cleanSrc(m[2]);
    if (/^(https?:|data:|mailto:)/i.test(src)) continue;
    const abs = resolveImagePath(src, e.dir);
    const info = abs ? IMG_INFOS.get(abs) : null;
    if (info) return info;
  }
  for (const w of e.body.matchAll(RE_WIKI)) {
    const abs = resolveWikiImage(w[1].trim(), e.dir);
    const info = abs ? IMG_INFOS.get(abs) : null;
    if (info) return info;
  }
  return null;
}

function inline(s: string, mdDir = '', prefix = ''): string {
  const stash: string[] = [];
  const hold = (htmlText: string): string => {
    stash.push(htmlText);
    return `\u0001${stash.length - 1}\u0001`;
  };

  let out = s;
  // 行内代码优先：里面的内容不再解析其它语法
  out = out.replace(/`([^`]+)`/g, (_m, c: string) => hold(`<code>${esc(c)}</code>`));
  // 图片（在链接之前处理，否则 ![..](..) 会被链接规则先吃掉）
  out = out.replace(RE_IMG, (_m, alt: string, src: string) => hold(imgTagFor(src, alt, mdDir, prefix)));
  // Obsidian 式图片 ![[名称]]（| 后非纯数字时当作别名/图注）
  out = out.replace(RE_WIKI, (_m, name: string, alias: string | undefined) =>
    hold(imgTagForWiki(name, alias && !/^\d+(x\d+)?$/.test(alias) ? alias : '', mdDir, prefix)));
  // Obsidian 内链 [[#小节标题]] / [[#小节标题|显示文字]]：锚点 id 要等整篇正文渲染完才知道，先占位
  out = out.replace(
    /\[\[#([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_m, t: string, alias: string | undefined) =>
      `\u0002${encodeURIComponent(t.trim())}\u0001${alias ? alias.trim() : ''}\u0002`,
  );
  // 跨文章内链 [[文章名]] / [[文章名|显示文字]]（`#` 开头的是本篇锚点，上面已处理；图片是 ![[…]]）
  out = out.replace(/\[\[([^\[\]|#]+?)(?:\|([^\[\]]+?))?\]\]/g, (m, name: string, alias?: string) => {
    const slug = POST_LINKS.get(postKey(name.trim()));
    if (!slug) {
      POST_LINK_MISSING.push(name.trim());
      return m;
    }
    return hold(`<a href="${prefix}posts/${escAttr(slug)}.html">${esc((alias ?? name).trim())}</a>`);
  });
  // 链接 [文字](https://…)
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, t: string, u: string) => hold(`<a href="${escAttr(u)}" target="_blank" rel="noopener">${esc(t)}</a>`),
  );
  // <https://…> 尖括号形式
  out = out.replace(/<(https?:\/\/[^\s>]+)>/g, '$1');
  // 裸链接
  out = out.replace(/(?<![\p{L}\p{N}_"=])(https?:\/\/[^\s，。；）)】」]+)/gu, (_m, u: string) => {
    let shown = u;
    if (cpLen(shown) > 62) shown = cpSlice(shown, 0, 59) + '…';
    return hold(`<a href="${escAttr(u)}" target="_blank" rel="noopener">${esc(shown)}</a>`);
  });
  out = esc(out);
  // 粗体 / 斜体
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  // 高亮 ==文本== 与删除线 ~~文本~~（Obsidian 语法）
  out = out.replace(/==([^=]+)==/g, '<mark>$1</mark>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.split('\\*').join('*').split('\\_').join('_');
  return out.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => stash[Number(i)]);
}

function isBlockStart(l: string): boolean {
  return (
    /^#{1,4}\s/.test(l) ||
    /^```/.test(l) ||
    /^\s*>/.test(l) ||
    /^\s*([-*+]|\d+[.、)])\s+/.test(l) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)
  );
}

const RE_IMG_ONLY = /^\s*!\[([^\]]*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)\s*$/;
const RE_WIKI_ONLY = /^\s*!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]\s*$/;

function parseImageOnly(line: string): { alt: string; src: string; wiki?: boolean } | null {
  const m = RE_IMG_ONLY.exec(line);
  if (m) return { alt: m[1], src: m[2] };
  const w = RE_WIKI_ONLY.exec(line);
  if (w) return { alt: w[2] && !/^\d+$/.test(w[2]) ? w[2] : '', src: w[1], wiki: true };
  return null;
}

function renderFigure(im: { alt: string; src: string; wiki?: boolean }, mdDir: string, prefix = ''): string {
  const img = im.wiki ? imgTagForWiki(im.src, im.alt, mdDir, prefix) : imgTagFor(im.src, im.alt, mdDir, prefix);
  const cap = captionOf(im.alt);
  return `<figure>${img}${cap ? `<figcaption>${inline(cap, mdDir, prefix)}</figcaption>` : ''}</figure>`;
}

function readList(lines: string[], start: number, mdDir = '', prefix = ''): { html: string; next: number } {
  const items: { indent: number; type: 'ul' | 'ol'; text: string }[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    const m = /^(\s*)([-*+]|\d+[.、)])\s+(.*)$/.exec(l);
    if (m && l.trim()) {
      const pad = m[1].replace(/\t/g, '  ').length;
      items.push({ indent: Math.floor(pad / 2), type: /^\d/.test(m[2]) ? 'ol' : 'ul', text: m[3] });
      i++;
      continue;
    }
    if (items.length && l.trim() && /^\s{2,}/.test(l)) {
      items[items.length - 1].text += ' ' + l.trim();
      i++;
      continue;
    }
    break;
  }
  let html = '';
  const stack: ('ul' | 'ol')[] = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const k = Math.min(it.indent, 4);
    if (idx === 0) {
      while (stack.length < k + 1) {
        html += `<${it.type}>`;
        stack.push(it.type);
      }
    } else {
      const pk = Math.min(items[idx - 1].indent, 4);
      if (k > pk) {
        while (stack.length < k + 1) {
          html += `<${it.type}>`;
          stack.push(it.type);
        }
      } else {
        while (stack.length > k + 1) {
          html += `</li></${stack.pop()}>`;
        }
        html += '</li>';
        while (stack.length < k + 1) {
          html += `<${it.type}>`;
          stack.push(it.type);
        }
      }
    }
    const task = it.type === 'ul' ? /^\[([ xX])\]\s+(.*)$/.exec(it.text) : null;
    if (task) {
      const done = task[1].toLowerCase() === 'x';
      html += `<li class="task${done ? ' done' : ''}"><span class="box"></span><span>${inline(task[2], mdDir, prefix)}</span>`;
    } else {
      html += `<li>${inline(it.text, mdDir, prefix)}`;
    }
  }
  while (stack.length) html += `</li></${stack.pop()}>`;
  return { html, next: i };
}

// Obsidian 提醒块（callout）类型表：type → [配色 kind, 无自定义标题时的默认文案]
const CALLOUTS: Record<string, [string, string]> = {
  note: ['note', '笔记'], abstract: ['summary', '提要'], summary: ['summary', '提要'], tldr: ['summary', '提要'],
  todo: ['note', '待办'], info: ['note', '信息'], example: ['note', '示例'],
  tip: ['tip', '提示'], hint: ['tip', '提示'], important: ['tip', '重要'],
  success: ['tip', '成功'], check: ['tip', '完成'], done: ['tip', '完成'],
  question: ['question', '问题'], help: ['question', '帮助'], faq: ['question', '常见问题'],
  warning: ['warning', '警告'], caution: ['warning', '注意'], attention: ['warning', '注意'],
  failure: ['danger', '失败'], fail: ['danger', '失败'], missing: ['danger', '缺失'],
  danger: ['danger', '危险'], error: ['danger', '错误'], bug: ['danger', '缺陷'],
  quote: ['quote', '引用'], cite: ['quote', '引用'],
};

// 开头提要里的 [[#小节标题]] 内链：正文渲染完才知道每节最终拿到哪个锚点（h-1、h-2…），所以收尾统一替换
const WIKI_PLACEHOLDER = /\u0002([^\u0001\u0002]*)\u0001([^\u0002]*)\u0002/g;
const WIKI_MISSING: { label: string; target: string }[] = [];

// 跨文章内链 [[文章名]] / [[文章名|显示文字]]：构建时解析成站内文章页。
// 键做过归一化（去空白 / 统一引号 / 忽略大小写），标题、文件名（可省日期前缀）、slug 都能对上。
const POST_LINKS = new Map<string, string>();
const POST_LINK_MISSING: string[] = [];
function postKey(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, '').replace(/[‘’“”"']/g, '"').toLowerCase();
}

function resolveWikiLinks(html: string, label: string): string {
  const ids = new Map<string, string>();
  const hre = /<h([1-6]) id="(h-\d+)">([\s\S]*?)<\/h\1>/g;
  let m = hre.exec(html);
  while (m) {
    ids.set(normHead(stripTags(m[3])), m[2]);
    m = hre.exec(html);
  }
  return html.replace(WIKI_PLACEHOLDER, (_s, enc: string, alias: string) => {
    const target = decodeURIComponent(enc).trim();
    const id = ids.get(normHead(target));
    if (!id) {
      WIKI_MISSING.push({ label, target });
      return alias || esc(target);
    }
    return `<a href="#${id}">${alias || esc(target)}</a>`;
  });
}

// 标题比对用的归一化：忽略空白和引号样式（正文写“上一次”、提要写成 "上一次" 也要能对上）
function normHead(s: string): string {
  return s.replace(/\s+/g, '').replace(/[‘’“”"']/g, '"');
}

function mdToHtml(md: string, mdDir: string, prefix = '', wikiLabel = ''): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let hIdx = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) {
      i++;
      continue;
    }
    // 围栏代码块
    let m = /^```(\w*)\s*$/.exec(ln);
    if (m) {
      const lang = m[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre class="code"><code${lang ? ` class="lang-${lang}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // 标题：# → h3，## → h4，### → h5，#### → h6（带 #h-N 锚点，供文章目录联动）
    m = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (m) {
      const lvl = Math.min(m[1].length + 2, 6);
      out.push(`<h${lvl} id="h-${++hIdx}">${inline(m[2].trim(), mdDir, prefix)}</h${lvl}>`);
      i++;
      continue;
    }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // 引用
    if (/^\s*>\s?/.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      // 折叠记号在方括号外（> [!summary]-），也兼容写在里面（> [!summary-]）的写法
      const cm = /^\s*\[!([A-Za-z]+)([+-]?)\]([+-]?)\s*(.*)$/.exec(buf[0] ?? '');
      const cbody = buf.slice(cm ? 1 : 0).filter((t) => t.trim() !== '');
      if (cm) {
        // 尾部 + / - 是 Obsidian 的折叠记号（+ 展开、- 收起），提要默认收起
        const fold = cm[2] || cm[3];
        const type = cm[1].toLowerCase();
        const [kind, label] = CALLOUTS[type] ?? ['note', type];
        const title = cm[4].trim();
        if (kind === 'summary') {
          out.push(
            `<details class="co co-summary"${fold === '+' ? ' open' : ''}>` +
              `<summary class="co-t">${inline(title || label, mdDir, prefix)}</summary>` +
              cbody.map((t) => `<p>${inline(t, mdDir, prefix)}</p>`).join('') +
              `</details>`,
          );
          continue;
        }
        out.push(
          `<div class="co co-${kind}">` +
            `<div class="co-t">${inline(title || label, mdDir, prefix)}</div>` +
            cbody.map((t) => `<p>${inline(t, mdDir, prefix)}</p>`).join('') +
            `</div>`,
        );
      } else {
        out.push(
          `<blockquote>${cbody.map((t) => `<p>${inline(t, mdDir, prefix)}</p>`).join('')}</blockquote>`,
        );
      }
      continue;
    }
    // 列表
    if (/^\s*([-*+]|\d+[.、)])\s+/.test(ln)) {
      const res = readList(lines, i, mdDir, prefix);
      out.push(res.html);
      i = res.next;
      continue;
    }
    // 段落（也可能是一张或多张独立成段的图片）
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    // 独立成行的图片（标准 ![]() 或 Obsidian ![[]]）渲染成 figure，其余文字并成段落
    let para: string[] = [];
    const flushPara = (): void => {
      if (para.length) {
        out.push(`<p>${para.map((l) => inline(l.trim(), mdDir, prefix)).join('\n')}</p>`);
        para = [];
      }
    };
    for (const l of buf) {
      const im = parseImageOnly(l);
      if (im) {
        flushPara();
        out.push(renderFigure(im, mdDir, prefix));
      } else {
        para.push(l);
      }
    }
    flushPara();
  }
  return resolveWikiLinks(out.join('\n'), wikiLabel);
}

/* ═══════════════ 样式与脚本 ═══════════════ */

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#ffffff;--bg-alt:#f6f6f7;--bg-elv:#ffffff;--bg-mute:#f1f1f2;
  --divider:#e2e2e3;
  --t1:rgba(60,60,67,1);--t2:rgba(60,60,67,.78);--t3:rgba(60,60,67,.56);
  --ink:#1e2029;
  --brand-1:#3451b2;--brand-2:#3a5ccc;--brand-soft:rgba(100,108,255,.12);
  --mk:var(--brand-1);--mk-soft:var(--brand-soft);
  --green-1:#18794e;--green-soft:rgba(16,185,129,.13);
  --yellow-1:#915930;--yellow-soft:rgba(234,179,8,.15);
  --red-1:#b8272c;--red-soft:rgba(244,63,94,.12);
  --gray-1:#565a5f;--gray-soft:rgba(142,150,170,.15);
  --mark:rgba(234,179,8,.34);
  --ui-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  --font:var(--ui-font);
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --bar:56px;--side:clamp(230px,16vw,330px);
}
[data-theme=dark]{
  --bg:#1b1b1f;--bg-alt:#161618;--bg-elv:#202127;--bg-mute:#2b2b2f;
  --divider:#2e2e32;
  --t1:rgba(255,255,245,.88);--t2:rgba(235,235,245,.62);--t3:rgba(235,235,245,.4);
  --ink:rgba(255,255,255,.95);
  --brand-1:#a8b1ff;--brand-2:#c3c9ff;--brand-soft:rgba(100,108,255,.18);
  --green-1:#3dd68c;--green-soft:rgba(16,185,129,.16);
  --yellow-1:#f9b44e;--yellow-soft:rgba(234,179,8,.16);
  --red-1:#f66f81;--red-soft:rgba(244,63,94,.16);
  --gray-1:#a4a8ae;--gray-soft:rgba(142,150,170,.16);
  --mark:rgba(234,179,8,.3);
}

/* ── 阅读外观：底色 / 字体（全局，存在 localStorage，换页也生效）
      底色只调中性面（背景与分隔线），不碰品牌色，保证「素雅」基调不变。── */
/* 字体全部用系统已装字体，不下载字体文件。默认「黑体」（苹方 / SF / Segoe / 思源黑体）：
   屏幕长文最耐读，且拉丁与数字是等高（lining）字形，不会忽高忽低。
   宋体档给「纸书感」，拉丁另配衬线族（Source Serif / Times），同样等高。 */
html[data-font=serif]{--font:"Source Serif 4","Source Serif Pro","Times New Roman",Times,"Source Han Serif SC","Noto Serif CJK SC","Songti SC",STSong,"Noto Serif SC",SimSun,serif}
html[data-font=kai]{--font:"LXGW WenKai","LXGW WenKai Screen","Kaiti SC",STKaiti,"TW-Kai",KaiTi,"Noto Serif CJK SC",serif}
html[data-font=fangsong]{--font:"FangSong","STFangsong","FangSong_GB2312","Noto Serif CJK SC",serif}
html[data-font=yuan]{--font:"Yuanti SC",YouYuan,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
html[data-font=serif] .body,html[data-font=kai] .body,html[data-font=fangsong] .body{line-height:1.85}
html[data-font=kai] .body{letter-spacing:.015em}
html[data-theme=light][data-paper=cream]{--bg:#faf7f0;--bg-alt:#f4efe3;--bg-elv:#fffdf9;--bg-mute:#f1ead9;--divider:#e7e0d0}
html[data-theme=light][data-paper=green]{--bg:#f6f9f4;--bg-alt:#eef3ea;--bg-elv:#fcfdfb;--bg-mute:#eaf0e4;--divider:#dee6d7}
html[data-theme=light][data-paper=blue]{--bg:#f5f7fa;--bg-alt:#eef1f6;--bg-elv:#fcfdfe;--bg-mute:#e9eef5;--divider:#dce2eb}
html[data-theme=dark][data-paper=cream]{--bg:#1d1b17;--bg-alt:#191713;--bg-elv:#242119;--bg-mute:#2e2a22;--divider:#332f26}
html[data-theme=dark][data-paper=green]{--bg:#181d19;--bg-alt:#141814;--bg-elv:#1f2420;--bg-mute:#2a302a;--divider:#2b332c}
html[data-theme=dark][data-paper=blue]{--bg:#181b21;--bg-alt:#14161b;--bg-elv:#1e2229;--bg-mute:#272c34;--divider:#2a3038}

/* ── 文章语气（data-tone 挂在 <body>）：同一套排版骨架，只换结构标记的冷暖与呼吸，正文字号 / 行高 / 段距不变，
      所以换语气不影响阅读节奏。散文（那座山）走温润茶褐，交易 / 系统文沿用品牌蓝。改这两行就能调冷暖。 ── */
body[data-tone=prose]{--mk:#8b6a4a;--mk-soft:rgba(139,106,74,.10)}
[data-theme=dark] body[data-tone=prose]{--mk:#d0aa80;--mk-soft:rgba(208,170,128,.14)}
body[data-tone=prose] .article h1{font-weight:500;letter-spacing:.01em}
/* 标题下的短记号：散文的「落款感」，比换整块底色克制得多 */
body[data-tone=prose] .article h1::after{content:"";display:block;width:34px;height:2px;border-radius:2px;
  margin:14px 0 0;background:var(--mk);opacity:.55}
/* 章节前后多留一点气口，长散文才有翻页的呼吸感 */
body[data-tone=prose] .body h3{margin-top:58px}
body[data-tone=prose] .body h4{margin-top:42px}

html{scroll-behavior:smooth;scroll-padding-top:calc(var(--bar) + 14px);overflow-y:scroll}
/* 打开文章 / 后退：支持的浏览器整页平滑过渡（不支持则照常瞬时切换，无副作用） */
@view-transition{navigation:auto}
body{margin:0;background-color:var(--bg);color:var(--t1);font:15px/1.75 var(--ui-font);
  -webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%}
a{color:var(--brand-1);text-decoration:none}
a:hover{color:var(--brand-2);text-decoration:underline;text-underline-offset:2px}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
strong{font-weight:600;color:var(--t1)}

/* ── 顶栏（首页与文章页共用）── */
.bar{position:sticky;top:0;z-index:30;display:flex;flex-wrap:wrap;align-items:center;gap:10px;
  padding:0 18px;min-height:56px;background:var(--bg);border-bottom:1px solid var(--divider)}
.bar h1,.bar .brand{font-size:15px;font-weight:600;margin:0;white-space:nowrap;min-width:0}
.bar h1 small,.bar .brand small{font-weight:400;font-size:12px;color:var(--t3);margin-left:8px}
.back{font-size:13px;color:var(--t2);white-space:nowrap}
.back:hover{color:var(--brand-1);text-decoration:none}
.spacer{flex:1}
.search{position:relative;width:260px;max-width:42vw}
.search input{width:100%;height:34px;padding:0 30px 0 32px;border-radius:8px;border:1px solid var(--divider);
  background:var(--bg-alt);color:var(--t1);font:inherit;font-size:13px}
.search input:focus{outline:0;border-color:var(--brand-1);background:var(--bg-elv)}
.search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:15px;height:15px;
  fill:none;stroke:var(--t3);stroke-width:2;pointer-events:none}
.search kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);font:500 10px/1 var(--ui-font);
  color:var(--t3);border:1px solid var(--divider);border-radius:4px;padding:2px 4px;background:var(--bg-elv)}
.btn{height:30px;padding:0 11px;border-radius:999px;border:1px solid var(--divider);background:var(--bg-elv);
  color:var(--t2);font:500 12px/1 var(--ui-font);cursor:pointer;transition:border-color .18s,color .18s,background-color .18s;white-space:nowrap}
.btn:hover{border-color:var(--brand-2);color:var(--t1)}
.btn[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand-1);color:var(--brand-1)}
/* 顶栏筛选按钮：宽屏隐藏（导航在左侧栏），≤1080 侧栏消失时才显示 */
.fsecs{display:none}
.count{font-size:12px;color:var(--t3);white-space:nowrap;font-variant-numeric:tabular-nums}
.jump{display:none;height:30px;max-width:38vw;padding:0 6px;border-radius:8px;border:1px solid var(--divider);
  background:var(--bg-elv);color:var(--t2);font:500 12px/1 var(--ui-font)}

/* ── 外观面板（底色 / 字体）：沿用侧栏标签下拉那套自绘控件语言，不用原生 select ── */
.look{position:relative}
/* 面板宽度取 max-content：否则绝对定位 + right:0 会以触发按钮为基准收缩，
   收缩到只剩按钮宽 → 每行按钮被迫竖排。 */
.look-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:60;display:none;padding:10px 12px;
  width:max-content;background:var(--bg-elv);border:1px solid var(--divider);border-radius:10px;
  box-shadow:0 8px 26px rgba(0,0,0,.12);max-width:calc(100vw - 24px)}
.look[data-open="1"] .look-panel{display:block}
.look-row{display:flex;align-items:center;gap:10px;margin:0 0 9px}
.look-row:last-child{margin-bottom:0}
.look-k{flex:none;width:26px;font-size:12px;color:var(--t3)}
.look-os{display:flex;flex-wrap:wrap;gap:6px}
.look-o{padding:4px 10px;border-radius:999px;border:1px solid var(--divider);background:var(--bg-alt);
  color:var(--t2);font:400 12px/1.5 var(--ui-font);cursor:pointer;
  transition:border-color .15s,color .15s,background-color .15s}
.look-o:hover{border-color:var(--brand-2);color:var(--t1)}
.look-o[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand-1);color:var(--brand-1)}

main{flex:1;min-width:0;padding:26px 40px 140px;max-width:940px}
body>main{margin-left:auto;margin-right:auto}

/* ── 首页：左侧栏（置顶 / 栏目 / 标签下拉；可收起（按钮记忆状态），窄屏自动隐藏）── */
.side{position:sticky;top:var(--bar);flex:none;width:var(--side);height:calc(100vh - var(--bar));
  overflow-y:auto;padding:18px 14px 80px 18px;background:var(--bg-alt);border-right:1px solid var(--divider)}
[data-side="0"] .side,[data-side="0"] .toc{display:none}
#side-toggle{display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:0 8px;font-size:14px}
.sblock{padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--divider)}
.sblock:last-child{padding-bottom:0;margin-bottom:0;border-bottom:0}
.side .gt{font-size:13px;font-weight:600;margin:0 0 6px;color:var(--t1);
  display:flex;justify-content:space-between;align-items:baseline}
.side .gt small{font-weight:400;font-size:11px;color:var(--t3);font-variant-numeric:tabular-nums}
.scat,.sitem{display:flex;align-items:center;gap:7px;width:100%;padding:4px 6px;border:0;border-radius:6px;
  background:none;font:inherit;font-size:12.5px;line-height:1.5;color:var(--t2);text-align:left;
  cursor:pointer;transition:background-color .15s,color .15s;overflow-wrap:anywhere}
.scat:hover,.sitem:hover{background:var(--bg-elv);color:var(--t1);text-decoration:none}
.scat[aria-pressed=true]{background:var(--brand-soft);color:var(--brand-1)}
/* 标签筛选：自绘下拉（触发按钮 + 内嵌面板，与侧栏同一套设计语言） */
.tagsd{position:relative}
.tagsd-btn{display:flex;align-items:center;gap:7px;width:100%;height:30px;padding:0 10px;border-radius:8px;
  border:1px solid var(--divider);background:var(--bg-elv);color:var(--t2);
  font:500 12.5px/1 var(--ui-font);cursor:pointer;text-align:left;transition:border-color .18s,color .18s}
.tagsd-btn:hover{border-color:var(--brand-2);color:var(--t1)}
.tagsd-btn:focus-visible{outline:2px solid var(--brand-soft);outline-offset:1px}
.tagsd[data-open="1"] .tagsd-btn{border-color:var(--brand-1);color:var(--t1)}
.tagsd-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tagsd-btn .caret{margin-left:auto;flex:none;width:11px;height:11px;fill:none;stroke:var(--t3);
  stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform .18s}
.tagsd[data-open="1"] .caret{transform:rotate(180deg)}
.tagsd-panel{display:none;margin-top:6px;padding:4px;border:1px solid var(--divider);border-radius:10px;
  background:var(--bg-elv);box-shadow:0 4px 16px rgba(0,0,0,.06);max-height:232px;overflow:auto}
.tagsd[data-open="1"] .tagsd-panel{display:block;animation:tagsdIn .14s ease-out}
@keyframes tagsdIn{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.tagsd-opt{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;border:0;border-radius:6px;
  background:none;font:inherit;font-size:12.5px;line-height:1.5;color:var(--t2);cursor:pointer;text-align:left;overflow-wrap:anywhere}
.tagsd-opt:hover{background:var(--bg-alt);color:var(--t1)}
.tagsd-opt.on{background:var(--brand-soft);color:var(--brand-1)}
.tagsd-opt i{margin-left:auto;flex:none;font-style:normal;color:var(--t3);font-size:11px;font-variant-numeric:tabular-nums}
.tagsd-opt.on i{color:var(--brand-1)}
.scat i,.sitem i{font-style:normal;color:var(--t3);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:11px}
.scat span,.sitem span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 首页：栏目标题栏（与原书 .sec-h 同款：22px 标题 + 2px 分隔线）── */
.sec-h{display:flex;align-items:baseline;gap:12px;padding-bottom:10px;
  border-bottom:2px solid var(--divider);margin:4px 0 2px}
.sec-h h2{font-size:22px;font-weight:600;margin:0;letter-spacing:-.2px}
.sec-h .meta{margin-left:auto;font-size:12px;color:var(--t3);font-variant-numeric:tabular-nums}

/* ── 首页：文章列表（简洁条目：标题 / 一行摘要 / 一行元信息）── */
.list{list-style:none;margin:0;padding:0}
.item{padding:15px 2px 14px;border-bottom:1px solid var(--divider)}
.item:last-child{border-bottom:0}
.item.cut{display:none}
#more{display:block;margin:20px auto 6px;height:34px;padding:0 18px;font-size:12.5px}
.ititle{display:block;font-family:var(--font);font-size:16px;font-weight:600;line-height:1.5;color:var(--t1);
  letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ititle:hover{color:var(--brand-1);text-decoration:none}
.pin-badge{display:inline-block;margin-right:7px;padding:4px 9px;border-radius:999px;
  background:var(--bg-mute);color:var(--t3);font:400 11px/1 var(--ui-font);vertical-align:2px}
.iex{margin:5px 0 0;font-family:var(--font);font-size:13.5px;line-height:1.7;color:var(--t2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.imeta{margin-top:7px;font-size:12px;color:var(--t3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.imeta .tag{margin-right:3px;vertical-align:1px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.tag{font:400 11px/1 var(--ui-font);padding:4px 9px;border-radius:999px;background:var(--bg-mute);color:var(--t3)}
.badge{font:500 11px/1 var(--ui-font);padding:4px 9px;border-radius:999px;border:1px solid transparent}
.gA{background:var(--green-soft);color:var(--green-1);border-color:var(--green-soft)}
.gB{background:var(--yellow-soft);color:var(--yellow-1);border-color:var(--yellow-soft)}
.gC{background:var(--gray-soft);color:var(--gray-1);border-color:var(--gray-soft)}
.r0{background:var(--brand-soft);color:var(--brand-1);border-color:var(--brand-soft)}
.r1{background:var(--green-soft);color:var(--green-1);border-color:var(--green-soft)}
.r2{background:var(--gray-soft);color:var(--gray-1);border-color:var(--gray-soft)}

/* ── 配乐：折叠状态只是一个安静的小药丸（不点不产生任何请求）；展开是一条极简播放条。
      配色只借结构色 --mk（散文篇自动变茶褐），其余走中性面，和全站素雅基调一致。 ── */
.pl{margin:14px 0 0}
/* 药丸本身分两半：左边一颗播放键（不用展开就能听），右边点开才是完整播放条 */
.pl-head{display:inline-flex;align-items:center;height:30px;border:1px solid var(--divider);border-radius:999px;
  background:var(--bg-elv);transition:border-color .18s}
.pl-head:hover,.pl[data-open="1"] .pl-head,.pl.is-playing .pl-head{border-color:var(--mk)}
.pl-mini{flex:none;width:30px;height:30px;padding:0;border:0;background:transparent;color:var(--mk);
  display:flex;align-items:center;justify-content:center;cursor:pointer}
.pl-mini svg{width:12px;height:12px;fill:currentColor;display:block}
.pl-mini .i-pause,.pl.is-playing .pl-mini .i-play{display:none}
.pl.is-playing .pl-mini .i-pause{display:block}
.pl-btn{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px 0 3px;border:0;
  background:transparent;color:var(--t2);font:500 12px/1 var(--ui-font);cursor:pointer;transition:color .18s}
.pl-btn:hover{color:var(--t1)}
.pl[data-open="1"] .pl-btn{color:var(--mk)}
.pl-name{max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-chev{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;
  border-top:5px solid currentColor;opacity:.7;transition:transform .22s}
.pl[data-open="1"] .pl-chev{transform:rotate(180deg)}
/* 展开：grid-template-rows 0fr→1fr 能按内容真实高度过渡，不用写死 max-height */
.pl-panel{display:grid;grid-template-rows:0fr;transition:grid-template-rows .26s cubic-bezier(.33,1,.68,1)}
.pl[data-open="1"] .pl-panel{grid-template-rows:1fr}
.pl-inner{overflow:hidden;min-height:0;opacity:0;transition:opacity .2s}
.pl[data-open="1"] .pl-inner{opacity:1}
.pl-card{display:flex;align-items:center;gap:11px;margin:10px 0 2px;padding:8px 12px;border-radius:10px;
  border:1px solid var(--divider);background:var(--bg-alt)}
.pl-play{flex:none;width:30px;height:30px;padding:0;border-radius:50%;border:1px solid var(--divider);
  background:var(--bg-elv);color:var(--mk);display:flex;align-items:center;justify-content:center;cursor:pointer;
  transition:border-color .18s,background-color .18s}
.pl-play:hover{border-color:var(--mk)}
.pl-play svg{width:15px;height:15px;fill:currentColor;display:block}
.pl-play .i-pause,.pl.is-playing .pl-play .i-play{display:none}
.pl.is-playing .pl-play .i-pause{display:block}
.pl-track{flex:1;min-width:0}
.pl-title{font-size:12.5px;color:var(--t1);margin:0 0 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-bar{position:relative;display:block;width:100%;height:12px;padding:0;border:0;background:none;cursor:pointer}
.pl-bar::before{content:"";position:absolute;left:0;right:0;top:5px;height:2px;border-radius:2px;background:var(--divider)}
.pl-fill{position:absolute;left:0;top:5px;width:0;height:2px;border-radius:2px;background:var(--mk)}
.pl-time{flex:none;font-size:11px;color:var(--t3);font-variant-numeric:tabular-nums}
/* 没有 JS（或脚本被拦）时退回原生 <audio>，保证配乐仍能播放 */
html.js .pl audio{display:none}
html:not(.js) .pl-head,html:not(.js) .pl-card,html:not(.js) .pf{display:none}
html:not(.js) .pl-panel{grid-template-rows:1fr}
html:not(.js) .pl-inner{opacity:1}
html:not(.js) .pl audio{display:block;width:100%;margin:10px 0 2px}
/* 右下角常驻小圆钮：滚动离开播放条后才淡入，进度用一圈细环表示 */
.pf{position:fixed;right:16px;bottom:70px;z-index:39;width:44px;height:44px;padding:0;border:0;border-radius:50%;
  background:var(--bg-elv);color:var(--mk);cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.16);
  display:flex;align-items:center;justify-content:center;
  opacity:0;transform:translateY(8px) scale(.9);pointer-events:none;transition:opacity .22s,transform .22s}
.pf.show{opacity:1;transform:none;pointer-events:auto}
.pf:hover{color:var(--mk)}
.pf-ring{position:absolute;inset:0;width:100%;height:100%;transform:rotate(-90deg)}
.pf-ring circle{fill:none;stroke-width:2}
.pf-ring-bg{stroke:var(--divider)}
.pf-ring-fg{stroke:var(--mk);stroke-linecap:round;stroke-dasharray:100.53;stroke-dashoffset:100.53;
  transition:stroke-dashoffset .3s linear}
.pf-ico{position:relative;width:17px;height:17px}
.pf-ico svg{position:absolute;inset:0;width:100%;height:100%;fill:currentColor}
.pf-ico .i-pause,.pf.is-playing .pf-ico .i-play{display:none}
.pf.is-playing .pf-ico .i-pause{display:block}
/* 播放时向外荡开一圈很淡的水纹：只有 transform + opacity，走合成层，不触发重排重绘 */
.pf::after{content:"";position:absolute;inset:-1px;border-radius:50%;border:1.5px solid var(--mk);
  opacity:0;pointer-events:none}
.pf.show.is-playing::after{animation:pfRipple 2.6s cubic-bezier(.25,.6,.35,1) infinite}
@keyframes pfRipple{
  0%{transform:scale(1);opacity:.32}
  70%{opacity:.05}
  100%{transform:scale(1.6);opacity:0}
}
@media (prefers-reduced-motion:reduce){
  .pl-panel,.pl-inner,.pl-chev,.pf,.pf-ring-fg{transition:none}
  .pf.show.is-playing::after{animation:none}
}

/* ── 文章页（宽屏：左侧目录 + 正文，沿用原书的目录联动；窄屏目录收进顶栏下拉）── */
.shell{display:flex;align-items:flex-start}
[data-side="0"] .shell{justify-content:center}
.toc{position:sticky;top:var(--bar);flex:none;width:var(--side);height:calc(100vh - var(--bar));
  overflow-y:auto;padding:18px 14px 80px 18px;background:var(--bg-alt);border-right:1px solid var(--divider)}
.toc .gt{font-size:13px;font-weight:600;margin:0 0 6px;color:var(--t1);display:flex;justify-content:space-between;align-items:baseline}
.toc .gt small{font-weight:400;font-size:11px;color:var(--t3)}
.toc a{display:flex;gap:6px;align-items:baseline;padding:3px 6px;border-radius:6px;font-size:12.5px;
  line-height:1.5;color:var(--t2);transition:background-color .15s,color .15s}
.toc a.lv1{font-weight:600;color:var(--t1)}
.toc a.lv1 i{color:var(--mk)}
.toc a.lv2{padding-left:20px}
.toc a.lv3{padding-left:34px}
.toc a.lv4{padding-left:46px}
.toc a:hover{background:var(--bg-elv);color:var(--t1);text-decoration:none}
.toc a.active{background:var(--mk-soft);color:var(--mk)}
.toc a i{font-style:normal;color:var(--t3);font-variant-numeric:tabular-nums;flex:none;min-width:16px;text-align:right}
.shell>.article,.shell>main{flex:1;min-width:0}
.article{max-width:760px}
.article h1{font-family:var(--font);font-size:26px;font-weight:600;line-height:1.45;margin:2px 0 10px;letter-spacing:-.2px;
  color:var(--ink);overflow-wrap:anywhere}
.article .chips{margin:12px 0 22px}
.pager{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;margin:36px 0 0;
  border-top:1px solid var(--divider);padding-top:16px}
.pager a{display:flex;flex-direction:column;gap:3px;max-width:48%;font-size:14px;line-height:1.5;color:var(--t1)}
.pager a:hover{color:var(--brand-1);text-decoration:none}
.pager a small{font-size:11.5px;color:var(--t3)}
.pager a span{font-weight:500;overflow-wrap:anywhere}
.pager .older{margin-left:auto;text-align:right}

/* ── 书页模式：正文走 CSS 分栏，翻页只做一次 transform（不测量文字、不重建 DOM，所以不卡）──
      分栏高度固定后，溢出的内容会自动排到下一栏；整块左移一栏的宽度就是一页。
      窄屏（≤820）分栏读起来难受，下面那段媒体查询里会把它还原成普通滚动。 */
.bookbar{display:none}
html[data-read=book] .article{max-width:none;height:calc(100vh - var(--bar));display:flex;
  flex-direction:column;padding:18px 44px 0;overflow:hidden}
html[data-read=book] .article>.chips{margin:8px 0 14px}
/* 裁剪必须放在没被位移的外层 .bookwrap：裁在 .book 自己身上的话，
   多出来的栏和位移一起移动，翻页后看到的是空白。 */
html[data-read=book] .bookwrap{flex:1;min-height:0;overflow:hidden}
html[data-read=book] .book{height:100%;columns:1;column-gap:56px;column-fill:auto;
  transition:transform .3s cubic-bezier(.22,.61,.36,1)}
html[data-read=book] .book.noanim{transition:none}
html[data-read=book] .body figure,html[data-read=book] .body pre.code,html[data-read=book] .body .co,
html[data-read=book] .body li,html[data-read=book] .pager,html[data-read=book] .book>footer{break-inside:avoid}
html[data-read=book] .body h3,html[data-read=book] .body h4,html[data-read=book] .body h5{break-after:avoid}
/* 书页模式里图片收得比滚动模式小得多：一页只有一栏，图一大正文就没地方了。
   图整块不拆栏（figure 上是 break-inside:avoid），收到 26vh / 240px 后一张图只占一小块，
   剩下的高度还能排进上下文，页尾也不至于空一大片。要看大图点开灯箱即可。 */
html[data-read=book] .body img{max-height:min(26vh,240px);max-width:90%}
html[data-read=book] .book>footer{margin-top:24px}
html[data-read=book] #top{display:none}
html[data-read=book] .bookbar{display:flex;align-items:center;justify-content:center;gap:12px;
  flex:none;height:42px;font-size:12px;color:var(--t3);font-variant-numeric:tabular-nums}
.pgbtn{width:26px;height:26px;border-radius:6px;border:1px solid var(--divider);background:var(--bg-elv);
  color:var(--t2);font:400 15px/1 var(--ui-font);cursor:pointer;transition:border-color .15s,color .15s}
.pgbtn:hover:not(:disabled){border-color:var(--brand-1);color:var(--brand-1)}
.pgbtn:disabled{opacity:.35;cursor:default}
@media (prefers-reduced-motion:reduce){
  html[data-read=book] .book{transition:none}
}

/* ── 写作统计页：全部构建时算好，纯静态、无脚本、无外部服务 ── */
.st-lead{margin:0 0 18px;font-size:14px;line-height:1.8;color:var(--t2)}
.st-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 4px}
.st-card{padding:13px 15px;border:1px solid var(--divider);border-radius:10px;background:var(--bg-alt)}
.st-card b{display:block;font-size:23px;font-weight:650;line-height:1.2;color:var(--ink);
  letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.st-card span{display:block;margin-top:5px;font-size:12px;color:var(--t3)}
.st-bars{display:flex;align-items:flex-end;gap:7px;margin:2px 0 6px;padding:0 2px 2px;
  overflow-x:auto;scrollbar-width:thin}
.st-col{flex:0 0 34px;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px}
.st-col i{display:block;width:100%;max-width:30px;border-radius:4px 4px 0 0;
  background:var(--brand-1);opacity:.42;min-height:3px}
.st-col.now i{opacity:.85}
.st-n{font-size:11px;line-height:1;color:var(--t3);font-variant-numeric:tabular-nums}
.st-col em{font-style:normal;font-size:11px;line-height:1.4;color:var(--t3);white-space:nowrap}
.st-tab{width:100%;border-collapse:collapse;margin:2px 0 6px;font-size:13.5px}
.st-tab th,.st-tab td{padding:8px 10px;border-bottom:1px solid var(--divider);text-align:left}
.st-tab th{font-weight:500;font-size:12px;color:var(--t3)}
.st-tab td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--t2)}
.st-tab tr:last-child td{border-bottom:0}
.st-tags{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 6px}
.st-tag{display:inline-flex;align-items:baseline;gap:7px;padding:6px 11px;border-radius:999px;
  background:var(--bg-mute);color:var(--t2);font-size:12.5px}
.st-tag i{font-style:normal;font-size:11px;color:var(--t3);font-variant-numeric:tabular-nums}
/* 按月回顾：写作统计页里的时间线入口（每篇都是链接），纯静态 */
.st-arch{display:grid;gap:14px;margin:2px 0 6px}
.st-mo-h{display:flex;align-items:baseline;gap:8px;margin:0 0 2px;padding-bottom:5px;
  border-bottom:1px solid var(--divider);font-size:12.5px;font-weight:600;color:var(--t1);
  font-variant-numeric:tabular-nums}
.st-mo-h i{font-style:normal;font-weight:400;font-size:11px;color:var(--t3);margin-left:auto}
.st-mo a{display:flex;align-items:baseline;gap:9px;padding:4px 0;font-size:13.5px;line-height:1.6;color:var(--t1)}
.st-mo a:hover{color:var(--brand-1);text-decoration:none}
.st-mo a em{font-style:normal;flex:none;min-width:26px;font-size:11.5px;color:var(--t3);
  font-variant-numeric:tabular-nums}
@media (max-width:520px){.st-cards{grid-template-columns:repeat(2,1fr)}}

.hidden{display:none!important}
.empty{color:var(--t3);font-size:14px;padding:40px 0;text-align:center}
footer{color:var(--t3);font-size:12px;border-top:1px solid var(--divider);padding-top:14px;
  line-height:1.9;margin-top:40px}
footer a{color:var(--t2)}

#top{position:fixed;right:16px;bottom:16px;z-index:40;width:42px;height:42px;border-radius:50%;
  border:1px solid var(--divider);background:var(--bg-elv);color:var(--t2);cursor:pointer;
  font:400 17px/1 var(--ui-font);box-shadow:0 2px 12px rgba(0,0,0,.14);
  opacity:0;pointer-events:none;transition:opacity .2s,color .18s}
#top.show{opacity:1;pointer-events:auto}
#top:hover{color:var(--brand-1);border-color:var(--brand-1)}

/* ── 正文排版 ── */
.body{margin:0;font-family:var(--font);font-size:15.5px;line-height:1.8;color:var(--t1);overflow-wrap:anywhere;
  font-variant-numeric:lining-nums}
.body p{margin:0 0 10px}
.body p:last-child{margin-bottom:2px}
/* 标题四级：标记形态（横线色块 → 底线色段 → 左竖条 → 前缀方块）与色深同时递进。
   只靠字号+颜色区分会糊成一片，所以四级的「标记跨度」逐级收窄，色阶在同一支品牌蓝上逐级变浅。 */
.body h3,.body h4,.body h5,.body h6{color:var(--ink);font-weight:600;line-height:1.5}
/* #  · 章：顶部通栏细线 + 左端色块（全宽标记，最高层） */
.body h3{font-size:20px;font-weight:650;margin:46px 0 14px;padding-top:15px;letter-spacing:-.3px;
  position:relative;border-top:1px solid var(--divider)}
.body h3::before{content:"";position:absolute;left:0;top:-2px;width:36px;height:3px;border-radius:2px;background:var(--mk)}
/* ## · 节：底部细线 + 左端色段（半宽标记） */
.body h4{font-size:17px;font-weight:640;margin:34px 0 12px;padding-bottom:8px;
  position:relative;border-bottom:1px solid var(--divider)}
.body h4::after{content:"";position:absolute;left:0;bottom:-1px;width:30px;height:2px;border-radius:2px;
  background:var(--mk);opacity:.8}
/* ### · 目：左侧竖条（局部标记） */
.body h5{font-size:16px;margin:26px 0 9px;padding-left:11px;position:relative}
.body h5::before{content:"";position:absolute;left:0;top:.3em;bottom:.3em;width:3px;border-radius:2px;
  background:var(--mk);opacity:.55}
/* #### · 点：前缀方块（最小标记，色最浅）；加粗正文没有方块，仍一眼可辨 */
.body h6{font-size:15px;margin:22px 0 8px;color:var(--t2);font-weight:600;padding-left:16px;position:relative}
.body h6::before{content:"";position:absolute;left:1px;top:.5em;width:7px;height:7px;border-radius:2px;
  background:var(--mk);opacity:.34}
/* 从提要 / 目录点进来的落点：整行中性底 + 一道品牌色左耳，一眼能认出来。
   纯 CSS（:target），不用脚本也不做动画，所以「减弱动态效果」下同样可见。 */
.body h3:target,.body h4:target,.body h5:target,.body h6:target{
  background:var(--bg-alt);border-radius:6px;box-shadow:inset 3px 0 0 var(--mk)}
.body ul,.body ol{margin:0 0 10px;padding-left:22px}
.body li{margin:3px 0}
.body li>ul,.body li>ol{margin-bottom:0;margin-top:3px}
.body blockquote{margin:0 0 10px;padding:9px 13px;background:var(--mk-soft);border-left:3px solid var(--mk);border-radius:0 8px 8px 0;color:var(--t1)}
.body blockquote p{margin:0}
/* 提醒块（Obsidian callout：> [!warning] 标题）*/
.body .co{margin:0 0 12px;padding:9px 13px;border-left:3px solid var(--gray-1);border-radius:0 8px 8px 0;background:var(--gray-soft);color:var(--t1)}
.body .co .co-t{font-size:13px;font-weight:600;margin:0 0 4px}
.body .co p{margin:0 0 5px}
.body .co p:last-child{margin-bottom:0}
/* 开头提要「> [!summary] 提要」：默认收起，点标题行展开（折叠记号用 ▸/▾，与「来源」同一套写法）。
   底色走中性面（与侧栏同色）+ 一道品牌色左耳，整块不铺彩色，跟全站素雅基调一致。 */
.body .co-summary{margin-bottom:14px;padding:10px 15px;background:var(--bg-alt);
  border:1px solid var(--divider);border-left:3px solid var(--brand-1);border-radius:0 8px 8px 0}
.body .co-summary>summary.co-t{display:flex;align-items:center;gap:7px;margin:0;color:var(--t2);
  cursor:pointer;list-style:none;user-select:none;transition:color .15s}
.body .co-summary>summary.co-t::-webkit-details-marker{display:none}
.body .co-summary>summary.co-t::before{content:"▸";flex:none;font-size:10px;line-height:1;color:var(--t3)}
.body .co-summary[open]>summary.co-t::before{content:"▾"}
.body .co-summary>summary.co-t:hover{color:var(--brand-1)}
.body .co-summary>summary.co-t:hover::before{color:var(--brand-1)}
.body .co-summary>summary.co-t:focus-visible{outline:2px solid var(--brand-soft);outline-offset:2px}
.body .co-summary[open]>summary.co-t{margin-bottom:6px}
.body .co-note{border-left-color:var(--brand-1);background:var(--brand-soft)}
.body .co-note .co-t{color:var(--brand-1)}
.body .co-tip{border-left-color:var(--green-1);background:var(--green-soft)}
.body .co-tip .co-t{color:var(--green-1)}
.body .co-warning{border-left-color:var(--yellow-1);background:var(--yellow-soft)}
.body .co-warning .co-t{color:var(--yellow-1)}
.body .co-danger{border-left-color:var(--red-1);background:var(--red-soft)}
.body .co-danger .co-t{color:var(--red-1)}
.body .co-question{border-left-color:var(--gray-1);background:var(--gray-soft)}
.body .co-question .co-t{color:var(--gray-1)}
/* 删除线与任务清单（Obsidian 常用格式）*/
.body del{color:var(--t3)}
.body li.task{list-style:none}
.body li.task .box{display:inline-block;width:12px;height:12px;margin-right:7px;border:1.5px solid var(--t3);border-radius:4px;position:relative;top:2px}
.body li.task.done .box{background:var(--brand-1);border-color:var(--brand-1)}
.body li.task.done .box::after{content:"✓";position:absolute;left:1.5px;top:-2px;font-size:10px;line-height:1;color:#fff}
.body code{font:12.5px/1.6 var(--mono);background:var(--bg-mute);border-radius:4px;padding:1px 5px}
.body pre.code{margin:0 0 10px;padding:10px 13px;background:var(--bg-mute);border:1px solid var(--divider);border-radius:8px;overflow:auto}
.body pre.code code{background:none;padding:0;font-size:12.5px;line-height:1.7}
.body hr{border:0;border-top:1px solid var(--divider);margin:14px 0}
/* 正文图片：宽图不溢出、小图按原尺寸居中、竖长图限高，图注居中 */
.body img{max-width:100%;width:auto;height:auto;max-height:68vh;border:1px solid var(--divider);
  border-radius:10px;background:var(--bg-mute);cursor:zoom-in}
.body p img{display:inline-block;vertical-align:middle;margin:2px 0}
.body figure{margin:0 0 14px;text-align:center}
.body figure img{display:block;margin:0 auto}
.body figcaption{margin:8px auto 0;max-width:52ch;font-size:12.5px;color:var(--t3);line-height:1.65;text-align:center}

/* ── 灯箱：点图全屏，点任意处 / Esc 关闭 ── */
#lb{position:fixed;inset:0;z-index:80;display:none;align-items:center;justify-content:center;background:rgba(8,8,10,.86);cursor:zoom-out}
#lb.open{display:flex}
#lb img{max-width:96vw;max-height:94vh;border-radius:8px;box-shadow:0 10px 44px rgba(0,0,0,.55)}

/* 宽屏（侧栏可见）：工具归右侧（搜索 + 明暗） */
@media (min-width:1081px){
  .search{margin-left:auto;width:clamp(240px,17vw,280px);max-width:none}
  #cnt:not(.hidden){margin-left:12px}
}
@media (max-width:1080px){
  .toc{display:none}
  .side{display:none}
  #side-toggle{display:none}
  .shell{justify-content:center}
  .jump{display:block}
}
@media (max-width:820px){
  .bar{padding:8px 12px;gap:8px;min-height:0}
  /* 手机上顶栏折成多行：① 返回 + 标题 ② 目录跳转 ③ 明暗 + 外观 ④ 筛选 ⑤ 计数 ⑥ 搜索（独占整行，才好打字） */
  .back{order:1}
  .bar h1,.bar .brand{order:2;flex:1 1 120px;font-size:14px;overflow:hidden;text-overflow:ellipsis}
  .spacer{display:none}
  .jump{order:3}
  #theme{order:4}
  .look{order:5}
  .fsecs{display:contents}
  .fsec{order:6}
  .count{order:7;margin-left:auto}
  .search{order:8;width:auto;max-width:none;flex:1 1 100%;margin:2px 0 0}
  .search input{height:34px}
  .search kbd{display:none}
  /* 向下滚动后收成一行（标题+搜索+明暗+外观），把竖向空间还给列表；滚回顶部再展开 */
  body.compact .jump,body.compact .fsec,body.compact .count{display:none}
  body.compact .search{order:3;flex:1 1 120px;margin-top:0}
  body.compact #theme{order:4}
  body.compact .look{order:5}
  /* 书页模式在窄屏还原成普通滚动（分栏在手机上读起来是折磨），开关也一并收起 */
  #mode{display:none}
  html[data-read=book] .article{height:auto;display:block;padding:16px 13px 110px;overflow:visible}
  html[data-read=book] .bookwrap{overflow:visible}
  html[data-read=book] .book{columns:auto;column-fill:balance;height:auto;transform:none!important}
  html[data-read=book] #top{display:block}
  .bookbar{display:none!important}
  main{padding:16px 13px 110px}
  .article h1{font-size:22px}
  .ititle{font-size:15.5px}
  .pager{margin-top:28px}
  .pager a{max-width:100%}
}
@media (max-width:520px){
  .bar h1 small,.bar .brand small{display:none}
  .chips,.body{margin-left:0}
  /* 手机上触发按钮靠右，面板再按 right:0 对齐会顶出左边界；改成贴上栏的通栏浮层 */
  .look-panel{position:fixed;left:12px;right:12px;top:calc(var(--bar) + 8px);width:auto;max-width:none}
}
/* 320-380px 的窄屏：按钮收紧，否则顶栏会被挤到多占一到两行 */
@media (max-width:380px){
  .btn{padding:0 8px;font-size:11px}
  .bar h1,.bar .brand{flex:1 1 90px;font-size:13px}
  .jump{max-width:32vw}
}
/* 超宽屏（≥1900px，约 27" 以上）：正文列稍放宽，右侧留白比重更协调 */
@media (min-width:1900px){
  .article{max-width:840px}
}
@media print{
  .bar,.toc,.side,.jump,#top,#lb,.pl,.pf{display:none}
  main{max-width:none;padding:0}
  .item{break-inside:avoid;border-color:#ccc}
  .body img{max-height:none}
  .pager{display:none}
  body{font-size:11pt}
}
`;

/* ═══════════════ 渲染 ═══════════════ */

/* ═══════════════ 渲染 ═══════════════ */

interface PageRef {
  entry: Entry;
  secIdx: number;
  secLabel: string;
  slug: string;
  outName: string;   // 相对站点根的文章页路径，如 posts/2026-09-26-示例.html
  excerpt: string;   // 列表摘要（粗剥 Markdown 得到的纯文本）
}

// 文件名 stem → slug：空格转 -，只保留字母/数字/中日韩字符与 -_.（中文不做百分号编码）
function slugify(stem: string): string {
  const s = stem
    .normalize('NFC')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s || 'post';
}

// 粗剥 Markdown 语法，得到用于列表摘要的纯文本
function stripMd(md: string): string {
  let t = md;
  t = t.replace(/```[\s\S]*?```/g, ' ');                  // 围栏代码块
  t = t.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ');      // 分隔线
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');            // 图片
  t = t.replace(/!\[\[[^\]]*\]\]/g, ' ');            // Obsidian 式图片
  t = t.replace(/\[\[#?([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, a: string, b?: string) =>
    b ?? a);                                          // Obsidian 式内链（本篇锚点 / 跨文章）：只留显示文字
  t = t.replace(/==([^=]+)==/g, '$1');                    // 高亮
  t = t.replace(/~~([^~]+)~~/g, '$1');                    // 删除线
  t = t.replace(/\[![A-Za-z+-]+\]/g, ' ');                // 提醒块记号
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');          // 链接只留文字
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');               // 标题记号
  t = t.replace(/^\s{0,3}>\s?/gm, '');                    // 引用记号
  t = t.replace(/^\s{0,3}(?:[-*+]|\d+[.、)])\s+/gm, '');  // 列表记号
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1$2');
  t = t.replace(/<https?:\/\/[^>]+>/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, ' ');                  // 裸链接
  return t.replace(/\s+/g, ' ').trim();
}

// 去掉 HTML 标签（文章目录用：标题里可能带链接、行内代码）
function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// 首页列表摘要：默认约 100 字
function excerptOf(md: string, n = 100): string {
  const t = stripMd(md);
  return cpLen(t) <= n ? t : cpSlice(t, 0, n) + '…';
}

// 开头提要：> [!summary] 块的正文（标题行不计），用于「100–300 字」提示
function summaryBody(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*>\s*\[!(summary|abstract|tldr)\]/i.test(lines[i])) continue;
    const buf: string[] = [];
    for (let j = i + 1; j < lines.length && /^\s*>/.test(lines[j]); j++) {
      buf.push(lines[j].replace(/^\s*>\s?/, ''));
    }
    return buf.join('\n');
  }
  return '';
}

/* ── 页面骨架 ── */

const TOP_BTN = `<button id="top" title="回到顶部" aria-label="回到顶部">↑</button>`;
const SIDE_BTN = `<button class="btn" id="side-toggle" title="收起侧栏" aria-label="收起或展开侧栏">«</button>`;

// 外观面板（底色 / 字体）：两页共用，点一下即生效并记进 localStorage
function lookRow(label: string, k: string, opts: string[][]): string {
  return (
    `<div class="look-row"><span class="look-k">${label}</span><div class="look-os">` +
    opts
      .map(([v, t]) => `<button class="look-o" type="button" data-k="${k}" data-v="${v}">${t}</button>`)
      .join('') +
    `</div></div>`
  );
}
const LOOK_BAR =
  `<div class="look" id="look">` +
  `<button class="btn" id="look-btn" type="button" aria-expanded="false" aria-haspopup="true">外观</button>` +
  `<div class="look-panel" id="look-panel">` +
  lookRow('底色', 'paper', [['', '纯白'], ['cream', '米黄'], ['green', '豆绿'], ['blue', '灰蓝']]) +
  lookRow('字体', 'font', [['', '默认'], ['serif', '宋体'], ['kai', '楷体'], ['fangsong', '仿宋'], ['yuan', '圆体']]) +
  `</div></div>`;

// 书页模式的翻页条（只在书页模式下出现，显隐交给 CSS）
const BOOKBAR =
  `<div class="bookbar" id="bookbar">` +
  `<button class="pgbtn" id="pg-prev" type="button" aria-label="上一页">‹</button>` +
  `<span id="pgnum">1 / 1</span>` +
  `<button class="pgbtn" id="pg-next" type="button" aria-label="下一页">›</button></div>`;
const LIGHTBOX = `<div id="lb" role="dialog" aria-modal="true" aria-label="查看大图"><img alt=""></div>`;

/* ── 分享卡片（og / twitter）：链接丢进微信、Telegram、Slack 时有标题、摘要和配图。
      og:image 用文章里的第一张图（绝对地址），没有配图就退回站点默认卡片 —— 静态文件，
      不在页面里加载，所以对首屏零成本。 ── */
interface HeadMeta {
  title?: string;                  // og:title；默认用页面 <title>
  url?: string;                    // 站点根相对路径（'' 表示首页）
  image?: string;                  // 站点根相对路径；缺省用默认卡片
  imageW?: number;
  imageH?: number;
  type?: 'website' | 'article';
  published?: string;
  tags?: string[];
  bodyAttr?: string;               // 直接拼到 <body> 上的属性（文章语气 data-tone 用）
}
const OG_CARD = 'og.png';          // 默认分享图（源文件 static/og.png，构建时复制到站点根）
const OG_CARD_W = 1200;
const OG_CARD_H = 630;

// 站点根相对路径 → 线上绝对地址（没配 SITE.url 时原样返回）
function absUrl(rel: string): string {
  const base = SITE.url.replace(/\/+$/, '');
  const p = String(rel || '').replace(/^\.?\//, '');
  if (!base) return p;
  return p ? `${base}/${p}` : `${base}/`;
}

function pageHead(title: string, desc: string, meta: HeadMeta = {}): string {
  const d = escAttr(desc);
  const ogTitle = escAttr(meta.title || title);
  const url = absUrl(meta.url ?? '');
  const img = absUrl(meta.image || OG_CARD);
  let og =
    `<meta property="og:title" content="${ogTitle}">` +
    `<meta property="og:description" content="${d}">` +
    `<meta property="og:site_name" content="${escAttr(SITE.name)}">` +
    `<meta property="og:type" content="${meta.type || 'website'}">` +
    `<meta property="og:locale" content="zh_CN">` +
    `<meta property="og:url" content="${escAttr(url)}">` +
    `<meta property="og:image" content="${escAttr(img)}">`;
  if (meta.imageW && meta.imageH) {
    og +=
      `<meta property="og:image:width" content="${meta.imageW}">` +
      `<meta property="og:image:height" content="${meta.imageH}">`;
  }
  if (meta.published) og += `<meta property="article:published_time" content="${escAttr(meta.published)}">`;
  for (const t of meta.tags || []) og += `<meta property="article:tag" content="${escAttr(t)}">`;
  og +=
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${ogTitle}">` +
    `<meta name="twitter:description" content="${d}">` +
    `<meta name="twitter:image" content="${escAttr(img)}">`;
  return (
    `<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">` +
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1b1b1f">` +
    `<meta name="description" content="${d}">` +
    `<link rel="canonical" href="${escAttr(url)}">` +
    `<link rel="alternate" type="application/rss+xml" title="${escAttr(SITE.name)}" href="${escAttr(absUrl('feed.xml'))}">` +
    og +
    `<title>${esc(title)}</title><style>${CSS}</style>` +
    // 首帧之前就把记忆里的侧栏 / 明暗 / 外观 / 阅读模式落到 <html> 上，避免闪一下再变
    `<script>try{` +
    `var d=document.documentElement;` +
    `d.classList.add('js');` +
    `if(localStorage.getItem('blog-side')==='0')d.setAttribute('data-side','0');` +
    `['paper','font'].forEach(function(k){` +
    `var v=localStorage.getItem('blog-'+k);if(v)d.setAttribute('data-'+k,v);});` +
    `if(localStorage.getItem('blog-read')==='book')d.setAttribute('data-read','book');` +
    `}catch(e){}</script>` +
    `</head><body${meta.bodyAttr || ''}>`
  );
}


// 元信息行：栏目 + 日期 + 标签（统一原生标签样式）
function chipsRow(p: PageRef): string {
  const sec = `<span class="tag">${esc(p.secLabel)}</span>`;
  const date = p.entry.date ? `<span class="tag">${esc(p.entry.date)}</span>` : '';
  const tags = p.entry.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
  return `<div class="chips">${sec}${date}${tags}</div>`;
}

// 首页条目的元信息行：栏目（原生标签样式）+ 日期 + #标签
function metaText(p: PageRef): string {
  const sec = `<span class="tag">${esc(p.secLabel)}</span>`;
  const bits: string[] = [];
  if (p.entry.date) bits.push(esc(p.entry.date));
  if (p.entry.tags.length) bits.push(p.entry.tags.map((t) => `#${esc(t)}`).join(' '));
  return sec + (bits.length ? ' ' + bits.join(' · ') : '');
}

function renderListItem(p: PageRef): string {
  const pin = p.entry.pinned ? `<span class="pin-badge">置顶</span>` : '';
  const ex = p.excerpt ? `<p class="iex">${esc(p.excerpt)}</p>` : '';
  return (
    `<li class="item" data-sec="${p.secIdx}">` +
    `<a class="ititle" href="${escAttr(p.outName)}">${pin}${esc(p.entry.title)}</a>` +
    ex +
    `<div class="imeta">${metaText(p)}</div>` +
    `</li>`
  );
}

// 文章页：正文用同一套 markdown / 图片渲染器；pages 是按时间倒序的全局列表
function renderPostPage(pages: PageRef[], i: number, footer: string): string {
  const p = pages[i];
  const newer = i > 0 ? pages[i - 1] : null;
  const older = i < pages.length - 1 ? pages[i + 1] : null;
  const pg: string[] = [];
  // 文章页与相邻文章同目录，页间链接用兄弟文件名即可
  if (newer) {
    pg.push(
      `<a class="newer" href="${escAttr(newer.slug)}.html">` +
        `<small>更新的一篇</small><span>${esc(newer.entry.title)}</span></a>`,
    );
  }
  if (older) {
    pg.push(
      `<a class="older" href="${escAttr(older.slug)}.html">` +
        `<small>更早的一篇</small><span>${esc(older.entry.title)}</span></a>`,
    );
  }
  // 正文里的标题会带 #h-N 锚点；小节 ≥2 时：宽屏出左侧目录、窄屏出顶栏跳转下拉
  const bodyHtml = mdToHtml(p.entry.body, p.entry.dir, PAGE_PREFIX, p.entry.title);
  const heads: { id: string; text: string; lvl: number }[] = [];
  const hre = /<h([3-6]) id="(h-\d+)">([\s\S]*?)<\/h\1>/g;
  let hm = hre.exec(bodyHtml);
  while (hm) {
    heads.push({ id: hm[2], text: stripTags(hm[3]), lvl: Number(hm[1]) });
    hm = hre.exec(bodyHtml);
  }
  const hasToc = heads.length >= 2;
  // 目录真实层级：栈式编号（1 / 1.1 / 1.1.1），回退自动重置
  const tstack: { lvl: number; n: number }[] = [];
  const tocItems = heads.map((h) => {
    while (tstack.length && tstack[tstack.length - 1].lvl > h.lvl) tstack.pop();
    if (tstack.length && tstack[tstack.length - 1].lvl === h.lvl) tstack[tstack.length - 1].n++;
    else tstack.push({ lvl: h.lvl, n: 1 });
    return { id: h.id, text: h.text, num: tstack.map((x) => x.n).join('.'), depth: tstack.length - 1 };
  });
  const jump = hasToc
    ? `<select class="jump" id="jump" aria-label="跳转到某一节">` +
      tocItems.map((h) => `<option value="${h.id}">${h.num} ${esc(h.text)}</option>`).join('') +
      `</select>`
    : '';
  const toc = hasToc
    ? `<aside class="toc"><div class="gt">本文目录<small>${heads.length} 节</small></div>` +
      tocItems
        .map(
          (h) =>
            `<a class="lv${Math.min(h.depth + 1, 4)}" href="#${h.id}"><i>${h.num}</i><span>${esc(h.text)}</span></a>`,
        )
        .join('') +
      `</aside>`
    : '';
  const bar =
    `<header class="bar"><a class="back" href="../${escAttr(basename(OUT_FILE))}">← 返回首页</a>` +
    (hasToc ? SIDE_BTN : '') +
    `<div class="brand">${esc(SITE.name)}</div>` +
    jump +
    `<div class="spacer"></div>` +
    `<button class="btn" id="mode" type="button" aria-pressed="false" title="在书页翻页与上下滚动之间切换">书页/滚动</button>` +
    `<button class="btn" id="theme">明/暗</button>` +
    LOOK_BAR +
    `</header>`;
  const tone = SECTION_TONE[p.secLabel];
  const musicSrc = p.entry.musicRel
    ? /^https?:/i.test(p.entry.musicRel) ? p.entry.musicRel : PAGE_PREFIX + p.entry.musicRel
    : '';
  const musicBar =
    p.entry.music && musicSrc
      ? `<div class="pl" id="pl">` +
        `<div class="pl-head">` +
        `<button class="pl-mini" type="button" aria-label="播放配乐">` +
        `<svg viewBox="0 0 24 24" class="i-play" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>` +
        `<svg viewBox="0 0 24 24" class="i-pause" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>` +
        `</button>` +
        `<button class="pl-btn" type="button" aria-expanded="false" aria-controls="plp">` +
        `<span class="pl-name">配乐 · ${esc(p.entry.music.title)}</span>` +
        `<span class="pl-chev" aria-hidden="true"></span></button>` +
        `</div>` +
        `<div class="pl-panel" id="plp"><div class="pl-inner"><div class="pl-card">` +
        `<button class="pl-play" type="button" aria-label="播放配乐">` +
        `<svg viewBox="0 0 24 24" class="i-play" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>` +
        `<svg viewBox="0 0 24 24" class="i-pause" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>` +
        `</button>` +
        `<div class="pl-track"><div class="pl-title">${esc(p.entry.music.title)}</div>` +
        `<button class="pl-bar" type="button" aria-label="调整播放进度"><i class="pl-fill"></i></button></div>` +
        `<span class="pl-time">0:00 / 0:00</span>` +
        `</div></div></div>` +
        `<audio preload="none" src="${escAttr(musicSrc)}"></audio></div>`
      : '';
  const playerFab =
    p.entry.music && musicSrc
      ? `<button class="pf" id="pf" type="button" title="播放 / 暂停" aria-label="播放配乐">` +
        `<svg class="pf-ring" viewBox="0 0 36 36" aria-hidden="true">` +
        `<circle class="pf-ring-bg" cx="18" cy="18" r="16"></circle>` +
        `<circle class="pf-ring-fg" cx="18" cy="18" r="16"></circle></svg>` +
        `<span class="pf-ico" aria-hidden="true">` +
        `<svg viewBox="0 0 24 24" class="i-play"><path d="M8 5v14l11-7z"/></svg>` +
        `<svg viewBox="0 0 24 24" class="i-pause"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>` +
        `</span></button>`
      : '';
  const main =
    `<main class="article"><h1>${esc(p.entry.title)}</h1>` +
    chipsRow(p) +
    musicBar +
    // pager / footer 放进 .book：滚动模式下和原来一样是普通块级顺序；书页模式下会排到最后一页
    `<div class="bookwrap"><div class="book" id="book"><div class="body">${bodyHtml}</div>` +
    (pg.length ? `<nav class="pager">${pg.join('')}</nav>` : '') +
    footer +
    `</div></div>` +
    BOOKBAR +
    `</main>`;
  const cover = firstImage(p.entry);
  return (
    pageHead(`${p.entry.title} · ${SITE.name}`, p.excerpt, {
      title: p.entry.title,
      url: p.outName,
      type: 'article',
      published: p.entry.date,
      tags: p.entry.tags,
      image: cover ? cover.rel : OG_CARD,
      imageW: cover ? cover.w : OG_CARD_W,
      imageH: cover ? cover.h : OG_CARD_H,
      bodyAttr: tone ? ` data-tone="${escAttr(tone)}"` : '',
    }) +
    bar +
    (hasToc ? `<div class="shell">${toc}${main}</div>` : main) +
    LIGHTBOX +
    TOP_BTN +
    playerFab +
    '<script>' +
    JS_BASE +
    JS_POST +
    '</script></body></html>'
  );
}

/* ── 脚本：两页共用的部分，加上各页自己的部分 ── */

const JS_BASE = `const themeBtn=document.getElementById('theme');
const topBtn=document.getElementById('top');
const bar=document.querySelector('.bar');
themeBtn.onclick=()=>{
  const cur=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme',cur);
  try{localStorage.setItem('blog-theme',cur);}catch(e){}
};
try{
  const t=localStorage.getItem('blog-theme');
  if(t) document.documentElement.setAttribute('data-theme',t);
  else if(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.setAttribute('data-theme','dark');
}catch(e){}
topBtn.onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
/* 顶栏实际高度写回 --bar：锚点跳转 / 目录定位不会被顶栏盖住（原书同款机制） */
function syncBar(){
  if(!bar) return;
  const h=Math.round(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--bar', h+'px');
}
let resTick=0;
addEventListener('resize',()=>{if(resTick)return;resTick=requestAnimationFrame(()=>{resTick=0;syncBar();});});
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(syncBar);
syncBar();
/* 侧栏收起 / 展开：按钮在顶栏，状态记忆在 localStorage（每台设备各记各的）。
   点击时用 View Transition 平滑过渡；不支持或开了「减弱动态效果」的浏览器瞬时切换。 */
const sideBtn=document.getElementById('side-toggle');
function applySide(v,animate){
  const go=()=>{
    document.documentElement.setAttribute('data-side',v);
    try{localStorage.setItem('blog-side',v);}catch(e){}
    if(sideBtn){sideBtn.textContent=v==='0'?'»':'«';sideBtn.title=v==='0'?'展开侧栏':'收起侧栏';}
    syncBar();
  };
  if(animate){
    try{
      if(document.startViewTransition&&!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)){
        document.startViewTransition(go);
        return;
      }
    }catch(e){/* 落回瞬时切换 */}
  }
  go();
}
if(sideBtn){
  applySide(document.documentElement.getAttribute('data-side')==='0'?'0':'1',false);
  sideBtn.onclick=()=>applySide(document.documentElement.getAttribute('data-side')==='0'?'1':'0',true);
}
/* 滚动状态：① 手机端顶栏收起 ② 回到顶部按钮出现。rAF 节流 + 迟滞区间 */
let compact=false,ticking=false;
function onScroll(){
  const y=window.scrollY;
  const want = compact ? (y>200) : (y>420);
  if(want!==compact){compact=want;document.body.classList.toggle('compact',compact);syncBar();}
  topBtn.classList.toggle('show',y>900);
}
addEventListener('scroll',()=>{
  if(ticking) return;
  ticking=true;
  requestAnimationFrame(()=>{ticking=false;onScroll();});
},{passive:true});
/* 外观：底色 / 字体。和明暗同源，写进 localStorage，所有页面共用一套记忆 */
const lookEl=document.getElementById('look');
const lookBtn=document.getElementById('look-btn');
if(lookEl&&lookBtn){
  const cur=k=>document.documentElement.getAttribute('data-'+k)||'';
  const syncLook=()=>{document.querySelectorAll('.look-o').forEach(o=>{
    o.setAttribute('aria-pressed',String(cur(o.getAttribute('data-k'))===(o.getAttribute('data-v')||'')));
  });};
  const lookOpen=v=>{lookEl.setAttribute('data-open',v?'1':'0');lookBtn.setAttribute('aria-expanded',v?'true':'false');};
  document.querySelectorAll('.look-o').forEach(o=>{
    o.addEventListener('click',()=>{
      const k=o.getAttribute('data-k'),v=o.getAttribute('data-v')||'';
      if(v) document.documentElement.setAttribute('data-'+k,v);
      else document.documentElement.removeAttribute('data-'+k);
      try{localStorage.setItem('blog-'+k,v);}catch(e){}
      syncLook();
      syncBar();
    });
  });
  lookBtn.addEventListener('click',e=>{e.stopPropagation();lookOpen(lookEl.getAttribute('data-open')!=='1');});
  document.addEventListener('click',e=>{if(!lookEl.contains(e.target))lookOpen(false);});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&lookEl.getAttribute('data-open')==='1'){lookOpen(false);lookBtn.focus();}
  });
  syncLook();
}
/* 访问流畅：鼠标停在站内链接上就预取那一页，点下去几乎瞬开（配合整页 View Transition）。
   只在 hover（有意图）时触发、每个链接只取一次；外链 / 锚点 / 省流或慢速网络都不预取。 */
const conn=navigator.connection;
if(!conn||(!conn.saveData&&!/^(slow-2g|2g|3g)$/.test(conn.effectiveType||''))){
  document.addEventListener('pointerover',e=>{
    const a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
    if(!a||a.dataset.pf||a.target||a.hasAttribute('download')) return;
    const href=a.getAttribute('href')||'';
    if(!/\\.html?($|[?#])/.test(href)||/^([a-z]+:)?\\/\\//i.test(href)||href.charAt(0)==='#') return;
    a.dataset.pf='1';
    const l=document.createElement('link');
    l.rel='prefetch';l.href=href;
    document.head.appendChild(l);
  },{passive:true});
}`;

// 首页：只搜列表（标题 / 标签 / 摘要，正文不在 DOM 里）+ 栏目筛选 + 计数
const JS_HOME = `const items=[...document.querySelectorAll('.item')];
const list=document.getElementById('list');
const q=document.getElementById('q');
const cnt=document.getElementById('cnt');
const empty=document.getElementById('empty');
const secBtns=[...document.querySelectorAll('.fsec,.scat')];
const moreBtn=document.getElementById('more');
const tagsd=document.getElementById('tagsd');
let tagCur='';
const PAGE=20;
let secMode=null;
let cap=PAGE;

/* 正文全文搜索：索引（assets/search.js）首次搜索时才加载，首屏不受影响。
   加载完再重跑一次筛选，把「正文里命中」的文章补进列表，并用一句话摘要标出命中位置。 */
let IDX=null,idxLoaded=false,idxLoading=false,byHref=null;
const exOrig=new Map();
items.forEach(it=>{
  const e=it.querySelector('.iex');
  if(e)exOrig.set(it,e.textContent);
  /* 标题/标签/摘要拼一份小写缓存：每次敲键都重建 300 份字符串没必要。
     摘要有可能在正文命中时被换成 snippet，所以缓存必须取「原始」文本，且只算一次。 */
  it._hay=it.textContent.toLowerCase();
});
function loadIdx(){
  if(idxLoaded||idxLoading) return;
  idxLoading=true;
  const s=document.createElement('script');
  s.src='assets/search.js';
  s.onload=()=>{
    IDX=window.__BLOG_IDX||[];idxLoaded=true;byHref={};
    IDX.forEach(r=>{byHref[r.u]=r;});
    if(q.value.trim())apply();
  };
  s.onerror=()=>{idxLoaded=true;IDX=[];};
  document.head.appendChild(s);
}
function recOf(it){
  if(!byHref) return null;
  const a=it.querySelector('.ititle');
  return a?byHref[a.getAttribute('href')]||null:null;
}
function hasAll(hay,parts){
  for(let i=0;i<parts.length;i++){if(hay.indexOf(parts[i])<0)return false;}
  return true;
}
function snip(text,term){
  const i=text.toLowerCase().indexOf(term);
  if(i<0) return '';
  const a=Math.max(0,i-32),b=Math.min(text.length,i+term.length+64);
  return (a>0?'…':'')+text.slice(a,b)+(b<text.length?'…':'');
}

function clearMarks(root){
  const ms=[...root.querySelectorAll('mark')];
  ms.forEach(m=>m.replaceWith(document.createTextNode(m.textContent)));
  if(ms.length) root.normalize();
}
function markAll(root,term){
  if(!term) return;
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(n){
    if(!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
    const p=n.parentElement;
    if(!p) return NodeFilter.FILTER_REJECT;
    if(p.closest('script,style,mark')) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }});
  const nodes=[]; while(w.nextNode()) nodes.push(w.currentNode);
  const t=term.toLowerCase();
  nodes.forEach(n=>{
    const raw=n.nodeValue.toLowerCase();
    if(raw.indexOf(t)<0) return;
    const frag=document.createDocumentFragment();
    let i=raw.indexOf(t), last=0;
    while(i>=0){
      frag.appendChild(document.createTextNode(n.nodeValue.slice(last,i)));
      const m=document.createElement('mark');
      m.textContent=n.nodeValue.slice(i,i+t.length);
      frag.appendChild(m);
      last=i+t.length; i=raw.indexOf(t,last);
    }
    frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
    n.replaceWith(frag);
  });
}
function apply(){
  const term=q.value.trim().toLowerCase();
  const parts=term?term.split(/\s+/):[];
  clearMarks(list);
  let shown=0;
  const matched=[];
  items.forEach(it=>{
    const ex=it.querySelector('.iex');
    if(ex) ex.textContent=exOrig.get(it)||'';
    let ok=(secMode===null||it.getAttribute('data-sec')===secMode);
    if(ok&&term&&!hasAll(it._hay,parts)){
      // 标题 / 摘要 / 标签没命中 → 再翻正文索引；命中就把摘要换成正文里那句话
      ok=false;
      const r=recOf(it);
      if(r&&hasAll(r.b.toLowerCase(),parts)){ok=true;if(ex)ex.textContent=snip(r.b,parts[0]);}
    }
    it.classList.toggle('hidden',!ok);
    if(ok){shown++;matched.push(it);}
  });
  matched.forEach((it,i)=>it.classList.toggle('cut',i>=cap));
  const rest=matched.length-cap;
  if(moreBtn){
    moreBtn.classList.toggle('hidden',rest<=0);
    if(rest>0) moreBtn.textContent='加载更多（还有 '+rest+' 篇）';
  }
  if(empty) empty.classList.toggle('hidden',shown>0);
  cnt.textContent=shown+' / '+items.length+' 篇';
  cnt.classList.toggle('hidden',!(term||secMode!==null));
  if(tagsd) tagsdSync(term);
  const sc=document.getElementById('sec-count');
  if(sc) sc.textContent=shown+' 篇';
  /* 只给「这一批真正显示出来」的条目加高亮：之前是对整张列表扫一遍，
     文章多了以后 90% 的 DOM 改动都花在被 display:none 藏起来的条目上。 */
  if(parts.length){
    const visible=matched.slice(0,cap);
    parts.forEach(p=>visible.forEach(it=>markAll(it,p)));
  }
}
let timer=null;
q.addEventListener('input',()=>{cap=PAGE;if(q.value.trim())loadIdx();clearTimeout(timer);timer=setTimeout(apply,90);});
q.addEventListener('focus',()=>{if(q.value.trim())loadIdx();});
function setMode(mode){
  secMode=(mode==='all')?null:mode;
  secBtns.forEach(b=>{
    const ds=b.getAttribute('data-sec');
    const on=(ds==='all')?(secMode===null):(ds===secMode);
    b.setAttribute('aria-pressed',String(on));
  });
  const st=document.getElementById('sec-title');
  if(st){
    const hit=secBtns.find(b=>b.getAttribute('data-sec')===(secMode===null?'all':secMode));
    st.textContent=(hit&&hit.getAttribute('data-label'))||'全部文章';
  }
  cap=PAGE;
  apply();
}
secBtns.forEach(b=>{ b.onclick=()=>setMode(b.getAttribute('data-sec')); });
document.addEventListener('keydown',e=>{
  if(e.key==='/'&&document.activeElement!==q&&!/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)){
    e.preventDefault();q.focus();
  }
  if(e.key==='Escape'&&document.activeElement===q){q.value='';apply();q.blur();}
});
setMode('all');
if(moreBtn) moreBtn.onclick=()=>{cap+=PAGE;apply();};
/* 标签下拉：点开/收起、选中、外点关闭、Esc 关闭；与搜索框双向同步 */
function tagsdUI(t){
  tagCur=t;
  const lb=document.getElementById('tagsd-label');
  if(lb) lb.textContent=t?'#'+t:'全部标签';
  document.querySelectorAll('.tagsd-opt').forEach(o=>o.classList.toggle('on',(o.getAttribute('data-tag')||'')===t));
}
function tagsdOpen(v){
  if(!tagsd) return;
  tagsd.setAttribute('data-open',v?'1':'0');
  const b=document.getElementById('tagsd-btn');
  if(b) b.setAttribute('aria-expanded',v?'true':'false');
}
function tagsdSync(term){
  if(!tagsd) return;
  if((tagCur?'#'+tagCur:'').toLowerCase()!==term) tagsdUI('');
}
if(tagsd){
  const btn=document.getElementById('tagsd-btn');
  btn.addEventListener('click',e=>{e.stopPropagation();tagsdOpen(tagsd.getAttribute('data-open')!=='1');});
  document.querySelectorAll('.tagsd-opt').forEach(o=>{
    o.addEventListener('click',()=>{
      const t=o.getAttribute('data-tag')||'';
      tagsdUI(t); q.value=t?'#'+t:''; cap=PAGE; apply(); tagsdOpen(false);
    });
  });
  document.addEventListener('click',e=>{ if(!tagsd.contains(e.target)) tagsdOpen(false); });
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&tagsd.getAttribute('data-open')==='1'){tagsdOpen(false);btn.focus();} });
}`;

// 文章页：点图放大（灯箱），点任意处 / Esc 关闭
const JS_POST = `const lb=document.getElementById('lb');
if(lb){
  const lbImg=lb.querySelector('img');
  const closeLb=()=>{lb.classList.remove('open');document.body.style.overflow='';};
  document.addEventListener('click',e=>{
    if(lb.classList.contains('open')) return;
    const t=e.target;
    const img=(t&&t.closest)?t.closest('.body img'):null;
    if(img){
      lbImg.src=img.getAttribute('src')||'';
      lbImg.alt=img.getAttribute('alt')||'';
      lb.classList.add('open');
      document.body.style.overflow='hidden';
    }
  });
  lb.addEventListener('click',e=>{e.stopPropagation();closeLb();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&lb.classList.contains('open')) closeLb();});
}
/* 目录联动（原书同款）：滚动时高亮当前小节；手机端下拉跟随，选中即跳转 */
const tocLinks=[...document.querySelectorAll('.toc a')];
const jumpSel=document.getElementById('jump');
if(tocLinks.length){
  const heads=[...document.querySelectorAll('.body h3[id],.body h4[id],.body h5[id],.body h6[id]')];
  const io=new IntersectionObserver(es=>{
    es.forEach(e=>{ if(e.isIntersecting){
      const id=e.target.id;
      tocLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+id));
      if(jumpSel) jumpSel.value=id;
    }});
  },{rootMargin:'-70px 0px -75% 0px'});
  heads.forEach(h=>io.observe(h));
  if(jumpSel) jumpSel.addEventListener('change',()=>{
    const id=jumpSel.value;
    if(bkOn()){bkToId(id);return;}
    const el=document.getElementById(id);
    if(el) el.scrollIntoView({block:'start'});
  });
}
/* ── 阅读模式：书页（分栏翻页）/ 滚动 ──
   书页 = 正文按 CSS 分栏、整块左移一栏就是一页：翻页只写一次 transform，
   不测量文字、不切 DOM、不重排，所以大文章也不卡。
   取「某小节在第几页」= 元素左边缘与容器左边缘之差 ÷ 栏宽（两者一起被位移，差值不受影响）。 */
const book=document.getElementById('book');
const bookWrap=book?book.parentElement:null;
const bookHost=document.querySelector('.article');
const modeBtn=document.getElementById('mode');
const BK_GAP=56;
const wide=window.matchMedia('(min-width:821px)');
let bkPage=0;
function bkOn(){return !!book&&document.documentElement.getAttribute('data-read')==='book'&&wide.matches;}
function bkStep(){return book.clientWidth+BK_GAP;}
function bkHeads(){return document.querySelectorAll('.body h3[id],.body h4[id],.body h5[id],.body h6[id]');}
function bkPageOf(el){
  const r=el.getBoundingClientRect(),b=book.getBoundingClientRect();
  return Math.max(0,Math.round((r.left-b.left)/bkStep()));
}
function bkNoAnim(){book.classList.add('noanim');requestAnimationFrame(()=>book.classList.remove('noanim'));}
/* 锚点跳转可能让浏览器偷偷滚了裁剪容器，每次翻页都复位，免得页面错位 */
function bkResetScroll(){[bookHost,bookWrap,book].forEach(e=>{if(e){e.scrollLeft=0;e.scrollTop=0;}});}
/* 末页 = 最后一个子元素所在的栏（footer / pager 都设了 break-inside:avoid，不会被拆栏） */
function bkPages(){
  const last=book.lastElementChild;
  return Math.max(1,(last?bkPageOf(last):0)+1);
}
function bkApply(p){
  const pages=bkPages();
  bkPage=Math.max(0,Math.min(pages-1,p));
  book.style.transform='translate3d('+(-bkPage*bkStep())+'px,0,0)';
  bkResetScroll();
  const n=document.getElementById('pgnum');
  if(n) n.textContent=(bkPage+1)+' / '+pages;
  const pv=document.getElementById('pg-prev'),nx=document.getElementById('pg-next');
  if(pv) pv.disabled=bkPage<=0;
  if(nx) nx.disabled=bkPage>=pages-1;
  bkSpy();
}
function bkSpy(){
  if(!bkOn()||!tocLinks.length) return;
  let hit=null;
  bkHeads().forEach(h=>{if(bkPageOf(h)<=bkPage) hit=h;});
  tocLinks.forEach(a=>a.classList.toggle('active',!!hit&&a.getAttribute('href')==='#'+hit.id));
  if(jumpSel&&hit) jumpSel.value=hit.id;
}
function bkToId(id){
  const el=document.getElementById(id);
  if(!el||!bkOn()) return;
  bkResetScroll();
  bkApply(bkPageOf(el));
}
function bkSetMode(m,keep){
  const d=document.documentElement;
  let hit=null;
  const hs=bkHeads();
  if(keep&&hs.length){
    if(m==='book'){          /* 滚动 → 书页：接着当前读到的小节翻 */
      const top=(parseInt(getComputedStyle(d).getPropertyValue('--bar'))||56)+60;
      hs.forEach(h=>{if(h.getBoundingClientRect().top<=top) hit=h;});
    }else if(bkOn()){        /* 书页 → 滚动：滚到当前页开头那个小节 */
      hs.forEach(h=>{if(bkPageOf(h)<=bkPage) hit=h;});
    }
  }
  if(m==='book') d.setAttribute('data-read','book'); else d.removeAttribute('data-read');
  try{localStorage.setItem('blog-read',m);}catch(e){}
  if(modeBtn) modeBtn.setAttribute('aria-pressed',m==='book'?'true':'false');
  syncBar();
  requestAnimationFrame(()=>{
    if(m==='book'){bkNoAnim();bkApply(hit?bkPageOf(hit):0);}
    else if(hit) hit.scrollIntoView({block:'start'});
  });
}
if(book&&modeBtn){
  modeBtn.setAttribute('aria-pressed',bkOn()?'true':'false');
  modeBtn.onclick=()=>bkSetMode(bkOn()?'scroll':'book',true);
  const pv=document.getElementById('pg-prev'),nx=document.getElementById('pg-next');
  if(pv) pv.onclick=()=>bkApply(bkPage-1);
  if(nx) nx.onclick=()=>bkApply(bkPage+1);
  addEventListener('hashchange',()=>{if(bkOn())bkToId((location.hash||'').slice(1));});
  document.addEventListener('click',e=>{
    if(bkOn()&&e.target.closest&&e.target.closest('.toc a')) bkResetScroll();
  });
  /* 滚轮翻页：竖向、横向都认，攒够阈值才翻，翻完短暂锁一下免得连跳好几页 */
  let acc=0,lock=0;
  addEventListener('wheel',e=>{
    if(!bkOn()) return;
    const now=Date.now();
    if(now<lock){acc=0;return;}
    acc+=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.deltaY;
    if(Math.abs(acc)<40) return;
    const dir=acc>0?1:-1;
    acc=0;lock=now+300;
    bkApply(bkPage+dir);
  },{passive:true});
  addEventListener('keydown',e=>{
    if(!bkOn()) return;
    const a=document.activeElement;
    if(a&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) return;
    if(e.key==='ArrowRight'||e.key==='PageDown'){e.preventDefault();bkApply(bkPage+1);}
    else if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();bkApply(bkPage-1);}
  });
  let rt=0;
  addEventListener('resize',()=>{
    if(rt) return;
    rt=requestAnimationFrame(()=>{rt=0;if(bkOn()){bkNoAnim();bkApply(bkPage);}});
  });
  if(wide.addEventListener) wide.addEventListener('change',()=>{if(bkOn()){bkNoAnim();bkApply(bkPage);}});
  if(document.fonts&&document.fonts.ready)
    document.fonts.ready.then(()=>{if(bkOn()){bkNoAnim();bkApply(bkPage);}});
  requestAnimationFrame(()=>{
    if(!bkOn()) return;
    const id=(location.hash||'').slice(1);
    if(id) bkToId(id); else bkApply(0);
  });
}
/* 配乐：一个 <audio>、两处控件（正文里的折叠播放条 + 右下角小圆钮）。
   进度只在 timeupdate（约 4 次/秒）时刷新，不跑 rAF 常驻循环；滚动用 IntersectionObserver，不加 scroll 监听。 */
const pl=document.getElementById('pl');
if(pl){
  const au=pl.querySelector('audio');
  const btn=pl.querySelector('.pl-btn');
  const mini=pl.querySelector('.pl-mini');
  const playBtn=pl.querySelector('.pl-play');
  const bar=pl.querySelector('.pl-bar');
  const fill=pl.querySelector('.pl-fill');
  const timeEl=pl.querySelector('.pl-time');
  const fab=document.getElementById('pf');
  const fg=fab?fab.querySelector('.pf-ring-fg'):null;
  const RING=100.53;
  const fmt=s=>{if(!isFinite(s)||s<0)s=0;const m=Math.floor(s/60),x=Math.floor(s%60);return m+':'+(x<10?'0':'')+x;};
  const setOpen=v=>{pl.setAttribute('data-open',v?'1':'0');btn.setAttribute('aria-expanded',v?'true':'false');};
  const paint=()=>{
    const d=au.duration||0;
    const p=d?Math.min(1,au.currentTime/d):0;
    fill.style.width=(p*100)+'%';
    timeEl.textContent=fmt(au.currentTime)+' / '+(d?fmt(d):'0:00');
    const on=!au.paused&&!au.ended;
    pl.classList.toggle('is-playing',on);
    playBtn.setAttribute('aria-label',on?'暂停配乐':'播放配乐');
    mini.setAttribute('aria-label',on?'暂停配乐':'播放配乐');
    if(fab){
      fab.classList.toggle('is-playing',on);
      fab.setAttribute('aria-label',on?'暂停配乐':'播放配乐');
      if(fg) fg.style.strokeDashoffset=String(RING*(1-p));
    }
  };
  const toggle=()=>{if(au.paused)au.play().catch(()=>{});else au.pause();};
  btn.addEventListener('click',()=>setOpen(pl.getAttribute('data-open')!=='1'));
  mini.addEventListener('click',toggle);
  playBtn.addEventListener('click',toggle);
  bar.addEventListener('click',e=>{
    const d=au.duration;if(!d)return;
    const r=bar.getBoundingClientRect();
    au.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*d;
    paint();
  });
  au.addEventListener('play',paint);
  au.addEventListener('pause',paint);
  au.addEventListener('timeupdate',paint);
  au.addEventListener('loadedmetadata',paint);
  au.addEventListener('ended',()=>{au.currentTime=0;paint();});
  if(fab){
    fab.addEventListener('click',toggle);
    if('IntersectionObserver' in window){
      const io=new IntersectionObserver(es=>{es.forEach(en=>fab.classList.toggle('show',!en.isIntersecting));},{rootMargin:'0px 0px -40px 0px'});
      io.observe(pl);
      pl._io=io;
    }else{
      fab.classList.add('show');
    }
  }
  paint();
}`;

/* ── 全文搜索索引：首页首次搜索时才加载 assets/search.js，首屏不受影响。
      用 <script> 而不是 fetch，是因为 fetch 在本地 file:// 预览下会被浏览器拦掉。 ── */
// XML 1.0 不允许的控制字符（正文里可能混入粘贴带来的不可见字符，比如 U+0003）
function xmlSafe(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}
function xmlEsc(s: string): string {
  return xmlSafe(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// YYYY-MM-DD → RFC 822（固定在 UTC 正午，避免时区把日期挤到前一天；也保证构建确定性）
function rfc822(date: string): string {
  if (!date) return '';
  const d = new Date(`${date}T12:00:00Z`);
  return isNaN(d.getTime()) ? '' : d.toUTCString();
}

/* ── RSS：构建时生成 feed.xml（纯静态、无第三方服务、无埋点）。
      正文以「站点根前缀」渲染，再把 assets/ 和站内锚点转成绝对地址，
      这样在阅读器里图片能显示、点小节能跳回原文。 ── */
function writeFeed(pages: PageRef[]): void {
  const home = absUrl('');
  const self = absUrl('feed.xml');
  const assetsAbs = absUrl('assets/');
  const latest = pages
    .map((p) => p.entry.date)
    .filter(Boolean)
    .sort()
    .pop();
  const items = pages
    .slice(0, 50)
    .map((p) => {
      const url = absUrl(p.outName);
      let html = mdToHtml(p.entry.body, p.entry.dir, '', p.entry.title);
      html = html.replace(/(src|href)="assets\//g, (_m, attr: string) => `${attr}="${assetsAbs}`);
      // 跨文章内链（[[文章名]]）在文章页是相对路径，进 RSS 前转成绝对地址
      html = html.replace(/href="posts\//g, `href="${absUrl('posts/')}`);
      html = html.replace(/href="#/g, `href="${url}#`);
      const pub = rfc822(p.entry.date);
      return (
        '<item>' +
        `<title>${xmlEsc(p.entry.title)}</title>` +
        `<link>${xmlEsc(url)}</link>` +
        `<guid isPermaLink="true">${xmlEsc(url)}</guid>` +
        (pub ? `<pubDate>${pub}</pubDate>` : '') +
        `<category>${xmlEsc(p.secLabel)}</category>` +
        p.entry.tags.map((t) => `<category>${xmlEsc(t)}</category>`).join('') +
        `<description>${xmlEsc(p.excerpt || '')}</description>` +
        `<content:encoded><![CDATA[${xmlSafe(html).split(']]>').join(']]&gt;')}]]></content:encoded>` +
        '</item>'
      );
    })
    .join('');
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ' +
    'xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
    '<channel>' +
    `<title>${xmlEsc(SITE.name)}</title>` +
    `<link>${xmlEsc(home)}</link>` +
    `<description>${xmlEsc(SITE.description || SITE.tagline || `${SITE.name}：个人文章与交易复盘`)}</description>` +
    '<language>zh-CN</language>' +
    (latest ? `<lastBuildDate>${rfc822(latest)}</lastBuildDate>` : '') +
    `<atom:link href="${xmlEsc(self)}" rel="self" type="application/rss+xml"/>` +
    items +
    '</channel></rss>';
  writeFileSync(join(SITE_ROOT, 'feed.xml'), xml, 'utf8');
}

function writeSearchIndex(pages: PageRef[]): void {
  const idx = pages.map((p) => ({
    u: p.outName,
    t: p.entry.title,
    s: p.secLabel,
    d: p.entry.date || '',
    g: p.entry.tags,
    b: stripMd(p.entry.body).slice(0, 6000),
  }));
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    join(assetsDir, 'search.js'),
    `window.__BLOG_IDX=${JSON.stringify(idx).replace(/</g, '\\u003c')};`,
    'utf8',
  );
}

// 默认分享卡片：static/og.png 原样带到站点根（CI 只上传 dist/，所以不能留在仓库根）
function copyOgCard(): void {
  const src = join(STATIC_DIR, 'og.png');
  if (!existsSync(src)) return;
  try {
    copyFileSync(src, join(SITE_ROOT, 'og.png'));
  } catch {
    /* 复制失败不影响构建 */
  }
}

/* ── 写作统计页：全部在构建时算好，输出一张纯静态页（无脚本、无埋点、无外部服务）。
      字数按「去掉空白后的字符数」算（中文习惯，标点也算一个），没写日期的文章不计入月度。 ── */
function wordCount(text: string): number {
  return text.replace(/\s+/g, '').length;
}
function fmtSep(n: number): string {
  return n.toLocaleString('en-US');
}

function renderStatsPage(pages: PageRef[]): string {
  const wordsOf = (p: PageRef): number => wordCount(stripMd(p.entry.body));
  const total = pages.length;
  const totalWords = pages.reduce((a, p) => a + wordsOf(p), 0);
  const dated = pages.filter((p) => p.entry.date);
  const days = new Set(dated.map((p) => p.entry.date)).size;

  const byMonth = new Map<string, number>();
  for (const p of dated) byMonth.set(p.entry.date.slice(0, 7), (byMonth.get(p.entry.date.slice(0, 7)) || 0) + 1);
  let months = [...byMonth.keys()].sort();
  if (months.length > 24) months = months.slice(-24);
  const maxN = Math.max(1, ...months.map((m) => byMonth.get(m) || 0));
  const nowMonth = new Date().toISOString().slice(0, 7);
  const bars = months
    .map((m) => {
      const n = byMonth.get(m) || 0;
      const h = Math.max(3, Math.round((n / maxN) * 104));
      return (
        `<div class="st-col${m === nowMonth ? ' now' : ''}" title="${m}：${n} 篇">` +
        `<span class="st-n">${n}</span><i style="height:${h}px"></i>` +
        `<em>${Number(m.slice(5))}月</em></div>`
      );
    })
    .join('');

  const secAgg = new Map<string, { n: number; w: number }>();
  for (const p of pages) {
    const cur = secAgg.get(p.secLabel) || { n: 0, w: 0 };
    cur.n++;
    cur.w += wordsOf(p);
    secAgg.set(p.secLabel, cur);
  }
  const secRows = [...secAgg.entries()]
    .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .map(
      ([label, v]) =>
        `<tr><td>${esc(label)}</td><td class="n">${v.n}</td>` +
        `<td class="n">${fmtSep(v.w)}</td><td class="n">${fmtSep(Math.round(v.w / v.n))}</td></tr>`,
    )
    .join('');

  const tagAgg = new Map<string, number>();
  for (const p of pages) for (const t of p.entry.tags) tagAgg.set(t, (tagAgg.get(t) || 0) + 1);
  const tags = [...tagAgg.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 16)
    .map(([t, n]) => `<span class="st-tag">#${esc(t)}<i>${n}</i></span>`)
    .join('');

  // 按月回顾：把有日期的文章按月倒序列出来，作为「定期回看 / 大总结」的入口
  const monthPosts = new Map<string, PageRef[]>();
  for (const p of dated) {
    const m = p.entry.date.slice(0, 7);
    monthPosts.set(m, [...(monthPosts.get(m) ?? []), p]);
  }
  const archive = [...monthPosts.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 48)
    .map(
      ([m, list]) =>
        `<div class="st-mo"><div class="st-mo-h">${esc(m)}<i>${list.length} 篇</i></div>` +
        list
          .map(
            (p) =>
              `<a href="${escAttr(p.outName)}"><em>${esc(p.entry.date.slice(8, 10))}日</em>${esc(p.entry.title)}</a>`,
          )
          .join('') +
        `</div>`,
    )
    .join('');

  const longest = pages.reduce((a, p) => (wordsOf(p) > wordsOf(a) ? p : a), pages[0]);
  const cards =
    `<div class="st-cards">` +
    `<div class="st-card"><b>${total}</b><span>篇文章</span></div>` +
    `<div class="st-card"><b>${fmtSep(totalWords)}</b><span>累计字数</span></div>` +
    `<div class="st-card"><b>${total ? fmtSep(Math.round(totalWords / total)) : 0}</b><span>平均每篇</span></div>` +
    `<div class="st-card"><b>${days}</b><span>记录天数</span></div>` +
    `</div>`;

  const body =
    `<h3>概览</h3>` +
    `<p class="st-lead">共 ${total} 篇，累计 ${fmtSep(totalWords)} 字${days ? `，分布在 ${days} 天里` : ''}。` +
    (longest ? `最长的一篇是《${esc(longest.entry.title)}》，${fmtSep(wordsOf(longest))} 字。` : '') +
    (total > dated.length ? `有 ${total - dated.length} 篇没写日期，不计入下面的按月统计。` : '') +
    `</p>` +
    cards +
    (months.length ? `<h3>每月发文</h3><div class="st-bars">${bars}</div>` : '') +
    (secRows ? `<h3>栏目</h3><table class="st-tab"><thead><tr><th>栏目</th><th class="n">篇数</th><th class="n">字数</th><th class="n">平均</th></tr></thead><tbody>${secRows}</tbody></table>` : '') +
    (tags ? `<h3>标签</h3><div class="st-tags">${tags}</div>` : '') +
    (archive ? `<h3>按月回顾</h3><div class="st-arch">${archive}</div>` : '');

  const bar =
    `<header class="bar"><a class="back" href="${escAttr(basename(OUT_FILE))}">← 返回首页</a>` +
    `<div class="brand">${esc(SITE.name)}</div><div class="spacer"></div>` +
    `<button class="btn" id="theme">明/暗</button>` + LOOK_BAR + `</header>`;
  const main = `<main class="article"><h1>写作统计</h1><div class="body">${body}</div></main>`;
  return (
    pageHead(`写作统计 · ${SITE.name}`, `${SITE.name}的写作量统计：按月发文、栏目与标签分布。`, {
      title: '写作统计',
      url: 'stats.html',
      imageW: OG_CARD_W,
      imageH: OG_CARD_H,
    }) +
    bar +
    main +
    TOP_BTN +
    '<script>' +
    JS_BASE +
    '</script></body></html>'
  );
}

/* ═══════════════ 主流程 ═══════════════ */

function main(): void {
  const sections: Section[] = discoverSections().map((s, idx) => ({ ...s, idx, entries: loadSection(s) }));
  const nonEmpty = sections.filter((s) => s.entries.length > 0);
  const total = nonEmpty.reduce((n, s) => n + s.entries.length, 0);

  // 安全闸：一篇文章都没找到、但还有已生成的页面时，中止构建，避免把站点误清空。
  //（典型场景：栏目文件夹被改名——旧逻辑会把它当成“文章都删了”，连生成的页面一起清掉。）
  const existingPages = existsSync(PAGES_OUT)
    ? readdirSync(PAGES_OUT).filter((f) => /\.html?$/i.test(f))
    : [];
  if (total === 0 && existingPages.length > 0 && !allowEmpty) {
    const msg =
      `没有找到任何文章（posts/ 下没有可用栏目，或栏目文件夹里没有 md）。\n` +
      `但 posts/ 里还保留着 ${existingPages.length} 个已生成的页面——为避免误删站点，本次构建已中止，未改动任何文件。\n` +
      `常见原因：栏目文件夹被改名 / 移动 / 清空；把内容放回原位再试。\n` +
      `如果确实想要一个空站点，请加 --allow-empty 重新运行。`;
    if (watchMode) {
      console.error(msg);
      return;
    }
    die(msg);
  }

  // 图片：先收集所有引用 → 处理 → 再渲染
  IMG_INFOS.clear();
  IMG_JOBS.clear();
  IMG_MISSING.length = 0;
  MUSIC_INFOS.clear();
  MUSIC_JOBS.clear();
  MUSIC_KEEP.clear();
  MUSIC_MISSING.length = 0;
  MUSIC_BIG.length = 0;
  RESOLVE_CACHE.clear();
  const allEntries = nonEmpty.flatMap((s) => s.entries);
  collectImageJobs(allEntries);
  collectMusicJobs(allEntries);
  // 先落地配乐（文件名进 MUSIC_KEEP），后面的图片清理步骤才不会把音频当垃圾删掉
  const music = processAudio();
  for (const e of allEntries) if (e.musicAbs) e.musicRel = MUSIC_INFOS.get(e.musicAbs);
  const img = processImages();

  // 合并时间线：两栏目混在一起按日期倒序，无日期的排在最后
  const pages: PageRef[] = [];
  for (const s of nonEmpty) {
    for (const e of s.entries) {
      pages.push({
        entry: e,
        secIdx: s.idx,
        secLabel: s.label,
        slug: '',
        outName: '',
        excerpt: excerptOf(e.body),
      });
    }
  }
  pages.sort((a, b) => {
    const da = a.entry.date;
    const db = b.entry.date;
    if (da && db) {
      if (da !== db) return da < db ? 1 : -1;
    } else if (da) return -1;
    else if (db) return 1;
    if (a.secIdx !== b.secIdx) return a.secIdx - b.secIdx;
    return a.entry.file < b.entry.file ? -1 : a.entry.file > b.entry.file ? 1 : 0;
  });

  // 首页列表：置顶文章排最前（组内保持时间序）；文章页前后导航仍按时间序
  const listed = [...pages].sort((a, b) =>
    a.entry.pinned === b.entry.pinned ? 0 : a.entry.pinned ? -1 : 1,
  );

  const undated = pages.filter((p) => !p.entry.date);
  if (undated.length > 0) {
    console.warn(
      `提示：${undated.length} 篇文章没有日期，会排在列表最后（${undated.map((p) => p.entry.title).join('、')}）；想按日期排序就给文件名加日期前缀或在 frontmatter 里写 date。`,
    );
  }

  // slug：由文件名 stem 生成，冲突时确定性追加 -2、-3
  const used = new Set<string>();
  for (const p of pages) {
    const base = slugify(p.entry.file.replace(/\.md$/i, ''));
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    p.slug = slug;
    p.outName = `${PAGES_DIR}/${slug}.html`;
  }

  // 跨文章内链的名字表：标题 / 文件名（含去掉日期前缀的短名）/ slug 都能指向同一篇
  POST_LINKS.clear();
  POST_LINK_MISSING.length = 0;
  for (const p of pages) {
    const stem = p.entry.file.replace(/\.md$/i, '');
    const short = stem.replace(/^\d{4}-\d{1,2}-\d{1,2}[-_ ]?/, '');
    for (const name of [stem, short, p.entry.title, p.slug]) {
      const key = postKey(name);
      if (key && !POST_LINKS.has(key)) POST_LINKS.set(key, p.slug);
    }
  }

  let latest = '';
  for (const p of pages) if (p.entry.date && p.entry.date > latest) latest = p.entry.date;

  const counts = nonEmpty.map((s) => `${s.label} ${s.entries.length} 篇`).join('、');
  const small = SITE.tagline || `共 ${total} 篇`;
  const desc =
    SITE.description ||
    `${SITE.name}：${counts || '复盘记录与主题文章'}${latest ? `，最近更新 ${latest}` : ''}。`;
  // prefix：从当前页面回到站点根的相对前缀（文章页在 posts/ 里，取 '../'）
  const footerFor = (prefix: string): string =>
    `<footer>${esc(SITE.name)}${counts ? `，共 ${total} 篇（${counts}）` : ''}${latest ? `，最近更新 ${latest}` : ''}。 ` +
    `<a href="${prefix}stats.html">写作统计</a> · <a href="${prefix}feed.xml">RSS</a></footer>`;

  const bar =
    `<header class="bar"><h1>${esc(SITE.name)}<small>${esc(small)}</small></h1>` +
    SIDE_BTN +
    // 栏目筛选：宽屏交给左侧栏，窄屏（侧栏隐藏）才在顶栏出现
    `<span class="fsecs">` +
    `<button class="btn fsec" id="f-all" data-sec="all" data-label="全部文章">全部</button>` +
    nonEmpty
      .map(
        (s) =>
          `<button class="btn fsec" id="f-${s.idx}" data-sec="${s.idx}" data-label="${escAttr(s.label)}">${esc(s.label)}</button>`,
      )
      .join('') +
    `</span>` +
    `<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/>` +
    `<path d="M20 20l-3.5-3.5"/></svg>` +
    `<input id="q" type="search" placeholder="搜索标题、标签、正文…" autocomplete="off">` +
    `<kbd>/</kbd></div>` +
    `<span class="count hidden" id="cnt"></span>` +
    `<button class="btn" id="theme">明/暗</button>` +
    LOOK_BAR +
    `</header>`;

  // 首页左侧栏：置顶 / 栏目 / 标签 / 统计（窄屏隐藏；置顶文章同时在列表顶部带标记）
  const pinned = pages.filter((p) => p.entry.pinned);
  const tagCount = new Map<string, number>();
  for (const pg of pages) for (const t of pg.entry.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const tagList = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const sidebar =
    `<aside class="side">` +
    (pinned.length
      ? `<div class="sblock"><div class="gt">置顶</div>` +
        pinned
          .map((p) => `<a class="sitem" href="${escAttr(p.outName)}"><span>${esc(p.entry.title)}</span></a>`)
          .join('') +
        `</div>`
      : '') +
    `<div class="sblock"><div class="gt">栏目<small>${total} 篇</small></div>` +
    `<button class="scat" data-sec="all" data-label="全部文章"><span>全部</span><i>${total}</i></button>` +
    nonEmpty
      .map(
        (s) =>
          `<button class="scat" data-sec="${s.idx}" data-label="${escAttr(s.label)}"><span>${esc(s.label)}</span><i>${s.entries.length}</i></button>`,
      )
      .join('') +
    `</div>` +
    (tagList.length
      ? `<div class="sblock"><div class="gt">标签</div>` +
        `<div class="tagsd" id="tagsd">` +
        `<button class="tagsd-btn" id="tagsd-btn" type="button" aria-haspopup="listbox" aria-expanded="false">` +
        `<span class="tagsd-label" id="tagsd-label">全部标签</span>` +
        `<svg class="caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>` +
        `</button>` +
        `<div class="tagsd-panel" role="listbox" aria-label="按标签筛选">` +
        `<button class="tagsd-opt" type="button" role="option" data-tag="">全部标签<i>${total}</i></button>` +
        tagList
          .map(
            ([t, n]) =>
              `<button class="tagsd-opt" type="button" role="option" data-tag="${escAttr(t)}">#${esc(t)}<i>${n}</i></button>`,
          )
          .join('') +
        `</div></div></div>`
      : '') +
    `<div class="sblock"><div class="gt">更多</div>` +
    `<a class="sitem" href="stats.html"><span>写作统计</span></a></div>` +
    `</aside>`;

  const home =
    pageHead(SITE.name, desc, { url: '', type: 'website', imageW: OG_CARD_W, imageH: OG_CARD_H }) +
    bar +
    `<div class="shell">` +
    sidebar +
    `<main><div class="sec-h"><h2 id="sec-title">全部文章</h2>` +
    `<span class="meta" id="sec-count">${total} 篇</span></div>` +
    `<ul class="list" id="list">${listed.map(renderListItem).join('\n')}</ul>` +
    `<button id="more" class="btn hidden" type="button">加载更多</button>` +
    (total > 0
      ? `<div class="empty hidden" id="empty">没有匹配的内容</div>`
      : `<div class="empty" id="empty">还没有内容：去 ${CONTENT_DIR}/ 里写第一篇吧</div>`) +
    footerFor('') +
    `</main></div>` +
    TOP_BTN +
    '<script>' +
    JS_BASE +
    JS_HOME +
    '</script></body></html>';

  mkdirSync(SITE_ROOT, { recursive: true });
  writeFileSync(OUT_FILE, home, 'utf8');

  if (pages.length > 0) mkdirSync(PAGES_OUT, { recursive: true });
  pages.forEach((p, i) => {
    writeFileSync(join(PAGES_OUT, `${p.slug}.html`), renderPostPage(pages, i, footerFor(PAGE_PREFIX)), 'utf8');
  });
  writeFileSync(join(SITE_ROOT, 'stats.html'), renderStatsPage(pages), 'utf8');
  writeSearchIndex(pages);
  writeFeed(pages);
  copyOgCard();

  // 清理改过名 / 已删除文章留下的旧页面（只动文章目录根部的 .html）
  const keepPages = new Set(pages.map((p) => `${p.slug}.html`));
  let stale = 0;
  try {
    for (const f of readdirSync(PAGES_OUT)) {
      if (!/\.html?$/i.test(f) || keepPages.has(f)) continue;
      try {
        rmSync(join(PAGES_OUT, f));
        stale++;
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 文章目录不存在时忽略 */
  }

  // ── 输出汇报 ──
  // 同一篇被复制成两份（文件名不同、标题相同）时提示：站内会变成两篇一样的文章
  const byTitle = new Map<string, string[]>();
  for (const p of pages) {
    const key = p.entry.title.trim();
    byTitle.set(key, [...(byTitle.get(key) ?? []), p.entry.relPath]);
  }
  const dupTitles = [...byTitle.entries()].filter(([, files]) => files.length > 1);
  if (dupTitles.length > 0) {
    console.warn(
      `提示：有 ${dupTitles.length} 组文章标题重复（${dupTitles.map(([t, fs]) => `${t}：${fs.join('、')}`).join('；')}）——同一篇被复制成了两份，删掉多余的那份。`,
    );
  }
  const briefs = pages
    .map((p) => ({ title: p.entry.title, n: cpLen(stripMd(summaryBody(p.entry.body))) }))
    .filter((x) => x.n > 300);
  if (briefs.length > 0) {
    console.warn(
      `提示：${briefs.map((x) => `${x.title}（${x.n} 字）`).join('、')} 的开头提要超过 300 字，压一压。`,
    );
  }
  if (WIKI_MISSING.length > 0) {
    console.warn(
      `提示：${WIKI_MISSING.length} 个 [[#小节]] 内链没找到同名标题（${[...new Set(WIKI_MISSING.map((x) => x.target))].slice(0, 6).join('、')}）；要和正文里的小节标题一字不差。`,
    );
  }
  if (POST_LINK_MISSING.length > 0) {
    console.warn(
      `提示：${POST_LINK_MISSING.length} 个 [[文章名]] 内链没找到对应文章（${[...new Set(POST_LINK_MISSING)].slice(0, 6).join('、')}）；写文件名（日期前缀可省）或文章标题都能对上。`,
    );
  }
  console.log(`栏目 ${nonEmpty.length} ｜ 共 ${total} 篇${counts ? ` ｜ ${counts}` : ''}`);
  console.log(`首页：${OUT_FILE}（${Buffer.byteLength(home, 'utf8')} 字节）`);
  console.log(`文章页：${pages.length} 个 → ${PAGES_OUT}/`);
  if (stale) console.log(`清理 ${stale} 个过期页面（改过名或已删除的文章）`);
  if (img.stats.length) {
    const fresh = img.stats.filter((s) => !s.cached);
    const cachedN = img.stats.length - fresh.length;
    const srcTotal = img.stats.reduce((n, s) => n + s.srcBytes, 0);
    const outTotal = img.stats.reduce((n, s) => n + s.outBytes, 0);
    const pct = srcTotal > 0 ? Math.round((1 - outTotal / srcTotal) * 100) : 0;
    console.log(
      `图片 ${img.stats.length} 张 ｜ 新压缩 ${fresh.length} ｜ 复用 ${cachedN} ｜ ` +
        `原始 ${fmtBytes(srcTotal)} → 成品 ${fmtBytes(outTotal)}${pct > 0 ? `（-${pct}%）` : ''}`,
    );
    for (const s of fresh) {
      console.log(`  · ${s.src}（${s.dims}，${fmtBytes(s.srcBytes)}）→ ${s.out}（${fmtBytes(s.outBytes)}，${s.tool}）`);
    }
  }
  if (img.pruned) console.log(`清理 ${img.pruned} 个不再引用的旧图（${fmtBytes(img.prunedBytes)}）`);
  if (img.outside.length) {
    console.warn(`注意：${img.outside.length} 张图片在 posts/ 之外，推送到 GitHub 后自动重建可能找不到，建议挪进 posts/`);
  }
  for (const m of IMG_MISSING) {
    console.warn(`找不到图片：${m.src}（来自 ${m.from}）—— HTML 里保留了原路径`);
  }
  if (IMG_JOBS.size > 0 && IMAGES.enabled && !hasCmd('cwebp') && !hasCmd('magick') && !hasCmd('convert') && !hasCmd('sips')) {
    console.warn('未找到任何图片压缩工具（cwebp / ImageMagick / sips），图片按原样复制');
  }
  if (music.n > 0) {
    console.log(`配乐 ${music.n} 首 ｜ 新复制 ${music.fresh} ｜ 合计 ${fmtBytes(music.bytes)}（自托管，未转码）`);
  }
  for (const m of MUSIC_MISSING) {
    console.warn(`找不到配乐文件：${m.src}（来自 ${m.from}）—— 已跳过该篇播放器`);
  }
  for (const b of MUSIC_BIG) {
    console.warn(`配乐偏大：${b.name}（${fmtBytes(b.bytes)}）—— 建议压到 96–128kbps 再提交，仓库和 Pages 都有体积上限`);
  }
}

function build(): void {
  main();
}

if (watchMode) {
  build();
  console.log(`👀 监听中：${CONTENT}（改动即重建；生成的页面不触发，Ctrl-C 退出）`);
  let t: ReturnType<typeof setTimeout> | null = null;
  watch(CONTENT, { recursive: true }, (_event, filename) => {
    // 文章页就写在内容目录里，生成的 .html 变化必须忽略，否则会自己触发自己
    if (typeof filename === 'string' && /\.html?$/i.test(filename)) return;
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      try {
        console.log('\n▶ 检测到改动，重新构建');
        build();
      } catch (err) {
        console.error('构建出错：', err);
      }
    }, 250);
  });
} else {
  build();
}
