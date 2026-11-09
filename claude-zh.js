#!/usr/bin/env node
'use strict';

/**
 * claude-zh —— Claude Code 界面的本地汉化工具
 *
 * 原理：界面文字是打包进 .js 里的字符串字面量。
 * 本工具只替换「完整的、被引号包裹的」字符串字面量，
 * 且跳过对象键名（后面紧跟冒号的）、URL、路径、标识符，
 * 因此不会改变代码结构，只是把显示文本换成中文。
 *
 * 两个落地（target）：
 *   ext  扩展本体  ~/.vscode/extensions/anthropic.claude-code-<ver>
 *   cli  命令行包  <npm 全局前缀>/node_modules/@anthropic-ai/claude-code
 *
 * 注意：聊天卡片里的提问正文（如 Mods 弹窗）由 CLI 进程下发给 webview，
 * 不在扩展目录里，只能靠 cli 落地覆盖。
 *
 * 用法：
 *   node claude-zh.js status        查看两个落地、位置、版本、补丁状态
 *   node claude-zh.js discover      扫描可汉化字符串 → discovered.json
 *   node claude-zh.js scan          扫描界面文案（带上下文，区分 Monaco）→ scan-report.json/txt
 *   node claude-zh.js grep "文字"   在源码里定位某句话落在哪个文件
 *   node claude-zh.js apply         预览将要替换的条目（不写入）
 *   node claude-zh.js apply --yes   真正写入（每个文件独立备份）
 *   node claude-zh.js verify        语法自检已修改的文件
 *   node claude-zh.js restore       从备份完整还原
 *   node claude-zh.js guard         仅在版本变化时重新汉化（可配开机自检）
 *
 * 可选：
 *   --dir "<扩展目录>"   手动指定扩展目录
 *   --roots "<目录>"     额外追加一个落地目录（可重复）
 *   --ext-only / --cli-only  只处理其中一个落地
 *   --wide              grep 时额外搜索 ~/.claude
 *
 * 重要：扩展和 CLI 都会自动更新，更新后补丁随之丢失，需重新 apply。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const EXT_ROOT = path.join(HOME, '.vscode', 'extensions');
const HERE = __dirname;
const DICT_FILE = path.join(HERE, 'zh-dict.json');
const STATE_FILE = path.join(HERE, 'state.json');
const MANIFEST_FILE = path.join(HERE, 'patched.json');
const ROOTS_FILE = path.join(HERE, 'roots.json');
const BACKUP_SUFFIX = '.zhbak';

const args = process.argv.slice(2);
const cmd = args[0] || 'status';
let yes = args.includes('--yes');
const flag = (() => {
  const i = args.indexOf('--dir');
  return i >= 0 ? args[i + 1] : null;
})();
const extraRoots = (() => {
  const out = [];
  args.forEach((a, i) => { if (a === '--roots' && args[i + 1]) out.push(args[i + 1]); });
  return out;
})();
const onlyExt = args.includes('--ext-only');
const onlyCli = args.includes('--cli-only');
const wide = args.includes('--wide');

function die(msg) {
  console.error('\n[错误] ' + msg + '\n');
  process.exit(1);
}

/* ---------- 定位两个落地 ---------- */

function findExtDirs(soft) {
  if (flag) {
    if (!fs.existsSync(flag)) {
      if (soft) return [];
      die('指定的目录不存在：' + flag);
    }
    return [flag];
  }
  if (!fs.existsSync(EXT_ROOT)) {
    if (soft) return [];
    die('找不到扩展目录：' + EXT_ROOT + '\n' +
        '如果 VS Code 装在别处，用 --dir 指定扩展目录，例如：\n' +
        '  node claude-zh.js status --dir "C:\\Users\\你\\.vscode\\extensions\\anthropic.claude-code-2.1.318"');
  }
  const dirs = fs.readdirSync(EXT_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^anthropic\.claude-code-/.test(d.name))
    .map(d => path.join(EXT_ROOT, d.name));
  if (dirs.length === 0) {
    if (soft) return [];
    die('在 ' + EXT_ROOT + ' 下没找到 anthropic.claude-code-* 目录。\n' +
        '确认扩展已装好，或用 --dir 手动指定。');
  }
  dirs.sort((a, b) => {
    const va = (a.match(/-([\d.]+)$/) || [, '0'])[1];
    const vb = (b.match(/-([\d.]+)$/) || [, '0'])[1];
    return vb.localeCompare(va, undefined, { numeric: true });
  });
  // 更新后旧版本目录可能还留着：默认只改最新的那个，免得把旧目录也打上补丁
  return args.includes('--all-versions') ? dirs : dirs.slice(0, 1);
}

