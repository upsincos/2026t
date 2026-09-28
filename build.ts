#!/usr/bin/env node
/**
 * 交易博客生成器：把 posts/ 里的 Markdown 渲染成一套静态多页 HTML 站点。
 *
 * 输出的是一套「真博客」，而不是一本一次加载完的单页书：
 *   index.html         首页：顶栏 + 左侧栏（置顶 / 栏目 / 标签 / 统计）+ 按时间倒序的简明文章列表
 *   posts/<slug>.html  文章页：标题 + 元信息 + 正文（小节 ≥2 时带左侧目录）+ 「更新的一篇 / 更早的一篇」两个链接
 *   assets/            正文图片压缩后的成品
 * 首页只放简洁条目（标题 / 一行摘要 / 日期 · 栏目 · 标签），正文留在文章页；frontmatter 写 pin: true 可置顶。
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
};

// 栏目 = posts/ 下的文件夹，自动识别：新建 / 改名 / 移动文件夹都会自动生效，不需要改这里。
// 这个列表只控制「显示顺序」：先按这里的名字排，没列到的按名称排在后面。
const SECTION_ORDER: string[] = ['记录', '文章', '几何'];

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
  index.html          首页：顶栏 + 左侧栏（置顶 / 栏目 / 标签）+ 按时间倒序的简明文章列表
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
function discoverSections(): { dir: string; label: string }[] {
  let names: string[] = [];
  try {
    names = readdirSync(CONTENT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
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
    entries.push({ title, date, tags, body, file: name, dir: dirname(full), relPath: relative(CONTENT, full), pinned });
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

function resolveImagePath(rawSrc: string, mdDir: string): string | null {
  const key = rawSrc + '\u0000' + mdDir;
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
    // 同目录 → 同目录里的 images/ 子目录 → 内容根 → 仓库根
    const tries = [join(mdDir, p), join(mdDir, 'images', p), join(CONTENT, p), join(HERE, p)];
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
    if (!genRe.test(f) || referenced.has(f)) continue;
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
    html += `<li>${inline(it.text, mdDir, prefix)}`;
  }
  while (stack.length) html += `</li></${stack.pop()}>`;
  return { html, next: i };
}

function mdToHtml(md: string, mdDir: string, prefix = ''): string {
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
    // 标题：# → h4，## → h5，### → h6（带 #h-N 锚点，供文章目录联动）
    m = /^(#{1,4})\s+(.*)$/.exec(ln);
    if (m) {
      const lvl = Math.min(m[1].length + 3, 6);
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
      out.push(`<blockquote>${buf.map((t) => `<p>${inline(t, mdDir, prefix)}</p>`).join('')}</blockquote>`);
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
  return out.join('\n');
}

/* ═══════════════ 样式与脚本 ═══════════════ */

const CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#ffffff;--bg-alt:#f6f6f7;--bg-elv:#ffffff;--bg-mute:#f1f1f2;
  --divider:#e2e2e3;
  --t1:rgba(60,60,67,1);--t2:rgba(60,60,67,.78);--t3:rgba(60,60,67,.56);
  --brand-1:#3451b2;--brand-2:#3a5ccc;--brand-soft:rgba(100,108,255,.12);
  --green-1:#18794e;--green-soft:rgba(16,185,129,.13);
  --yellow-1:#915930;--yellow-soft:rgba(234,179,8,.15);
  --red-1:#b8272c;--red-soft:rgba(244,63,94,.12);
  --gray-1:#565a5f;--gray-soft:rgba(142,150,170,.15);
  --mark:rgba(234,179,8,.34);
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --bar:56px;--side:clamp(230px,16vw,330px);
}
[data-theme=dark]{
  --bg:#1b1b1f;--bg-alt:#161618;--bg-elv:#202127;--bg-mute:#2b2b2f;
  --divider:#2e2e32;
  --t1:rgba(255,255,245,.88);--t2:rgba(235,235,245,.62);--t3:rgba(235,235,245,.4);
  --brand-1:#a8b1ff;--brand-2:#c3c9ff;--brand-soft:rgba(100,108,255,.18);
  --green-1:#3dd68c;--green-soft:rgba(16,185,129,.16);
  --yellow-1:#f9b44e;--yellow-soft:rgba(234,179,8,.16);
  --red-1:#f66f81;--red-soft:rgba(244,63,94,.16);
  --gray-1:#a4a8ae;--gray-soft:rgba(142,150,170,.16);
  --mark:rgba(234,179,8,.3);
}
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--bar) + 14px)}
body{margin:0;background:var(--bg);color:var(--t1);font:15px/1.75 var(--font);
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
.search{position:relative;width:300px;max-width:42vw}
.search input{width:100%;height:34px;padding:0 30px 0 32px;border-radius:8px;border:1px solid var(--divider);
  background:var(--bg-alt);color:var(--t1);font:inherit;font-size:13px}
.search input:focus{outline:0;border-color:var(--brand-1);background:var(--bg-elv)}
.search svg{position:absolute;left:9px;top:50%;transform:translateY(-50%);width:15px;height:15px;
  fill:none;stroke:var(--t3);stroke-width:2;pointer-events:none}
.search kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);font:500 10px/1 var(--font);
  color:var(--t3);border:1px solid var(--divider);border-radius:4px;padding:2px 4px;background:var(--bg-elv)}
.btn{height:30px;padding:0 11px;border-radius:999px;border:1px solid var(--divider);background:var(--bg-elv);
  color:var(--t2);font:500 12px/1 var(--font);cursor:pointer;transition:all .18s;white-space:nowrap}
.btn:hover{border-color:var(--brand-2);color:var(--t1)}
.btn[aria-pressed=true]{background:var(--brand-soft);border-color:var(--brand-1);color:var(--brand-1)}
.count{font-size:12px;color:var(--t3);white-space:nowrap;font-variant-numeric:tabular-nums}
.jump{display:none;height:30px;max-width:38vw;padding:0 6px;border-radius:8px;border:1px solid var(--divider);
  background:var(--bg-elv);color:var(--t2);font:500 12px/1 var(--font)}

main{max-width:840px;margin:0 auto;padding:26px 40px 140px}

/* ── 首页：左侧栏（置顶 / 栏目 / 标签 / 统计；可收起（按钮记忆状态），窄屏自动隐藏）── */
.side{position:sticky;top:var(--bar);flex:none;width:var(--side);height:calc(100vh - var(--bar));
  overflow-y:auto;padding:18px 14px 80px 18px;background:var(--bg-alt);border-right:1px solid var(--divider)}
[data-side="0"] .side,[data-side="0"] .toc{display:none}
#side-toggle{display:inline-flex;align-items:center;justify-content:center;min-width:32px;padding:0 8px;font-size:14px}
.sblock{padding-bottom:12px;margin-bottom:12px;border-bottom:1px solid var(--divider)}
.sblock:last-child{padding-bottom:0;margin-bottom:0;border-bottom:0}
.side .gt{font-size:13px;font-weight:600;margin:0 0 6px;color:var(--t1)}
.scat,.sitem{display:block;width:100%;padding:4px 6px;border:0;border-radius:6px;background:none;
  font:inherit;font-size:12.5px;line-height:1.5;color:var(--t2);text-align:left;cursor:pointer;overflow-wrap:anywhere}
.scat{display:flex;align-items:baseline;gap:6px}
.scat:hover,.sitem:hover{background:var(--bg-elv);color:var(--t1);text-decoration:none}
.scat[aria-pressed=true]{background:var(--brand-soft);color:var(--brand-1)}
.scat i,.tagbtn i{font-style:normal;color:var(--t3);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:11px}
.stag{display:flex;flex-wrap:wrap;gap:5px}
.tagbtn{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:0;border-radius:999px;
  background:var(--bg-mute);color:var(--t3);font:400 11.5px/1.6 var(--font);cursor:pointer}