/** CLI 包可能装在多个位置，全部列出来，扫描时逐个尝试 */
function findCliDirs() {
  const roots = [];
  if (fs.existsSync(ROOTS_FILE)) {
    try {
      const j = JSON.parse(fs.readFileSync(ROOTS_FILE, 'utf8'));
      for (const p of [].concat(j.cli || [])) if (p) roots.push(p);
    } catch (e) {
      console.warn('[警告] roots.json 格式错误，已忽略：' + e.message);
    }
  }
  for (const p of extraRoots) roots.push(p);

  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  roots.push(path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'));
  roots.push(path.join(HOME, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'));
  roots.push(path.join(HOME, 'AppData', 'Local', 'npm', 'node_modules', '@anthropic-ai', 'claude-code'));

  // 顺着 PATH 里的 claude 启动脚本反推 npm 前缀
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    const first = execFileSync(bin, ['claude'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first) {
      const lower = first.toLowerCase();
      const nm = lower.indexOf('node_modules');
      if (nm > 0) {
        // 直接命中 node_modules\@anthropic-ai\claude-code
        const cut = first.slice(0, nm + 'node_modules'.length);
        roots.push(path.join(cut, '@anthropic-ai', 'claude-code'));
        roots.push(path.join(path.dirname(cut), '@anthropic-ai', 'claude-code'));
      } else {
        // 命中 <prefix>\claude.cmd 这类 shim
        roots.push(path.join(path.dirname(first), 'node_modules', '@anthropic-ai', 'claude-code'));
      }
    }
  } catch { /* 没装命令行版本就算了 */ }

  const seen = new Set();
  const out = [];
  for (const r of roots) {
    const p = path.resolve(r);
    if (seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

function pkgVersion(dir) {
  const pkg = path.join(dir, 'package.json');
  if (fs.existsSync(pkg)) {
    try { return JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '?'; }
    catch { /* 忽略 */ }
  }
  return (dir.match(/-([\d.]+)$/) || [, '?'])[1];
}

/** 统一的落地列表 */
function resolveTargets() {
  const list = [];
  if (!onlyCli) {
    for (const d of findExtDirs(true)) {
      list.push({ kind: 'ext', label: '扩展', dir: d, version: pkgVersion(d) });
    }
  }
  if (!onlyExt) {
    for (const d of findCliDirs()) {
      list.push({ kind: 'cli', label: 'CLI ', dir: d, version: pkgVersion(d) });
    }
  }
  return list;
}

/* ---------- 文件遍历 ---------- */

function walk(dir, opts = {}, out = []) {
  const maxSize = opts.maxSize || 30 * 1024 * 1024;
  const re = opts.pattern || /\.(js|mjs|cjs|html)$/;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    if (e.name.endsWith(BACKUP_SUFFIX)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (opts.skipNodeModules && e.name === 'node_modules') continue;
      walk(p, opts, out);
    } else {
      const okName = opts.allFiles ||
        re.test(e.name) || /^package(\.[\w-]+)?\.json$/.test(e.name);
      if (!okName) continue;
      try {
        const st = fs.statSync(p);
        if (st.size > 0 && st.size < maxSize) out.push(p);
      } catch { /* 忽略 */ }
    }
  }
  return out;
}

function filesOf(target) {
  // CLI 包里混着自己的依赖，只看包本身
  return walk(target.dir, { skipNodeModules: target.kind === 'cli', maxSize: 60 * 1024 * 1024 });
}

/* ---------- 字符串提取 ---------- */

const PATTERNS = [
  /"((?:[^"\\\r\n]){2,400})"/g,
  /'((?:[^'\\\r\n]){2,400})'/g,
  /`((?:[^`\\\r\n]){2,400})`/g,
];

function looksLikeUI(s) {
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  if (/https?:\/\//.test(s)) return false;
  if (/[{}$<>\\[\]()=;:|*^~@#%&]/.test(s)) return false;
  if (/^[\w.-]+\.(js|json|ts|css|md|png|svg|woff2?)$/i.test(s)) return false;
  if (/^[a-z0-9_-]+$/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s)) return false;
  if (/^[a-z][A-Za-z0-9]*$/.test(s)) return false;
  if (/^[A-Za-z]+(\.[A-Za-z]+)+$/.test(s)) return false;
  if (/\b(function|return|const|var|let|import|export|require|undefined|null|typeof|prototype|constructor)\b/.test(s)) return false;
  if (s.length > 400) return false;
  if (/\s/.test(s)) return true;
  return /^[A-Z][a-z]{2,}$/.test(s);
}

function extractStrings(src) {
  const found = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const s = m[1];
      if (!looksLikeUI(s)) continue;
      const after = src.slice(m.index + m[0].length);
      if (/^\s*:/.test(after)) continue;
      found.push(s);
    }
  }
  return found;
}

/* ---------- 备份清单 ---------- */

function loadManifest() {
  if (!fs.existsSync(MANIFEST_FILE)) return { files: [] };
  try {
    const j = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
    return { files: Array.isArray(j.files) ? j.files : [] };
  } catch {
    return { files: [] };
  }
}

function saveManifest(entries) {
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify({ files: entries }, null, 2), 'utf8');
}

/**
 * 每个文件单独一条记录，这样：
 *  - 扩展和 CLI 更新节奏不同，各自的还原互不干扰；
 *  - 目录被更新换掉（版本号变了路径也变），仍能从清单里找到残留备份。
 */
function recordPatched(target, file, count) {
  const m = loadManifest();
  const ent = {
    file,
    backup: file + BACKUP_SUFFIX,
    kind: target.kind,
    dir: target.dir,
    version: target.version,
    count,
    time: Date.now(),
  };
  const i = m.files.findIndex(x => x.file === file);
  if (i >= 0) m.files[i] = ent; else m.files.push(ent);
  saveManifest(m.files);
}

/* ---------- 语法自检 ---------- */

function syntaxOK(file) {
  if (!/\.(js|mjs|cjs)$/i.test(file)) return true;   // json / html 不交给 node 检查
  const tmp = path.join(os.tmpdir(), 'czc-' + process.pid + '-' +
                        Math.random().toString(36).slice(2) + '.mjs');
  try {
    fs.copyFileSync(file, tmp);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
  }
}

/* ---------- 命令 ---------- */

function cmdStatus() {
  const targets = resolveTargets();
  if (!targets.length) die('一个落地都没找到。用 --dir / --roots 指定路径。');

  console.log('');
  for (const t of targets) {
    const files = filesOf(t);
    const patched = files.filter(f => fs.existsSync(f + BACKUP_SUFFIX)).length;
    console.log('  [' + t.kind + '] ' + t.dir);
    console.log('        版本 v' + t.version + ' · ' + files.length + ' 个可扫描文件 · ' +
                (patched ? patched + ' 个已汉化' : '未汉化'));
    console.log('');
  }

  if (!targets.some(t => t.kind === 'cli')) {
    console.log('  ⚠ 没找到 CLI 包。聊天卡片里的提问正文（Mods 那类弹窗）在 CLI 里，' +
                '找不到就永远翻不到。');
    console.log('    确认 npm i -g @anthropic-ai/claude-code 装过，或用 --roots "<路径>" 指定。\n');
  }

  const m = loadManifest();
  const stale = m.files.filter(f => !fs.existsSync(f.file));
  if (m.files.length) {
    console.log('  补丁清单：' + m.files.length + ' 个文件' +
                (stale.length ? '（其中 ' + stale.length + ' 个路径已不存在，多为更新后残留）' : ''));
    console.log('  上次写入：' + new Date(Math.max(...m.files.map(f => f.time || 0))).toLocaleString('zh-CN'));
    console.log('');
  }

  if (fs.existsSync(STATE_FILE)) {
    try {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log('  上次汉化：v' + st.version + '，' + st.count + ' 处替换');
      const now = targets[0].version;
      if (now !== st.version && targets[0].kind === 'ext') {
        console.log('  ⚠ 扩展已从 v' + st.version + ' 更新到 v' + now + '，补丁很可能已失效，建议重新 apply。');
      }
      console.log('');
    } catch { /* 忽略 */ }
  }
}

const NOISE = /^(String|Object|Array|Function|Promise|Set|Map|Event|Pane|Alt|Info|Warning|Edit|Replace|Invoke|Local|Number|Boolean|Symbol|Date|Error|Unknown error|failed validation|Left|Right|Close|Open|Copy|Paste|Undefined|Null|NaN|True|False)$/;

function uiScore(s) {
  let sc = 0;
  if (/\s/.test(s)) sc += 2;
  if (/^[A-Z]/.test(s)) sc += 1;
  if (/[a-z][A-Z]/.test(s)) sc -= 3;
  if (NOISE.test(s)) sc -= 5;
  if (/\b(for|the|to|of|in|is|not|your|this|with|error|cannot|failed)\b/i.test(s)) sc += 1;
  if (s.length > 48) sc -= 1;
  return sc;
}

function cmdDiscover() {
  const targets = resolveTargets();
  if (!targets.length) die('一个落地都没找到。');

  const counter = new Map();
  const where = new Map();
  const perFile = new Map();
  let scanned = 0;

  for (const t of targets) {
    for (const f of filesOf(t)) {
      scanned++;
      const src = fs.readFileSync(f, 'utf8');
      const found = extractStrings(src);
      const rel = path.relative(t.dir, f);
      const tag = t.kind + '/' + rel;
      if (found.length) perFile.set(tag, found.length);
      for (const s of found) {
        counter.set(s, (counter.get(s) || 0) + 1);
        if (!where.has(s)) where.set(s, tag);
      }
    }
  }

  const list = [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([text, count]) => ({ text, count, file: where.get(text) }));

  const outFile = path.join(HERE, 'discovered.json');
  fs.writeFileSync(outFile, JSON.stringify(list, null, 2), 'utf8');

  console.log('\n扫描 ' + scanned + ' 个文件，发现 ' + list.length + ' 条候选界面文字');
  console.log('已写入：' + outFile + '\n');

  console.log('候选文字最集中的文件：');
  const topFiles = [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [f, n] of topFiles) console.log('  ' + String(n).padStart(5) + ' 条  ' + f);
  if (!topFiles.length) console.log('  （没有任何文件命中）');

  const scored = list
    .map(it => ({ ...it, score: uiScore(it.text) }))
    .sort((a, b) => b.score - a.score || b.count - a.count);
  const uiish = scored.filter(it => it.score >= 2);

  const uiFile = path.join(HERE, 'discovered-ui.json');
  fs.writeFileSync(uiFile, JSON.stringify(uiish, null, 2), 'utf8');

  console.log('\n疑似界面文案 ' + uiish.length + ' 条（已写入 discovered-ui.json）：\n');
  for (const it of uiish.slice(0, 60)) {
    console.log('  ' + String(it.count).padStart(4) + '×  [' + it.file + ']  ' + it.text);
  }
  if (uiish.length > 60) console.log('  …… 还有 ' + (uiish.length - 60) + ' 条');
  console.log('');
}

function cmdGrep() {
  const needle = args[1];
  if (!needle) die('用法：node claude-zh.js grep "要查找的原文"');

  const targets = resolveTargets();
  const scanOpts = {
    maxSize: 250 * 1024 * 1024,
    allFiles: true,          // 不限扩展名：CLI 可能是一个编译好的二进制
    skipNodeModules: true,
  };

  const dirs = targets.map(t => t.dir);
  if (wide && fs.existsSync(path.join(HOME, '.claude'))) dirs.push(path.join(HOME, '.claude'));

  const nb = Buffer.from(needle, 'utf8');
  let hits = 0;
  let scanned = 0;
  const big = [];
  console.log('');
  for (const d of dirs) {
    for (const f of walk(d, scanOpts)) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      scanned++;
      if (st.size > 2 * 1024 * 1024) big.push([f, st.size]);
      let buf;
      try { buf = fs.readFileSync(f); } catch { continue; }
      // 前 8KB 有 NUL 就当二进制：照查，但只报偏移不报行号
      const isText = buf.subarray(0, 8192).indexOf(0) < 0;
      let idx = buf.indexOf(nb);
      if (idx < 0) continue;
      while (idx >= 0 && hits < 40) {
        hits++;
        const pos = isText
          ? ':' + buf.subarray(0, idx).toString('utf8').split('\n').length +
            ':' + (idx - buf.lastIndexOf(10, idx - 1))
          : ' @0x' + idx.toString(16);
        console.log('  ' + path.relative(d, f) + pos + (isText ? '' : '  [二进制]'));
        if (hits <= 12) {
          const s = Math.max(0, idx - 70);
          const e = Math.min(buf.length, idx + nb.length + 70);
          const ctx = buf.subarray(s, e).toString('utf8')
            .replace(/[^\x20-\x7e一-龥，。（）：、]/g, ' ')
            .replace(/\s+/g, ' ').trim();
          console.log('      ' + ctx);
        }
        idx = buf.indexOf(nb, idx + nb.length);
      }
      if (hits >= 40) break;
    }
    if (hits >= 40) break;
  }

  if (big.length) {
    console.log('\n  扫描到的较大文件：');
    for (const [f, s] of big.sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log('    ' + (s / 1048576).toFixed(1) + ' MB  ' + f);
    }
  }

  console.log('');
  if (!hits) {
    console.log('  没有命中（共扫了 ' + scanned + ' 个文件）。');
    console.log('  三种可能：');
    console.log('    1. 这句话是运行时下发的（服务端文案），本地改不了；');
    console.log('    2. 它在没被扫描的安装位置，用 --roots 指定后重试；');
    console.log('    3. 文案被拆成多段拼接，改用其中的短片段再查一次。');
    console.log('');
    return;
  }
  console.log('  共 ' + hits + ' 处。有命中就说明可以加进 zh-dict.json。\n');
}

function loadDict() {
  if (!fs.existsSync(DICT_FILE)) die('字典文件不存在：' + DICT_FILE);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DICT_FILE, 'utf8')); }
  catch (e) { die('zh-dict.json 格式错误：' + e.message); }
  const dict = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'string' || !v) continue;
    if (/["'`\\\r\n]/.test(v)) {
      console.warn('[跳过] 译文含引号或反斜杠，会破坏代码：' + k);
      continue;
    }
    if (k.startsWith('~')) {
      if (/[\/<>;=]/.test(v)) {
        console.warn('[跳过] 片段译文含斜杠或运算符，可能破坏语法：' + k);
        continue;
      }
      dict.push([k.slice(1), v, 'partial']);
    } else {
      dict.push([k, v, 'exact']);
    }
  }
  return dict;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cmdApply() {
  const dict = loadDict();
  const targets = resolveTargets();
  if (!targets.length) die('一个落地都没找到。');

  let total = 0;
  const touched = new Set();
  const hits = new Map();
  const rollback = [];

  for (const t of targets) {
    for (const f of filesOf(t)) {
      let src = fs.readFileSync(f, 'utf8');
      const original = src;
      let fileHits = 0;

      for (const [en, zh, kind] of dict) {
        if (kind === 'partial') {
          if (!src.includes(en)) continue;
          const parts = src.split(en);
          const n = parts.length - 1;
          if (!n) continue;
          src = parts.join(zh);
          fileHits += n;
          hits.set(en, (hits.get(en) || 0) + n);
          continue;
        }
        const re = new RegExp(`(["'\`])${escapeRe(en)}\\1`, 'g');
        src = src.replace(re, (m, q, offset, whole) => {
          // 后面紧跟冒号的，多半是对象键名；但 a?"文字":b 这种三元分支要照翻
          const after = whole.slice(offset + m.length, offset + m.length + 40);
          const before = whole[offset - 1] || '';
          if (/^\s*:/.test(after) && !/[?:]/.test(before)) return m;
          fileHits++;
          hits.set(en, (hits.get(en) || 0) + 1);
          return q + zh + q;
        });
      }

      if (src === original) continue;
      total += fileHits;
      touched.add(f);

      if (!yes) continue;

      const bak = f + BACKUP_SUFFIX;
      if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
      fs.writeFileSync(f, src, 'utf8');

      // 写完立刻自检，坏了当场回滚，不留一个打不开的扩展 / CLI
      if (!syntaxOK(f)) {
        fs.copyFileSync(bak, f);
        total -= fileHits;
        touched.delete(f);
        rollback.push(f);
        continue;
      }
      recordPatched(t, f, fileHits);
      console.log('  ✓ [' + t.kind + '] ' + path.relative(t.dir, f) + '  ' + fileHits + ' 处');
    }
  }

  console.log('\n' + (yes ? '已写入' : '预览（未写入）') + '：' +
              total + ' 处替换，涉及 ' + touched.size + ' 个文件\n');

  if (rollback.length) {
    console.log('⚠ 以下文件替换后语法失败，已自动还原：');
    for (const f of rollback) console.log('  - ' + f);
    console.log('  多半是字典里有条目撞上了代码，把该条改成 ~ 片段形式或删掉。\n');
  }

  const hitList = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  if (hitList.length) {
    console.log('命中的条目：');
    for (const [en, n] of hitList.slice(0, 40)) {
      console.log('  ' + String(n).padStart(3) + '×  ' + en + '  →  ' + dict.find(x => x[0] === en)[1]);
    }
    if (hitList.length > 40) console.log('  …… 还有 ' + (hitList.length - 40) + ' 条');
    console.log('');
  }

  const missed = dict.filter(([en]) => !hits.has(en)).map(([en]) => en);
  if (missed.length) {
    console.log('字典里这些条目没命中（可能版本不同、已打包改写，或不在当前落地里）：');
    for (const en of missed.slice(0, 20)) console.log('  - ' + en);
    if (missed.length > 20) console.log('  …… 还有 ' + (missed.length - 20) + ' 条');
    console.log('');
  }

  if (!yes) {
    console.log('确认无误后加 --yes 真正写入：');
    console.log('  node claude-zh.js apply --yes\n');
    return;
  }

  const ext = targets.find(t => t.kind === 'ext') || targets[0];
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    version: ext.version,
    count: total,
    files: [...touched],
    targets: targets.map(t => ({ kind: t.kind, dir: t.dir, version: t.version })),
    time: Date.now(),
  }, null, 2), 'utf8');

  // 机器可读的本次结果，便于事后核对到底哪些条目没命中
  fs.writeFileSync(path.join(HERE, 'last-apply.json'), JSON.stringify({
    time: Date.now(),
    version: ext.version,
    total,
    files: [...touched].map(f => path.basename(f)),
    hits: [...hits.entries()].sort((a, b) => b[1] - a[1]),
    missed,
    rollback,
  }, null, 2), 'utf8');

  console.log('完成。请重启 VS Code（或 Ctrl+Shift+P → Reload Window）查看效果。');
  console.log('不满意可随时还原：node claude-zh.js restore\n');
}