.tagbtn:hover{background:var(--brand-soft);color:var(--brand-1)}
.sfoot{color:var(--t3);font-size:12px;line-height:1.8}

/* ── 首页：文章列表（简洁条目：标题 / 一行摘要 / 一行元信息）── */
.list{list-style:none;margin:0;padding:0}
.item{padding:15px 2px 14px;border-bottom:1px solid var(--divider)}
.item:last-child{border-bottom:0}
.ititle{display:block;font-size:16.5px;font-weight:600;line-height:1.5;color:var(--t1);
  letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ititle:hover{color:var(--brand-1);text-decoration:none}
.pin-badge{display:inline-block;margin-right:7px;padding:3px 7px;border-radius:999px;
  background:var(--brand-soft);color:var(--brand-1);font:500 11px/1 var(--font);vertical-align:2px}
.iex{margin:5px 0 0;font-size:13.5px;line-height:1.7;color:var(--t2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.imeta{margin-top:6px;font-size:12px;color:var(--t3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.tag{font:400 11px/1 var(--font);padding:4px 9px;border-radius:999px;background:var(--bg-mute);color:var(--t3)}
.badge{font:500 11px/1 var(--font);padding:4px 9px;border-radius:999px;border:1px solid transparent}
.gA{background:var(--green-soft);color:var(--green-1);border-color:var(--green-soft)}
.gB{background:var(--yellow-soft);color:var(--yellow-1);border-color:var(--yellow-soft)}
.gC{background:var(--gray-soft);color:var(--gray-1);border-color:var(--gray-soft)}
.r0{background:var(--brand-soft);color:var(--brand-1);border-color:var(--brand-soft)}
.r1{background:var(--green-soft);color:var(--green-1);border-color:var(--green-soft)}
.r2{background:var(--gray-soft);color:var(--gray-1);border-color:var(--gray-soft)}

.plain{margin:0 0 12px 34px;padding:10px 14px;background:var(--brand-soft);
  border-left:3px solid var(--brand-1);border-radius:0 8px 8px 0;font-size:15px;line-height:1.8;color:var(--t1)}
.fields{margin-left:34px}
.f{display:grid;grid-template-columns:52px 1fr;gap:10px;padding:7px 0;border-top:1px solid var(--divider);
  font-size:13.5px;line-height:1.75;color:var(--t2)}
.f b{font-weight:500;color:var(--t3);font-size:12.5px;padding-top:2px}
.f.note b{color:var(--yellow-1)}
.f>div{min-width:0;overflow-wrap:anywhere}
.src{margin:10px 0 0 34px;border-top:1px solid var(--divider);padding-top:8px}
.src summary{cursor:pointer;font-size:12.5px;color:var(--t3);list-style:none;user-select:none}
.src summary::-webkit-details-marker{display:none}
.src summary::before{content:"▸ ";color:var(--t3)}
.src[open] summary::before{content:"▾ "}
.src summary:hover{color:var(--brand-1)}
.src .sbody{font-size:12.5px;line-height:1.8;color:var(--t2);padding:8px 0 2px;word-break:break-word;overflow-wrap:anywhere}

body.plain-only .fields,body.plain-only .src{display:none}

/* ── 文章页（宽屏：左侧目录 + 正文，沿用原书的目录联动；窄屏目录收进顶栏下拉）── */
.shell{display:flex;align-items:flex-start}
.toc{position:sticky;top:var(--bar);flex:none;width:var(--side);height:calc(100vh - var(--bar));
  overflow-y:auto;padding:18px 14px 80px 18px;background:var(--bg-alt);border-right:1px solid var(--divider)}
.toc .gt{font-size:13px;font-weight:600;margin:0 0 6px;color:var(--t1);display:flex;justify-content:space-between;align-items:baseline}
.toc .gt small{font-weight:400;font-size:11px;color:var(--t3)}
.toc a{display:flex;gap:6px;align-items:baseline;padding:3px 6px;border-radius:6px;font-size:12.5px;
  line-height:1.5;color:var(--t2)}
.toc a:hover{background:var(--bg-elv);color:var(--t1);text-decoration:none}
.toc a.active{background:var(--brand-soft);color:var(--brand-1)}
.toc a i{font-style:normal;color:var(--t3);font-variant-numeric:tabular-nums;flex:none;min-width:16px;text-align:right}
.shell>.article,.shell>main{flex:1;min-width:0}
.article{max-width:760px}
.article h1{font-size:26px;font-weight:600;line-height:1.45;margin:2px 0 10px;letter-spacing:-.2px;overflow-wrap:anywhere}
.article .chips{margin:12px 0 22px}
.pager{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;margin:36px 0 0;
  border-top:1px solid var(--divider);padding-top:16px}
.pager a{display:flex;flex-direction:column;gap:3px;max-width:48%;font-size:14px;line-height:1.5;color:var(--t1)}
.pager a:hover{color:var(--brand-1);text-decoration:none}
.pager a small{font-size:11.5px;color:var(--t3)}
.pager a span{font-weight:500;overflow-wrap:anywhere}
.pager .older{margin-left:auto;text-align:right}

.hidden{display:none!important}
.empty{color:var(--t3);font-size:14px;padding:40px 0;text-align:center}
footer{color:var(--t3);font-size:12px;border-top:1px solid var(--divider);padding-top:14px;
  line-height:1.9;margin-top:40px}
footer a{color:var(--t2)}

#top{position:fixed;right:16px;bottom:16px;z-index:40;width:42px;height:42px;border-radius:50%;
  border:1px solid var(--divider);background:var(--bg-elv);color:var(--t2);cursor:pointer;
  font:400 17px/1 var(--font);box-shadow:0 2px 12px rgba(0,0,0,.14);
  opacity:0;pointer-events:none;transition:opacity .2s,color .18s}
#top.show{opacity:1;pointer-events:auto}
#top:hover{color:var(--brand-1);border-color:var(--brand-1)}

/* ── 正文排版 ── */
.body{margin:0;font-size:15px;line-height:1.8;color:var(--t1);overflow-wrap:anywhere}
.body p{margin:0 0 10px}
.body p:last-child{margin-bottom:2px}
.body h4,.body h5,.body h6{margin:16px 0 8px;color:var(--t1);font-weight:600;line-height:1.5}
.body h4{font-size:16px}
.body h5{font-size:15px}
.body h6{font-size:14px}
.body ul,.body ol{margin:0 0 10px;padding-left:22px}
.body li{margin:3px 0}
.body li>ul,.body li>ol{margin-bottom:0;margin-top:3px}
.body blockquote{margin:0 0 10px;padding:9px 13px;background:var(--brand-soft);border-left:3px solid var(--brand-1);border-radius:0 8px 8px 0;color:var(--t1)}
.body blockquote p{margin:0}
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

@media (max-width:1080px){
  .toc{display:none}
  .side{display:none}
  #side-toggle{display:none}
  .jump{display:block}
}
@media (max-width:820px){
  .bar{padding:8px 12px;gap:8px;min-height:0}
  /* 手机上顶栏折成多行：① 返回 + 标题 ② 目录跳转 ③ 明暗 ④ 筛选 ⑤ 计数 ⑥ 搜索（独占整行，才好打字） */
  .back{order:1}
  .bar h1,.bar .brand{order:2;flex:1 1 120px;font-size:14px;overflow:hidden;text-overflow:ellipsis}
  .spacer{display:none}
  .jump{order:3}
  #theme{order:4}
  .fsec{order:5}
  .count{order:6;margin-left:auto}
  .search{order:7;width:auto;max-width:none;flex:1 1 100%;margin-top:2px}
  .search input{height:34px}
  .search kbd{display:none}
  /* 向下滚动后收成一行（标题+搜索+明暗），把竖向空间还给列表；滚回顶部再展开 */
  body.compact .jump,body.compact .fsec,body.compact .count{display:none}
  body.compact .search{order:3;flex:1 1 120px;margin-top:0}
  body.compact #theme{order:4}
  main{padding:16px 13px 110px}
  .article h1{font-size:22px}
  .ititle{font-size:15.5px}
  .pager{margin-top:28px}
  .pager a{max-width:100%}
  .plain{font-size:14.5px;padding:9px 12px}
  .f{font-size:13px;grid-template-columns:44px 1fr;gap:8px}
}
@media (max-width:520px){
  .bar h1 small,.bar .brand small{display:none}
  .chips,.plain,.fields,.src,.body{margin-left:0}
}
/* 320-380px 的窄屏：按钮收紧，否则顶栏会被挤到多占一到两行 */
@media (max-width:380px){
  .btn{padding:0 8px;font-size:11px}
  .bar h1,.bar .brand{flex:1 1 90px;font-size:13px}
  .jump{max-width:32vw}
}
@media print{
  .bar,.toc,.side,.jump,#top,#lb{display:none}
  main{max-width:none;padding:0}
  .item{break-inside:avoid;border-color:#ccc}
  .body img{max-height:none}
  .pager{display:none}
  .src .sbody{display:block}
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

/* ── 页面骨架 ── */

const TOP_BTN = `<button id="top" title="回到顶部" aria-label="回到顶部">↑</button>`;
const SIDE_BTN = `<button class="btn" id="side-toggle" title="收起侧栏" aria-label="收起或展开侧栏">«</button>`;
const LIGHTBOX = `<div id="lb" role="dialog" aria-modal="true" aria-label="查看大图"><img alt=""></div>`;

function pageHead(title: string, desc: string): string {
  return (
    `<!DOCTYPE html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">` +
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1b1b1f">` +
    `<meta name="description" content="${escAttr(desc)}">` +
    `<title>${esc(title)}</title><style>${CSS}</style>` +
    `<script>try{if(localStorage.getItem('blog-side')==='0')document.documentElement.setAttribute('data-side','0')}catch(e){}</script>` +
    `</head><body>`
  );
}

// 栏目徽标配色：第一个栏目绿、第二个蓝，其余灰（沿用原书的强调色系）
function secBadgeClass(secIdx: number): string {
  return secIdx === 0 ? 'r1' : secIdx === 1 ? 'r0' : 'r2';
}

// 元信息行：栏目徽标 + 日期 + 标签（沿用原书的 chips 组件）
function chipsRow(p: PageRef): string {
  const badge = `<span class="badge ${secBadgeClass(p.secIdx)}">${esc(p.secLabel)}</span>`;
  const date = p.entry.date ? `<span class="tag">${esc(p.entry.date)}</span>` : '';
  const tags = p.entry.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('');
  return `<div class="chips">${badge}${date}${tags}</div>`;
}

// 首页条目的元信息行：日期 · 栏目 · #标签（纯文本一行）
function metaText(p: PageRef): string {
  const bits = [p.entry.date, p.secLabel].filter(Boolean).map((x) => esc(x));
  if (p.entry.tags.length) bits.push(p.entry.tags.map((t) => `#${esc(t)}`).join(' '));
  return bits.join(' · ');
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
  const bodyHtml = mdToHtml(p.entry.body, p.entry.dir, PAGE_PREFIX);
  const heads: { id: string; text: string }[] = [];
  const hre = /<h([456]) id="(h-\d+)">([\s\S]*?)<\/h\1>/g;
  let hm = hre.exec(bodyHtml);
  while (hm) {
    heads.push({ id: hm[2], text: stripTags(hm[3]) });
    hm = hre.exec(bodyHtml);
  }
  const hasToc = heads.length >= 2;
  const jump = hasToc
    ? `<select class="jump" id="jump" aria-label="跳转到某一节">` +
      heads.map((h, n) => `<option value="${h.id}">${n + 1}. ${esc(h.text)}</option>`).join('') +
      `</select>`
    : '';
  const toc = hasToc
    ? `<aside class="toc"><div class="gt">本文目录<small>${heads.length} 节</small></div>` +
      heads.map((h, n) => `<a href="#${h.id}"><i>${n + 1}</i><span>${esc(h.text)}</span></a>`).join('') +
      `</aside>`
    : '';
  const bar =
    `<header class="bar"><a class="back" href="../${escAttr(basename(OUT_FILE))}">← 返回首页</a>` +
    (hasToc ? SIDE_BTN : '') +
    `<div class="brand">${esc(SITE.name)}</div>` +
    jump +
    `<div class="spacer"></div><button class="btn" id="theme">明/暗</button></header>`;
  const main =
    `<main class="article"><h1>${esc(p.entry.title)}</h1>` +
    chipsRow(p) +
    `<div class="body">${bodyHtml}</div>` +
    (pg.length ? `<nav class="pager">${pg.join('')}</nav>` : '') +
    footer +
    `</main>`;
  return (
    pageHead(`${p.entry.title} · ${SITE.name}`, p.excerpt) +
    bar +
    (hasToc ? `<div class="shell">${toc}${main}</div>` : main) +
    LIGHTBOX +
    TOP_BTN +
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
addEventListener('resize',syncBar);
if(document.fonts&&document.fonts.ready) document.fonts.ready.then(syncBar);
syncBar();
/* 侧栏收起 / 展开：按钮在顶栏，状态记忆在 localStorage（每台设备各记各的） */
const sideBtn=document.getElementById('side-toggle');
function applySide(v){
  document.documentElement.setAttribute('data-side',v);
  try{localStorage.setItem('blog-side',v);}catch(e){}
  if(sideBtn){sideBtn.textContent=v==='0'?'»':'«';sideBtn.title=v==='0'?'展开侧栏':'收起侧栏';}
  syncBar();
}
if(sideBtn){
  applySide(document.documentElement.getAttribute('data-side')==='0'?'0':'1');
  sideBtn.onclick=()=>applySide(document.documentElement.getAttribute('data-side')==='0'?'1':'0');
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
},{passive:true});`;

// 首页：只搜列表（标题 / 标签 / 摘要，正文不在 DOM 里）+ 栏目筛选 + 计数
const JS_HOME = `const items=[...document.querySelectorAll('.item')];
const list=document.getElementById('list');
const q=document.getElementById('q');
const cnt=document.getElementById('cnt');
const empty=document.getElementById('empty');
const secBtns=[...document.querySelectorAll('.fsec,.scat')];
let secMode=null;

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
  clearMarks(list);
  let shown=0;
  items.forEach(it=>{
    let ok=(secMode===null||it.getAttribute('data-sec')===secMode);
    if(ok&&term&&it.textContent.toLowerCase().indexOf(term)<0) ok=false;
    it.classList.toggle('hidden',!ok);
    if(ok) shown++;
  });
  if(empty) empty.classList.toggle('hidden',shown>0);
  cnt.textContent=shown+' / '+items.length+' 篇';
  if(term) markAll(list,term);
}
let timer=null;
q.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(apply,90);});
function setMode(mode){
  secMode=(mode==='all')?null:mode;
  secBtns.forEach(b=>{
    const ds=b.getAttribute('data-sec');
    const on=(ds==='all')?(secMode===null):(ds===secMode);
    b.setAttribute('aria-pressed',String(on));
  });
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
document.querySelectorAll('.tagbtn').forEach(b=>{ b.onclick=()=>{ q.value=b.getAttribute('data-tag')||''; apply(); }; });`;

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
  const heads=[...document.querySelectorAll('.body h4[id],.body h5[id],.body h6[id]')];
  const io=new IntersectionObserver(es=>{
    es.forEach(e=>{ if(e.isIntersecting){
      const id=e.target.id;
      tocLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+id));
      if(jumpSel) jumpSel.value=id;
    }});
  },{rootMargin:'-70px 0px -75% 0px'});
  heads.forEach(h=>io.observe(h));
  if(jumpSel) jumpSel.addEventListener('change',()=>{
    const el=document.getElementById(jumpSel.value);
    if(el) el.scrollIntoView({block:'start'});
  });
}`;

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
  RESOLVE_CACHE.clear();
  const allEntries = nonEmpty.flatMap((s) => s.entries);
  collectImageJobs(allEntries);
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

  let latest = '';
  for (const p of pages) if (p.entry.date && p.entry.date > latest) latest = p.entry.date;

  const counts = nonEmpty.map((s) => `${s.label} ${s.entries.length} 篇`).join('、');
  const small = SITE.tagline || `共 ${total} 篇`;
  const desc =
    SITE.description ||
    `${SITE.name}：${counts || '复盘记录与主题文章'}${latest ? `，最近更新 ${latest}` : ''}。`;
  const footer =
    `<footer>${esc(SITE.name)}${counts ? `，共 ${total} 篇（${counts}）` : ''}${latest ? `，最近更新 ${latest}` : ''}。</footer>`;

  const bar =
    `<header class="bar"><h1>${esc(SITE.name)}<small>${esc(small)}</small></h1>` +
    SIDE_BTN +
    `<div class="spacer"></div>` +
    `<button class="btn fsec" id="f-all" data-sec="all">全部</button>` +
    nonEmpty
      .map((s) => `<button class="btn fsec" id="f-${s.idx}" data-sec="${s.idx}">${esc(s.label)}</button>`)
      .join('') +
    `<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/>` +
    `<path d="M20 20l-3.5-3.5"/></svg>` +
    `<input id="q" type="search" placeholder="搜索标题、标签、摘要…" autocomplete="off">` +
    `<kbd>/</kbd></div>` +
    `<span class="count" id="cnt">${total} / ${total} 篇</span>` +
    `<button class="btn" id="theme">明/暗</button></header>`;

  // 首页左侧栏：置顶 / 栏目 / 标签 / 统计（窄屏隐藏；置顶文章同时在列表顶部带标记）
  const pinned = pages.filter((p) => p.entry.pinned);
  const tagCount = new Map<string, number>();
  for (const pg of pages) for (const t of pg.entry.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20);
  const sidebar =
    `<aside class="side">` +
    (pinned.length
      ? `<div class="sblock"><div class="gt">置顶</div>` +
        pinned.map((p) => `<a class="sitem" href="${escAttr(p.outName)}">${esc(p.entry.title)}</a>`).join('') +
        `</div>`
      : '') +
    `<div class="sblock"><div class="gt">栏目</div>` +
    `<button class="scat" data-sec="all">全部<i>${total}</i></button>` +
    nonEmpty.map((s) => `<button class="scat" data-sec="${s.idx}">${esc(s.label)}<i>${s.entries.length}</i></button>`).join('') +
    `</div>` +
    (topTags.length
      ? `<div class="sblock"><div class="gt">标签</div><div class="stag">` +
        topTags.map(([t, n]) => `<button class="tagbtn" data-tag="${escAttr(t)}">#${esc(t)}<i>${n}</i></button>`).join('') +
        `</div></div>`
      : '') +
    `<div class="sblock sfoot">共 ${total} 篇${latest ? ` · 最近更新 ${esc(latest)}` : ''}</div>` +
    `</aside>`;

  const home =
    pageHead(SITE.name, desc) +
    bar +
    `<div class="shell">` +
    sidebar +
    `<main><ul class="list" id="list">${listed.map(renderListItem).join('\n')}</ul>` +
    (total > 0
      ? `<div class="empty hidden" id="empty">没有匹配的内容</div>`
      : `<div class="empty" id="empty">还没有内容：去 ${CONTENT_DIR}/ 里写第一篇吧</div>`) +
    footer +
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
    writeFileSync(join(PAGES_OUT, `${p.slug}.html`), renderPostPage(pages, i, footer), 'utf8');
  });

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