function cmdVerify() {
  const m = loadManifest();
  const targets = resolveTargets();
  const files = new Set();

  for (const e of m.files) if (fs.existsSync(e.file)) files.add(e.file);
  // 清单之外、还留着备份的也一并检查（例如手工改过的文件）
  for (const t of targets) {
    for (const f of filesOf(t)) if (fs.existsSync(f + BACKUP_SUFFIX)) files.add(f);
  }

  if (!files.size) {
    console.log('\n没有找到汉化过的文件（没有 .zhbak 备份）。\n');
    return;
  }

  let bad = 0;
  for (const f of files) {
    if (/\.json$/i.test(f)) {
      try {
        JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log('  ✓ ' + f);
      } catch (e) {
        bad++;
        console.log('  ✗ ' + f + ' JSON 损坏：' + e.message);
      }
      continue;
    }
    if (syntaxOK(f)) {
      console.log('  ✓ ' + f);
    } else {
      bad++;
      console.log('  ✗ ' + f + ' 语法错误');
    }
  }
  console.log('\n' + (bad ? '有 ' + bad + ' 个文件异常，建议执行 restore 还原。' : '全部正常。') + '\n');
}

function cmdRestore() {
  const m = loadManifest();
  const targets = resolveTargets();
  const seen = new Set();
  let n = 0;
  let orphan = 0;

  for (const e of m.files) {
    if (seen.has(e.file)) continue;
    seen.add(e.file);
    if (fs.existsSync(e.backup)) {
      fs.copyFileSync(e.backup, e.file);
      fs.unlinkSync(e.backup);
      n++;
      console.log('  已还原 [' + e.kind + '] ' + e.file);
    } else if (!fs.existsSync(e.file)) {
      orphan++;
    }
  }

  // 清单没覆盖到的备份（老版本留下的）也要清掉
  for (const t of targets) {
    for (const f of filesOf(t)) {
      if (seen.has(f)) continue;
      const bak = f + BACKUP_SUFFIX;
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, f);
        fs.unlinkSync(bak);
        n++;
        console.log('  已还原 [' + t.kind + '] ' + f);
      }
    }
  }

  if (fs.existsSync(MANIFEST_FILE)) fs.unlinkSync(MANIFEST_FILE);
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  console.log('\n共还原 ' + n + ' 个文件。重启 VS Code 生效。');
  if (orphan) {
    console.log('另有 ' + orphan + ' 条记录指向的文件已不存在（更新时被删），备份留在旧目录里，可手动清理。');
  }
  console.log('');
}

function cmdGuard() {
  const targets = resolveTargets();
  if (!targets.length) { console.log('找不到落地，跳过。'); return; }

  const m = loadManifest();
  const problems = [];

  for (const t of targets) {
    const rec = m.files.filter(e => e.dir === t.dir);
    const alive = rec.filter(e => fs.existsSync(e.backup));
    if (!alive.length) {
      problems.push(t.kind + ' 未汉化或版本已变（当前 v' + t.version + '）');
    } else if (rec.some(e => e.version !== t.version)) {
      problems.push(t.kind + ' 已从 v' + rec[0].version + ' 更新到 v' + t.version);
    }
  }

  if (!problems.length) {
    console.log('两个落地版本都未变，补丁完好，无需处理。');
    return;
  }
  console.log('检测到需要重新汉化：');
  for (const p of problems) console.log('  · ' + p);
  yes = true;
  cmdApply();
}

/* ---------- 界面文案扫描（带上下文） ---------- */

// 只认这些会被渲染成文字的属性名，避免把代码标识符扫进来
const UI_PROPS = [
  'children', 'label', 'title', 'placeholder', 'placeHolder', 'tooltip', 'description',
  'message', 'header', 'subtitle', 'caption', 'heading', 'hint', 'notice', 'text',
  'name', 'content', 'buttonText', 'confirmText', 'cancelText', 'emptyText',
  'emptyMessage', 'helpText', 'statusText', 'labelText', 'alt',
  'aria-label', 'aria-description', 'ariaLabel', 'ariaDescription',
];

// 命中这些字样的邻近代码基本是内嵌的 Monaco 编辑器，不是 Claude 自己的界面
const MONACO_HINT = /(monaco|editor\.action\.|StandaloneEditor|contextKey|Keybinding|vs\/editor)/i;

// package.json 里值得翻的字段
const PKG_PATH_OK = /\.(title|description|markdownDescription|label|detail|tooltip)$|\.(enumDescriptions|enumItemLabels)\[\d+\]$|^\.contributes\.(walkthroughs|viewsWelcome)|\.configuration\.[\w-]+\.[\w-]+$/;

// 这些字段是 id / 资源路径 / 命令 id，翻不得
const PKG_PATH_SKIP = /\.(id|media|completionEvents|command|commandPalette|icon|path|when|markdown|group)$/;

function hasCJK(s) { return /[\u4e00-\u9fff]/.test(s); }

/** 某文件里某个 UI 属性上的字符串字面量（含 children:["文字"] 这种数组写法） */
function jsScanOne(src, prop) {
  const out = [];
  const p = escapeRe(prop);
  const ok = s => s.trim() && /[A-Za-z]{2}/.test(s) && !hasCJK(s);

  const re1 = new RegExp(
    '(?:^|[^\\w$.])' + p + '\\s*:\\s*(["\'\\u0060])([^"\'\\u0060\\r\\n]{2,300}?)\\1', 'g');
  let m;
  while ((m = re1.exec(src)) !== null) {
    if (ok(m[2])) out.push({ text: m[2], index: m.index });
  }

  const re2 = new RegExp('(?:^|[^\\w$.])' + p + '\\s*:\\s*\\[([^\\]]{0,800})', 'g');
  while ((m = re2.exec(src)) !== null) {
    const inner = m[1];
    const re3 = /(["'\u0060])([^"'\u0060\r\n]{2,300}?)\1/g;
    let n;
    while ((n = re3.exec(inner)) !== null) {
      if (ok(n[2])) out.push({ text: n[2], index: m.index + 1 + n.index });
    }
  }
  return out;
}

/** 扩展本体里常见的弹窗/状态栏文案：showInformationMessage("…") 之类 */
function scanCalls(src) {
  const re = /(?:show(?:Information|Error|Warning)Message|showQuickPick|showInputBox|setStatusBarMessage|createStatusBarItem)\s*\(\s*(["'\u0060])([^"'\u0060\r\n]{2,300}?)\1/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const s = m[2];
    if (!s.trim() || !/[A-Za-z]{2}/.test(s) || hasCJK(s)) continue;
    out.push({ text: s, index: m.index });
  }
  return out;
}

/** 打包代码里常见的写法：var Xen="一句界面文案"，属性名和提示语都这么存 */
function looksLikeCopy(s) {
  if (s.length < 8 || s.length > 300) return false;
  if (!/[A-Za-z]{2}/.test(s) || hasCJK(s)) return false;
  if (/[{}()\[\]<>;\\|=`$]/.test(s)) return false;      // 含这些基本是代码
  if (s.trim().split(/\s+/).length < 3) return false;   // 至少三个词才像句子
  return /^[A-Z]/.test(s.trim());
}

function scanConsts(src) {
  const re = /([\w$]{1,10})\s*=\s*(["'])([^"'\r\n]{8,300}?)\2/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const s = m[3];
    if (!looksLikeCopy(s)) continue;
    out.push({ text: s, index: m.index });
  }
  return out;
}

function ctxOf(src, idx, n) {  const s = Math.max(0, idx - (n || 90));
  const e = Math.min(src.length, idx + (n || 90));
  return src.slice(s, e).replace(/\s+/g, ' ').trim();
}

// 只把紧挨着 Monaco 内部标识的文字标成 monaco，宁可多报也不漏掉 Claude 自己的界面
function areaOf(src, idx) {
  const s = Math.max(0, idx - 120);
  return MONACO_HINT.test(src.slice(s, idx + 120)) ? 'monaco' : 'ui';
}

function jsonStringsOf(obj, prefix, acc) {
  if (typeof obj === 'string') { acc.push([prefix, obj]); return; }
  if (Array.isArray(obj)) { obj.forEach((v, i) => jsonStringsOf(v, prefix + '[' + i + ']', acc)); return; }
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) jsonStringsOf(obj[k], prefix + '.' + k, acc);
  }
}

function scanTargets(targets, inDict) {
  const byKey = new Map();   // text|prop → item
  let files = 0;

  const add = (file, prop, text, context, area) => {
    const key = text + '\u0000' + prop;
    const hit = byKey.get(key);
    if (hit) { hit.count++; return; }
    byKey.set(key, {
      text, prop, file, area, count: 1,
      context: (context || '').slice(0, 200),
      inDict: inDict.has(text),
    });
  };

  for (const t of targets) {
    for (const f of filesOf(t)) {
      const rel = (t.kind === 'ext' ? 'ext:' : 'cli:') + path.relative(t.dir, f);
      let src;
      try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      files++;

      if (/package\.json$/i.test(f)) {
        let j;
        try { j = JSON.parse(src); } catch { continue; }
        const acc = [];
        jsonStringsOf(j, '', acc);
        for (const [p, s] of acc) {
          if (!PKG_PATH_OK.test(p)) continue;
          if (PKG_PATH_SKIP.test(p)) continue;
          if (s.length < 2 || s.length > 300) continue;
          if (!/[A-Za-z]{2}/.test(s) || hasCJK(s)) continue;
          if (/^(claudeCode|anthropic)\./.test(s)) continue;   // 配置键名
          add(rel, p || 'package.json', s, '', 'ui');
        }
        continue;
      }

      if (!/\.(js|mjs|cjs)$/i.test(f)) continue;
      for (const prop of UI_PROPS) {
        for (const hit of jsScanOne(src, prop)) {
          add(rel, prop, hit.text, ctxOf(src, hit.index, 90), areaOf(src, hit.index));
        }
      }
      for (const hit of scanCalls(src)) {
        add(rel, 'call', hit.text, ctxOf(src, hit.index, 90), 'ui');
      }
      for (const hit of scanConsts(src)) {
        add(rel, 'const', hit.text, ctxOf(src, hit.index, 90), 'ui');
      }
    }
  }

  const items = [...byKey.values()].sort((a, b) =>
    (a.area === b.area ? 0 : a.area === 'ui' ? -1 : 1) ||
    b.count - a.count || a.text.localeCompare(b.text));
  return { items, files };
}

function cmdScan() {
  const targets = resolveTargets();
  if (!targets.length) die('一个落地都没找到。');

  const inDict = new Set(loadDict().map(d => d[0]));
  const { items, files } = scanTargets(targets, inDict);
  const ui = items.filter(i => i.area === 'ui');
  const todo = ui.filter(i => !i.inDict);

  fs.writeFileSync(path.join(HERE, 'scan-report.json'), JSON.stringify({
    time: Date.now(),
    targets: targets.map(t => ({ kind: t.kind, version: t.version, dir: t.dir })),
    scannedFiles: files,
    total: items.length,
    ui: ui.length,
    todo: todo.length,
    items,
  }, null, 2), 'utf8');

  const lines = [];
  lines.push('扫描 ' + files + ' 个文件，UI 属性候选 ' + ui.length + ' 条，其中未收录 ' + todo.length + ' 条');
  lines.push('');
  for (const i of todo) {
    lines.push('[' + i.count + '× ' + i.prop + '] ' + i.text);
    if (i.context) lines.push('      … ' + i.context.replace(/[\u0000-\u001f]/g, ' '));
  }
  fs.writeFileSync(path.join(HERE, 'scan-report.txt'), lines.join('\n'), 'utf8');

  console.log('\n扫描 ' + files + ' 个文件：UI 候选 ' + ui.length + ' 条，未收录 ' + todo.length + ' 条');
  console.log('明细已写入 scan-report.json / scan-report.txt\n');
  const top = todo.slice(0, 70);
  for (const i of top) {
    console.log('  ' + String(i.count).padStart(3) + '× [' + i.prop + '] ' + i.text);
  }
  if (todo.length > top.length) console.log('  …… 还有 ' + (todo.length - top.length) + ' 条\n');
  else console.log('');
}

/** 自检：用内置样例跑一遍扫描和应用逻辑，确认工具本身没坏 */
function cmdSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-zh-test-'));
  fs.mkdirSync(path.join(dir, 'webview'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'anthropic.claude-code', version: '0.0.0',
    contributes: {
      commands: [{ command: 'claude.open', title: 'Claude Code: Open' }],
      configuration: {
        title: 'Claude Code',
        properties: {
          'claudeCode.autosave': { description: 'Automatically save files before Claude edits them.' },
        },
      },
      walkthroughs: [{ title: 'Get started with Claude Code', steps: [{ title: 'Sign in' }] }],
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'webview', 'index.js'), [
    'var a={className:"x",children:"New session from this folder"};',
    'var b={"aria-label":"Collapse session manager",title:"Collapse session manager"};',
    'var c={placeholder:"Ask Claude anything",detail:"Last active 2 hours ago"};',
    'var d={children:["Run in background"]};',
    'var e={children:"打开新标签页"};',
    'var f={label:"Go to Definition",id:"editor.action.revealDefinition"};',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'extension.js'),
    'vscode.window.setStatusBarMessage("Waiting for Claude");');

  const inDict = new Set(['Session manager']);
  const { items } = scanTargets([{ kind: 'ext', dir, version: '0.0.0' }], inDict);
  const by = new Map(items.map(i => [i.text, i]));

  const checks = [
    ['子文案 children', by.has('New session from this folder')],
    ['aria-label', by.has('Collapse session manager')],
    ['placeholder', by.has('Ask Claude anything')],
    ['数组子文案', by.has('Run in background')],
    ['package.json 命令标题', by.has('Claude Code: Open')],
    ['package.json 配置描述', by.has('Automatically save files before Claude edits them.')],
    ['package.json 引导步骤', by.has('Sign in')],
    ['状态栏文案', by.has('Waiting for Claude')],
    ['中文不重复收录', !by.has('打开新标签页')],
    ['Monaco 文案被标出', by.has('Go to Definition') && by.get('Go to Definition').area === 'monaco'],
  ];

  let bad = 0;
  console.log('\n自检样例目录：' + dir + '\n');
  for (const [name, ok] of checks) {
    if (!ok) bad++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name);
  }

  // 应用逻辑：译文不能破坏语法、写坏要能回滚
  const f = path.join(dir, 'webview', 'index.js');
  const dictFile = path.join(dir, 'zh-dict.json');
  fs.writeFileSync(dictFile, JSON.stringify({
    'New session from this folder': '在此文件夹中新建会话',
    'Collapse session manager': '折叠会话管理',
    'Ask Claude anything': '向 Claude 提问',
  }, null, 2));
  const before = fs.readFileSync(f, 'utf8');
  let text = before;
  for (const [en, zh] of Object.entries(JSON.parse(fs.readFileSync(dictFile, 'utf8')))) {
    text = text.split('"' + en + '"').join('"' + zh + '"');
  }
  fs.writeFileSync(f, text);
  const okSyntax = syntaxOK(f);
  fs.writeFileSync(f, before);
  checks.push(['应用后语法正常', okSyntax]);
  if (!okSyntax) bad++;
  console.log('  ' + (okSyntax ? '✓' : '✗') + ' 应用后语法正常');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (bad ? bad + ' 项未通过，工具需要修。\n' : '自检全部通过。\n'));
  if (bad) process.exit(1);
}

/* ---------- 入口 ---------- */

const COMMANDS = {
  status: cmdStatus,
  discover: cmdDiscover,
  scan: cmdScan,
  selftest: cmdSelftest,
  grep: cmdGrep,
  apply: cmdApply,
  verify: cmdVerify,
  restore: cmdRestore,
  guard: cmdGuard,
};

if (!COMMANDS[cmd] || cmd === '--help' || cmd === '-h') {
  console.log(`
claude-zh —— Claude Code 界面汉化工具（扩展 + CLI）

  node claude-zh.js status        查看两个落地、位置、版本、补丁状态
  node claude-zh.js discover      扫描候选字符串 → discovered.json
  node claude-zh.js scan          扫描界面文案（带上下文）→ scan-report.json/txt
  node claude-zh.js selftest      跑内置样例，确认工具本身没坏
  node claude-zh.js grep "文字"   定位某句话在哪个文件（判断能不能翻）
  node claude-zh.js apply         预览替换（不写入）
  node claude-zh.js apply --yes   写入并备份（写完自动做语法自检，坏了当场回滚）
  node claude-zh.js verify        语法自检
  node claude-zh.js restore       还原全部
  node claude-zh.js guard         仅当版本变化才重新汉化（可配开机自检）

可选：
  --dir "<扩展目录>"       手动指定扩展目录
  --roots "<目录>"         追加一个落地目录（可重复）
  --ext-only / --cli-only  只处理其中一个落地
  --wide                   grep 时额外搜索 ~/.claude
`);
  process.exit(0);
}

COMMANDS[cmd]();
