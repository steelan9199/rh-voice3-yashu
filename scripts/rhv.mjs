#!/usr/bin/env node
/**
 * rhv — RunningHub 文生语音（声音设计 / 声音克隆 / 声音导演 / 语音转文字）
 *
 * design   : 台词 + 音色描述        → 音频（凭空造一个声音）
 * clone    : 台词 + 参考音频        → 音频（照这个人念；默认内置 Whisper 转写文稿）
 * director : 台词 + 参考音频 + 指令 → 音频（人不变，说话方式按指令改）
 * stt      : 参考音频               → 文字稿（把转写结果拿回来看一眼有没有错字）
 *
 * clone / director 给了 --ref-text 就自动切到「带参考文稿」的工作流：
 * reference_text 由手写文本节点直接给，跳过 Whisper，从源头消灭转写错字。
 *
 * 零依赖，Node 18+（内置 fetch / FormData / Blob）。
 * 密钥（顺序固定）：技能根目录 RUNNINGHUB_API_KEY 文件 → 环境变量 RUNNINGHUB_API_KEY。
 *
 * 设计原则：模式与节点坐标只在本文件写一次（MODES），SKILL.md 不重复列。
 * 工作流改版后跑 `node scripts/rhv.mjs wf all` 当场核对，不一致就以实际为准改 MODES。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

/* ══════════ 一、工作流坐标（唯一真相源） ══════════ */
const API = 'https://www.runninghub.cn/openapi/v2';
const WF_ENDPOINT = 'https://www.runninghub.cn/api/openapi/getJsonApiFormat';
const UPLOAD_ENDPOINT = `${API}/media/upload/binary`;

/**
 * 每个模式挂 1–2 个「变体」。变体 = 一条工作流 + 它自己的节点坐标 + 必填项。
 * 为什么不定成两套模式：对用户来说「带不带参考文稿」不是另一种活，是同一个活的两种输入，
 * 所以用 --ref-text 的存在与否自动选变体，模式名不变。
 */
const MODES = {
  design: {
    variants: [{
      wf: '2114811789174202370',
      nodes: { text: ['8', 'prompt'], voice: ['9', 'prompt'], seed: ['3', 'seed'] },
      need: ['text', 'voice'],
    }],
  },
  clone: {
    variants: [
      {
        // 内置 Whisper 自动转写参考文稿（省事，但错字会跟着进去）
        wf: '2115491075229048834',
        nodes: {
          text: ['8', 'prompt'], ref: ['59', 'audio'], seed: ['3', 'seed'],
          cfg: ['56', 'cfg_scale'], instruction: ['56', 'instruction'],
        },
        need: ['text', 'ref'],
      },
      {
        // 带参考文稿：reference_text 改由 #62 手写文本给，图里没有 Whisper 节点
        wf: '2115780588685848577',
        nodes: {
          text: ['8', 'prompt'], ref: ['59', 'audio'], seed: ['3', 'seed'],
          cfg: ['56', 'cfg_scale'], instruction: ['56', 'instruction'],
          refText: ['62', 'prompt'],
        },
        need: ['text', 'ref'],
      },
    ],
  },
  director: {
    variants: [
      {
        wf: '2115502278030487553',
        nodes: {
          text: ['8', 'prompt'], direction: ['62', 'prompt'], ref: ['59', 'audio'],
          seed: ['3', 'seed'], cfg: ['63', 'cfg_scale'],
        },
        need: ['text', 'ref', 'direction'],
      },
      {
        // 带参考文稿：director 那边方向节点仍是 #62，文稿单独挪到 #64
        wf: '2115784962552188930',
        nodes: {
          text: ['8', 'prompt'], direction: ['62', 'prompt'], ref: ['59', 'audio'],
          seed: ['3', 'seed'], cfg: ['63', 'cfg_scale'],
          refText: ['64', 'prompt'],
        },
        need: ['text', 'ref', 'direction'],
      },
    ],
  },
  stt: {
    variants: [{
      wf: '2115786028920430593',
      kind: 'text',
      nodes: { ref: ['59', 'audio'] },
      need: ['ref'],
    }],
  },
  /**
   * 多角色对白：一次提交，整段对话出一份音频。**2–4 人自适应**（单人走 clone/design/director）。
   *
   * 这张图（2115846246844952578）的 #33–#36 四个 Speaker 槽全部接了线，但
   * `BreezeTTS2MultiSpeaker` 的 speaker_1..4 本身是 **optional** 输入，源码里：
   *   speakers = [kwargs.get(f"speaker_{i}") ...];  if speaker is None: continue
   * 且真正干活的只有 `used = set(turn_keys)`（剧本里开过口的角色）——
   * 参考音频编码 `for key in used`、生成 `for index,(name,line) in enumerate(turns)`，
   * **没开口的槽既不编码参考音频也不生成**。
   *
   * 所以少给角色时不用另建图：把多余的槽填成「合法但不出场」的占位角色即可
   * （名字唯一 + 一条 instruction，防止 prepare 阶段撞
   *  `Duplicate speaker name` / `no reference audio, so the instruction designs the voice`）。
   *
   * 图上的 auto_transcribe_if_empty 已于 2026-10-30 全部改成 false（平台侧手动关）。
   * 但脚本仍然显式推 false —— 图被人改回去、或换一张同构的图时，这条是唯一的兜底。
   */
  dialogue4: {
    variants: [{
      wf: '2115846246844952578',
      kind: 'audio',
      nodes: {
        script: ['37', 'prompt'],
        seed: ['21', 'seed'],
        pause: ['21', 'pause_between_speakers'],
      },
      slots: ['33', '34', '35', '36'],
      speakerFields: ['name', 'audio', 'reference_text', 'auto_transcribe_if_empty', 'instruction', 'cfg_scale'],
      need: ['script'],
    }],
  },
};

// 旧名 dialogue 是别名，同一个图同一个执行器；文档统一写 dialogue4。
MODES.dialogue = MODES.dialogue4;

const REF_SOFT_LIMIT = 20; // 秒：超过后克隆相似度下降
const REF_BUDGET_LIMIT = 60; // 秒：不是模型上限，是 token 预算——参考越长越挤台词（MAX_SEQ_LEN 2048 共用，音频 12.5 token/秒）
const SEG_LIMIT = 150;     // 字：超过后后半段语调会飘
// 硬截断线（2026-10-30 实测八组）：超过就不是「念得飘」，是结尾被静默吞掉且**不报错**。
// 墙其实按「音频秒数」算，字数只是代理——同一份 439 字，语速 4.53 的那次 96.88s 念完，
// 语速 3.89 的那次 112.72s 就少最后一个字。所以这里取保守值当告警线，不当硬指标。
// design 无参考：≈660 字（实测 613 完整、770 只念到 660）。
// 带 20s 参考：参考先占 250 token，实测 613 字停 432–457、439 字在墙边（丢 1 个字）。
const HARD_CUT_DESIGN = 650;
const HARD_CUT_REF = 400;
const DEFAULT_POLL = 1500;
const DEFAULT_TIMEOUT = 600;

/* ══════════ 二、小工具 ══════════ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (code, msg) => { console.error(`\n[rhv] ${msg}\n`); process.exit(code); };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[k] = true; continue; }
    out[k] = next; i += 1;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const str = (v) => (typeof v === 'string' ? v.trim() : '');
/**
 * 数值参数读取：裸 flag（`--trim`、`--target`、`--tail`、`--timeout`）在 parseArgs 里是布尔 true，
 * 直接 Number(true) 会得到 1 —— 于是「不带值=用默认」被悄悄读成「=1」：
 *   --trim  → 把参考音频截到 1 秒（克隆直接废掉）
 *   --target→ 目标响度 1 LUFS
 *   --timeout → 1 秒超时（任务照跑照扣费，本地先放弃）
 * 统一走这里：裸 flag 返回 NaN，让各处的「没给/非法 → 用默认值」兜底生效。
 */
const num = (v) => (v === true || v === undefined || v === '' ? NaN : Number(v));

// 这几个判断在 main / runStt / runDialogue 里各用过一次，只写一份免得改漏
const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|ogg|aac|opus)$/i;
const OUT_EXT_RE = /\.(flac|mp3|wav|m4a|ogg)(?=\?|$)/i;
const defaultOutDir = () => resolve(str(ARGS.out) || './voice-out');
const outExtOf = (url, fallback) => (String(url).match(OUT_EXT_RE) || [null, fallback])[1].toLowerCase();

/* ══════════ 三、密钥 ══════════ */
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KEY_FILE = join(SKILL_ROOT, 'RUNNINGHUB_API_KEY');
const CACHE_FILE = join(SKILL_ROOT, '.cache', 'uploads.json');

const looksLikeKey = (v) => /^[A-Za-z0-9_-]{16,}$/.test(v) && !/[\u4e00-\u9fa5]/.test(v);

/**
 * 输入文件路径解析：相对路径先按当前目录找，找不到再退回技能根目录。
 *
 * 为什么要退回：cast.json 里的 `ref` 写的是 `assets/refs/...`，而 `resolve()` 只按 cwd 解析。
 * 本机一直是 `cd 技能目录 && node scripts/rhv.mjs`，所以从没暴露过；
 * 但把技能文件夹给别人、或从别的项目目录用绝对路径调脚本时，参考音频会全部"不存在"。
 * 注意：只管**输入**（参考音频 / cast / --in），输出目录仍按 cwd，别把产物写到技能目录里。
 */
function resolveInput(p) {
  const s = String(p ?? '').trim();
  if (!s) return '';
  if (isAbsolute(s)) return resolve(s);
  const byCwd = resolve(s);
  if (existsSync(byCwd)) return byCwd;
  const byRoot = resolve(SKILL_ROOT, s);
  return existsSync(byRoot) ? byRoot : byCwd;
}

function resolveKey() {
  // 顺序固定：技能根目录文件优先，环境变量兜底。
  // 文件优点的场景很实在——同一台机器上不同项目/不同账号，改文件比改全局环境变量安全。
  if (existsSync(KEY_FILE)) {
    // 空文件是「模板」：分享出去让人填密钥用的，不该报错也不该刷警告。
    const lines = readFileSync(KEY_FILE, 'utf8').split(/\r?\n/)
      .map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    const hit = lines
      .map((s) => s.replace(/^RUNNINGHUB_API_KEY\s*=\s*/i, '').replace(/^["'<]|["'>]$/g, '').trim())
      .find(looksLikeKey);
    if (hit) return { key: hit, from: `文件 ${KEY_FILE}` };
    // 只有「真写了东西但格式不对」才值得警告；空模板静默跳过。
    if (lines.length) console.warn(`[rhv] ${KEY_FILE} 里有内容但不像有效密钥（应为 16 位以上字母数字），改用环境变量`);
  }
  const env = str(process.env.RUNNINGHUB_API_KEY);
  if (env && looksLikeKey(env)) return { key: env, from: '环境变量 RUNNINGHUB_API_KEY' };
  return null;
}

function keyHelp() {
  return [
    '没找到可用的 RunningHub 密钥。二选一：',
    `  ① 写进技能根目录的文件（优先）：${KEY_FILE}`,
    '     只放密钥一行，形如 32 位字符串；# 开头当注释',
    '  ② 或设环境变量 RUNNINGHUB_API_KEY=<32位密钥>',
    '  没有账号：https://www.runninghub.cn?inviteCode=kol01-rh035 （填邀请码 kol01-rh035 领 1000 RH 币）',
    '  密钥在「个人中心 → API 控制台」生成。',
  ].join('\n');
}

/* ══════════ 四、HTTP（网络抖动自动重试） ══════════ */
async function req(url, init, label) {
  let last;
  for (let i = 1; i <= 4; i += 1) {
    try { return await fetch(url, init); } catch (e) {
      last = e;
      if (i < 4) { console.warn(`[rhv] ${label} 第 ${i} 次失败（${e.cause?.code || e.message}），重试…`); await sleep(1200 * i); }
    }
  }
  // Node 的 fetch 不读 HTTP_PROXY/HTTPS_PROXY，直连被代理挡回来就是 ECONNRESET，
  // 四轮重试必然全灭。这种失败重试没有意义，直接把人指向开关，别让他去查网络。
  if (!process.env.NODE_USE_ENV_PROXY) {
    throw new Error(`${last?.cause?.code || last?.message}｜本机 Node 不走系统代理，命令前加 NODE_USE_ENV_PROXY=1 再跑`);
  }
  throw last;
}

async function post(path, body, key) {
  const r = await req(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }, `POST ${path}`);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 平台偶尔回非 JSON */ }
  return { ok: r.ok, status: r.status, json, text };
}

/* ══════════ 五、素材：时长 / 裁剪 / 上传 ══════════ */
function probeSeconds(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const n = Number.parseFloat(String(out).trim());
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function trimRef(file, seconds) {
  const out = join(tmpdir(), `rhv_ref_${Date.now()}${extname(file) || '.mp3'}`);
  try {
    execFileSync('ffmpeg', ['-y', '-i', file, '-t', String(seconds), '-ac', '1', out], { stdio: 'ignore' });
    return existsSync(out) ? out : null;
  } catch { return null; }
}

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function writeCache(c) {
  try { mkdirSync(dirname(CACHE_FILE), { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch { /* 缓存只是省流量，写不进不影响主流程 */ }
}

/** 本地文件 → RH fileName。同一内容 18 小时内不重复上传。
 *
 * 缓存键 = 账号指纹 + 内容 sha。为什么不是纯内容 sha：上传回来的 fileName 是**账号内的**路径，
 * 换一个 RunningHub 账号拿同一份音频，旧 fileName 指向的其实是别人的文件（而且可能已过期）。
 * 把技能文件夹连 .cache 一起给别人时，纯 sha 的缓存会让对方第一次运行就用上我的文件名 —— 报错还很难看懂。
 */
async function uploadAudio(file, key) {
  const buf = readFileSync(file);
  const sha = createHash('sha256').update(buf).digest('hex');
  const acct = createHash('sha256').update(str(key)).digest('hex').slice(0, 12);
  const ck = `${acct}:${sha}`;
  const cache = readCache();
  const hit = cache[ck];
  if (hit && Date.now() - hit.at < 18 * 3600 * 1000) return { fileName: hit.fileName, cached: true };

  const fd = new FormData();
  fd.append('file', new Blob([buf]), basename(file));
  const r = await req(UPLOAD_ENDPOINT, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd }, '上传参考音频');
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 见下 */ }
  const fileName = j?.data?.fileName;
  if (!fileName) throw new Error(`E_UPLOAD 上传没返回 fileName：${text.slice(0, 200)}`);
  cache[ck] = { fileName, at: Date.now() };
  for (const [k, v] of Object.entries(cache)) if (Date.now() - v.at > 24 * 3600 * 1000) delete cache[k];
  writeCache(cache);
  return { fileName, cached: false, type: j?.data?.type };
}

/* ══════════ 六、文本体检 ══════════ */
/* 文化强标签：训练数据里有大量对应样本，三个字就够，比四十字的长描述更准（2026-10-30 实测：
   「霸总音」3 字 vs 40 字四层写法，盲听三字更像）。命中时不报「太短」，改报一条 info。
   注意：这里只影响提示，不影响提交内容。 */
const STRONG_TAGS = ['霸总', '播音腔', '纪录片旁白', '纪录片', '客服', '电台', '深夜档', '有声书', '评书', '新闻联播', '广告腔'];

// 返回 [{level:'warn'|'info', msg}]，调用处按 level 决定加不加 ⚠
function checkVoice(v) {
  const w = [];
  const tag = STRONG_TAGS.find((t) => v.includes(t));
  if (v.length < 12) {
    if (tag) w.push({ level: 'info', msg: `「${tag}」是文化强标签，只能定方向，别单独用（实测同一句两个种子：一版像、一版只是年龄相仿）。后面补上年龄/音区/语速/尾音再跑，例如「${tag}，三十二岁男声，尾音往下压」` });
    else w.push({ level: 'warn', msg: `音色描述只有 ${v.length} 字，太短，出来是通用款。写满四层：谁在说 / 声音长什么样 / 怎么演 / 像什么` });
  }
  if (/^(男声|女声|男|女|young|old)$/i.test(v)) w.push({ level: 'warn', msg: '音色描述是枚举词，这模型不吃枚举，吃自然语言描述句' });
  if (!tag && !/\d|岁|男|女/.test(v)) w.push({ level: 'warn', msg: '描述里没有年龄或性别，模型只能瞎猜' });
  return w;
}

function checkDirection(d) {
  const w = [];
  if (d.length < 10) w.push(`导演指令只有 ${d.length} 字，太笼统。指令没写到的维度会照抄参考音频（口音/鼻音/停顿/句尾），写密才改得动`);
  if (!/语速|速|快|慢|情绪|语气|音|停顿|口音|气息|音量/.test(d)) w.push('指令里没有任何可执行的维度（语速/音量/情绪/气息/口音/停顿），多半只改得动一层');
  return w;
}

/* ══════════ 七、提交 → 轮询 → 下载 ══════════ */
function allUrls(body) {
  const urls = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === 'string') { if (/^https?:\/\//.test(v)) urls.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      if (typeof v.fileUrl === 'string') urls.push(v.fileUrl);
      if (typeof v.url === 'string') urls.push(v.url);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return urls;
}

function pickAudioUrl(body) {
  const urls = allUrls(body);
  return urls.find((u) => /\.(flac|mp3|wav|m4a|ogg)(\?|$)/i.test(u)) || urls[0] || null;
}

/** stt 的产物是 #65 SaveText 存的 txt，别拿 pickAudioUrl 去撞。 */
function pickTextUrl(body) {
  return allUrls(body).find((u) => /\.txt(\?|$)/i.test(u)) || null;
}

async function legacyOutputs(taskId, key) {
  try {
    const r = await req('https://www.runninghub.cn/task/openapi/outputs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key, taskId }),
    }, '旧版 outputs');
    return pickAudioUrl(JSON.parse(await r.text()));
  } catch { return null; }
}

async function submit(wf, nodes, key, dryRun) {
  const payload = { addMetadata: true, nodeInfoList: nodes, instanceType: 'default', usePersonalQueue: 'false' };
  if (dryRun) { console.log(JSON.stringify({ url: `${API}/run/workflow/${wf}`, payload }, null, 2)); return null; }
  const codeOf = (r) => String(r.json?.errorCode ?? r.json?.code ?? '');
  const ok = (r) => Boolean(r.json && (r.json.taskId || r.json.data?.taskId));
  let res = await post(`/run/workflow/${wf}`, payload, key);
  // 421 = 账号并发已满（实测额度就是 1 条，两条同发必有一条被拒）。退避重试，别把整条任务判死。
  const backoff = [10000, 20000, 30000];
  for (let attempt = 0; !ok(res) && attempt < backoff.length; attempt += 1) {
    const queued = codeOf(res) === '421';
    const wait = queued ? backoff[attempt] : 3000;
    console.warn(queued
      ? `[rhv] 421 并发已满，等 ${wait / 1000}s 重试（${attempt + 1}/${backoff.length}）`
      : '[rhv] 提交没拿到 taskId，等 3s 重试一次');
    await sleep(wait);
    res = await post(`/run/workflow/${wf}`, payload, key);
    if (!queued) break;
  }
  const taskId = res.json?.taskId || res.json?.data?.taskId;
  if (!taskId) throw new Error(`E_SUBMIT ${res.status} ${(res.text || '').replace(/\s+/g, ' ').slice(0, 300)}`);
  return taskId;
}

async function waitFor(taskId, key, { pollMs, timeoutS }) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    await sleep(pollMs);
    let q;
    try { q = await post('/query', { taskId }, key); } catch (e) { continue; }
    const j = q.json || {};
    const body = j.data && j.data.status ? j.data : j;
    const status = body.status || j.status;
    if (status === 'SUCCESS') return body;
    if (status && !['QUEUED', 'RUNNING', 'CREATED', 'PENDING'].includes(status)) {
      throw new Error(`E_FAILED ${body.errorMessage || j.msg || status}`);
    }
    process.stdout.write('.');
  }
  throw new Error(`E_TIMEOUT 超过 ${timeoutS}s 没出结果。先别重跑（可能已生成、只是没取回），去网页看任务记录`);
}

async function download(url, file) {
  const r = await req(url, {}, '下载产物');
  if (!r.ok) throw new Error(`E_DOWNLOAD ${r.status}：${url.slice(0, 120)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
  return buf.length;
}

function flacInfo(file) {
  try {
    const buf = readFileSync(file);
    if (buf.slice(0, 4).toString('latin1') !== 'fLaC') return { seconds: probeSeconds(file), bytes: buf.length };
    const b = buf.slice(18, 26);
    if (b.length < 8) return { seconds: null, bytes: buf.length };
    const sr = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
    const total = (b[3] & 0x0f) * 2 ** 32 + ((b[4] << 24) >>> 0) + (b[5] << 16) + (b[6] << 8) + b[7];
    return { seconds: sr && total ? total / sr : null, bytes: buf.length };
  } catch { return { seconds: null, bytes: 0 }; }
}

function toMp3(file) {
  const out = file.replace(/\.(flac|wav)$/i, '.mp3');
  try {
    execFileSync('ffmpeg', ['-y', '-i', file, '-codec:a', 'libmp3lame', '-b:a', '192k', out], { stdio: 'ignore' });
    return existsSync(out) ? out : null;
  } catch { return null; }
}

/* ══════════ 八、wf：取工作流信息 + 核对坐标 ══════════ */
async function wfCommand(target) {
  const keyInfo = resolveKey();
  if (!keyInfo) die(3, keyHelp());
  console.log(`[rhv] 密钥来源：${keyInfo.from}`);

  // 一个模式可能挂两个变体（自动转写 / 带文稿），核对时两个都要看
  const plan = [];
  const isRawId = /^\d{6,}$/.test(target || '');
  const labelOf = (name, variants, v, i) => (variants.length > 1 ? `${name}${i ? '·带文稿' : '·自动转写'}` : name);
  if (isRawId) {
    plan.push({ label: target, wfId: target, variant: null });
  } else if (target === 'all' || !target) {
    // dialogue 是 dialogue4 的别名（同一个对象），按 workflowId 去重，
    // 否则 all 会对着同一张图查两遍、还把它列成两段。
    const seenWf = new Set();
    for (const [name, m] of Object.entries(MODES)) {
      m.variants.forEach((v, i) => {
        if (seenWf.has(v.wf)) return;
        seenWf.add(v.wf);
        plan.push({ label: labelOf(name, m.variants, v, i), wfId: v.wf, variant: v });
      });
    }
  } else {
    const m = MODES[target];
    if (!m) die(2, `${target} 既不是模式名（${Object.keys(MODES).join('/')}），也不是 workflowId`);
    m.variants.forEach((v, i) => plan.push({ label: labelOf(target, m.variants, v, i), wfId: v.wf, variant: v }));
  }

  for (const { label, wfId, variant } of plan) {
    const r = await req(WF_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyInfo.key}` },
      body: JSON.stringify({ apiKey: keyInfo.key, workflowId: wfId }),
    }, 'getJsonApiFormat');
    const j = await r.json();
    if (j.code !== 0) die(3, `RH 返回 code=${j.code} msg=${j.msg || j.message}（workflowId 错 / 不属本账号 / 没在网页跑过）`);
    let p;
    try { p = JSON.parse(j.data.prompt); } catch { die(3, 'data.prompt 不是合法 JSON'); }

    console.log(`\n== ${label} ${wfId} ==`);
    for (const id of Object.keys(p).sort((a, b) => Number(a) - Number(b))) {
      console.log(`#${id}\t${p[id].class_type}\t${JSON.stringify(p[id].inputs).slice(0, 160)}`);
    }
    if (!variant) continue;
    console.log('-- 坐标核对（MODES 里的接线 vs 实际图）');
    let bad = 0;
    for (const [k, [nid, field]] of Object.entries(variant.nodes)) {
      const node = p[String(nid)];
      const ok = node && field in (node.inputs || {});
      if (!ok) bad += 1;
      console.log(`${ok ? 'OK ' : 'BAD'} ${k} → ${nid}.${field}${ok ? '' : `（节点${node ? '在' : '不在'}，字段缺失）`}`);
    }
    if (bad) console.log(`⚠ ${bad} 条接线失效：以实际图为准改 scripts/rhv.mjs 的 MODES，再跑一次核对`);
  }
}

/* ══════════ 九、帮助 ══════════ */
function help() {
  console.log(`rhv · RunningHub 文生语音（设计 / 克隆 / 导演 / 转写 / 多角色 / 场景音 / 响度）

  node scripts/rhv.mjs design   --text "台词" --voice "音色描述"
  node scripts/rhv.mjs clone    --text "台词" --ref 参考音频.mp3 [--ref-text "参考文稿"]
  node scripts/rhv.mjs director --text "台词" --ref 参考音频.mp3 --direction "导演指令" [--ref-text "参考文稿"]
  node scripts/rhv.mjs stt      --ref 参考音频.mp3                     只转文字，不出音频
  node scripts/rhv.mjs dialogue4 --cast cast.json                      多角色对话（2–4 人），一次出整段
  node scripts/rhv.mjs wf [design|clone|director|dialogue4|stt|all|<workflowId>]  看工作流节点 + 核对坐标
  node scripts/rhv.mjs upload <音频>                                    只上传，打印 fileName
  node scripts/rhv.mjs lufs <音频…>                                     匹配响度（对齐 assets/loudness-standard.mp3）
  node scripts/rhv.mjs fx --in 干声.flac --preset 电话听筒 [--mix 0.4]    场景音：给一段干声套房间/通信音色（全本地）
  node scripts/rhv.mjs fx --list                                        列出全部场景预设

公共选项：
  --out <目录>     产物目录，默认 ./voice-out
  --name <前缀>    文件名前缀，默认取模式名
  --seed <整数>    固定种子（不给就随机并打印）
  --mp3            本机有 ffmpeg 就顺手转一份 mp3
  --text-file <txt> / --voice-file <txt> / --direction-file <txt>
                   从文件读长文本（带引号、带换行的都写这里），分别对应
                   --text / --voice / --direction；同名参数同时给时内联的那个赢
  --trim [秒]      参考音频超过 ${REF_SOFT_LIMIT}s 时先截到 ${REF_SOFT_LIMIT}s（需 ffmpeg）；
                   超 ${REF_BUDGET_LIMIT}s 且没给 --trim 直接拒绝（退出码 2、不发请求）；
                   给了 --trim 就先裁再判，裁完仍超才拒。${REF_BUDGET_LIMIT}s 是节点层硬上限
  --dry-run        只打印请求体，不提交不花钱
  --poll <毫秒>    轮询间隔，默认 ${DEFAULT_POLL}，下限 500
  --timeout <秒>   轮询上限，默认 ${DEFAULT_TIMEOUT}
  --json           结果以 JSON 打印

模式专属：
  --voice       design   音色描述（四层写法，见 references/写法.md）
  --ref         clone/director/stt  参考音频：10–20s、干净、单人、无配乐、不循环
  --ref-text    clone/director      参考文稿：参考音频里逐字说的话（含重复和语气词）。
                给了就切到「带参考文稿」的工作流，跳过 Whisper，转写错字从源头消失
  --ref-text-file  同上，从 txt 文件读（长文稿用这个）
  --direction   director 导演指令（写密：语速/音量/情绪/气息/口音/停顿）
  --cfg         clone 默认 1（照抄参考）；往上调≈偷一点语气变化。director 默认 4
  --instruction clone 高级：节点 56 的 instruction，默认空，一般不用碰

dialogue4 专属（多角色对话，2–4 人自适应，模板 assets/casts/模板-两人对话.json / 模板-四人对话.json）：
  --cast <cast.json>  角色表 + 剧本，一次喂进去。结构：
                      {"pause":0.3,"seed":N,
                       "speakers":[{"name":"韩立","ref":"a.mp3","ref_text":"逐字稿","cfg":1}],
                       "script":[{"speaker":"韩立","text":"台词"}]}
  --name <前缀>       产物文件名，默认 dialogue
  --no-preflight      跳过提交前的图预检（只在确认平台侧问题、非要硬跑时用）
  **2–4 人自适应**：图上有 4 个 Speaker 槽，cast 里给 2–4 个角色都行（模板见
  assets/casts/模板-两人对话.json 与 模板-四人对话.json）。少于 4 个时脚本自动把
  多余的槽填成「占位角色」——节点源码只对剧本里开过口的角色编码参考音频、做生成，
  占位槽既不编码也不出声，零额外耗时。超过 4 人则要拆段，或另建一张槽更多的图。
  有 ref 就必须给 ref_text（逐字稿用 stt 拿），线上自动转写是坏的。
  漏了就提交前直接拦住（零花费），并把该跑的 stt 命令逐条打印出来。

lufs 专属（匹配响度，基准见 references/响度.md）：
  --target <LUFS>  目标积分响度。不给就按声道自动取：单声道 -17.4 / 立体声 -14.4
  --tp <dBTP>      真峰值上限，默认 -0.5（目标响度偏低，卡太紧偏轻素材够不到目标）
  --suffix <后缀>  输出后缀，默认 _std（源文件不动）
  --out <目录>     输出目录，默认与源文件同目录
  只做线性增益，不做动态压缩；处理完自动复核，残差 >0.15dB 会补一次

fx 专属（场景音，音频→音频，全本地不花钱）：
  --in <音频>      干声输入（TTS 产物、录音都行）；也可直接写第一个位置参数
  --preset <名字>  预设名或 id，中英文都认（教堂 / church、电话听筒 / phone）
  --mix <0–1>      湿度覆盖：空间类改混响量，通信类一般不用动
  --tail <秒>      混响尾巴预留，默认取 IR 长度 +1s；调小会切尾
  --gain <dB>      指定补偿增益，覆盖默认的「对齐输入响度」
  --no-level       不补偿：保留干湿交叉的自然衰减（要"远、轻"的效果就用这个）
  --list           列出全部预设
  --dry-run        只打印滤镜链和 ffmpeg 命令，不生成文件
  预设分两组：空间 17 个（OpenAIR 卷积混响，CC BY 4.0，见 assets/irs/IR来源与署名.md）
  与通信音色 11 个（电话 / 免提 / 对讲机 / 老式电话 / 大喇叭 / 电视 / 隔壁房间 / 内心独白 / 水下 / 恶魔）`);
}

/* ══════════ 九点五、stt：参考音频 → 文字稿 ══════════ */
/**
 * 单独一条命令的理由：克隆/导演里的转写错误是看不见的——音频照常出，字错了没人报。
 * 唯一可行的核对路径是「先把 Whisper 的结论拿回来，人眼扫一遍，再喂回 --ref-text」。
 */
async function runStt() {
  const ref = str(ARGS.ref);
  if (!ref) die(2, 'stt 用法：node scripts/rhv.mjs stt --ref 参考音频.mp3');
  if (!existsSync(resolveInput(ref)) && !/^openapi\//.test(ref)) die(2, `参考音频不存在：${resolveInput(ref)}`);

  const outDir = defaultOutDir();
  const name = str(ARGS.name) || 'stt';
  const pollMs = Math.max(500, num(ARGS.poll) || DEFAULT_POLL);
  const timeoutS = num(ARGS.timeout) || DEFAULT_TIMEOUT;
  const dryRun = Boolean(ARGS['dry-run']);
  const wf = MODES.stt.variants[0].wf;

  let refFileName = null;
  if (/^openapi\//.test(ref)) refFileName = ref;
  else if (dryRun) refFileName = '<上传后返回的 fileName>';

  let keyInfo = null;
  if (!dryRun) {
    keyInfo = resolveKey();
    if (!keyInfo) die(3, keyHelp());
    console.log(`[rhv] 密钥来源：${keyInfo.from}`);
    mkdirSync(outDir, { recursive: true });
    if (!refFileName) {
      const up = await uploadAudio(resolveInput(ref), keyInfo.key);
      refFileName = up.fileName;
      console.log(`[rhv] 音频已上传 ${refFileName}${up.cached ? '（命中缓存，未重复上传）' : ''}`);
    }
  }

  const nodes = refFileName ? [{ nodeId: '59', fieldName: 'audio', fieldValue: refFileName }] : [];
  const t0 = Date.now();
  const taskId = await submit(wf, nodes, keyInfo?.key, dryRun);
  if (dryRun) return;

  console.log(`[rhv] 已提交 taskId=${taskId}`);
  const body = await waitFor(taskId, keyInfo.key, { pollMs, timeoutS });
  const url = pickTextUrl(body);
  if (!url) {
    throw new Error('E_NO_OUTPUT 任务完成但没返回 txt。检查 #65 SaveText 是否还接在 #60 上：\n' +
      `  原始返回：${JSON.stringify(body).slice(0, 400)}`);
  }

  const file = join(outDir, `${name}.txt`);
  await download(url, file);
  const transcript = readFileSync(file, 'utf8').trim();
  const elapse = Math.round((Date.now() - t0) / 100) / 10;

  appendFileSync(join(outDir, '_voice.log.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), mode: 'stt', workflowId: wf, taskId,
    file: basename(file), chars: transcript.length, elapsedSeconds: elapse,
    ref: basename(ref),
  })}\n`, 'utf8');

  console.log(`[rhv] 转写完成 ${file}（${transcript.length} 字，耗时 ${elapse}s）\n`);
  console.log(transcript);
  if (ARGS.json) console.log(JSON.stringify({ out: outDir, file, transcript }, null, 2));
}

/* ══════════ 九点六、dialogue4：四人对话（一次出整段） ══════════ */
/**
 * 为什么单独一条命令：多说话人不是「一个问题一次生成」，是「N 个角色 × M 轮对白」，
 * 每个角色的音色、参考音频、指令都得逐槽喂，参数表用 flag 表达会烂掉。
 * 所以输入是一份 cast.json —— 结构固定，能直接当模板改（assets/casts/模板-四人对话.json）。
 *
 * 为什么付钱前要预检图：2026-10-30 踩过 —— 图的 auto_transcribe_if_empty 默认 true，
 * 一跑就在 Speaker.prepare 里崩，任务 FAILED 还照扣费，报错只有一句「工作流运行失败」。
 * 现在提交前先读一次图（免费），槽位/字段/默认值不对就当场停下。
 */

const normName = (s) => String(s ?? '').trim().replace(/^[*_\s]+|[*_\s]+$/g, '').replace(/\s+/g, ' ').toLowerCase();
const compactName = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** 付钱前读一次图：槽位在不在、字段全不全、auto_transcribe 默认值是不是还开着。返回问题清单。 */
async function preflightGraph(V, keyInfo) {
  const problems = [];
  let prompt = null;
  try {
    const r = await req(WF_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyInfo.key}` },
      body: JSON.stringify({ apiKey: keyInfo.key, workflowId: V.wf }),
    }, 'preflight getJsonApiFormat');
    const j = await r.json();
    if (j.code !== 0) return [`图读不出来：code=${j.code} msg=${j.msg || j.message}（workflowId 错 / 不属本账号 / 没在网页跑过）`];
    prompt = JSON.parse(j.data.prompt);
  } catch (e) {
    return [`预检请求失败（${e.message}）——断网或代理问题，加 NODE_USE_ENV_PROXY=1 再来`];
  }

  V.slots.forEach((nid, i) => {
    const node = prompt[String(nid)];
    if (!node) { problems.push(`槽位 #${nid}（第 ${i + 1} 个角色）不在图里`); return; }
    if (node.class_type !== 'BreezeTTS2Speaker') problems.push(`#${nid} 不是 BreezeTTS2Speaker，是 ${node.class_type}`);
    for (const f of V.speakerFields) {
      if (!(f in (node.inputs || {}))) problems.push(`#${nid} 缺字段 ${f}`);
    }
    if (node.inputs?.auto_transcribe_if_empty === true) {
      problems.push(`#${nid} 的 auto_transcribe_if_empty 默认还是 true —— 线上的 whisper 与 transformers 版本不兼容，一跑必崩（还扣费）。去网页把它关掉再保存`);
    }
  });
  for (const [k, [nid, field]] of Object.entries(V.nodes)) {
    const node = prompt[String(nid)];
    if (!node) problems.push(`#${nid} 不在图里（${k} 接不上）`);
    else if (!(field in (node.inputs || {}))) problems.push(`#${nid} 缺字段 ${field}（${k} 接不上）`);
  }
  const out = prompt[Object.keys(prompt).find((id) => prompt[id].class_type === 'SaveAudioAdvanced')];
  if (out && out.inputs?.format !== 'mp3') {
    problems.push(`输出节点 format=${out.inputs?.format}，不是 mp3 —— 改成别的格式任务会 SUCCESS 但取不回文件`);
  }
  return problems;
}

/** 从剧本里抠出所有「说话人」，纯文本和 JSON 两种格式都认。 */
function scriptTurns(script) {
  if (Array.isArray(script)) {
    return script.map((it) => ({
      name: normName(it?.speaker ?? it?.name ?? it?.character ?? it?.role),
      text: String(it?.text ?? it?.line ?? it?.content ?? it?.message ?? it?.dialogue ?? '').trim(),
    })).filter((t) => t.text);
  }
  const out = [];
  for (const raw of String(script || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^\s*(?:\[\s*([^\[\]:]{1,64}?)\s*\]|([^\[\]:]{1,64}?))\s*:\s*(.*)$/)
      || line.match(/^\s*\*\*\s*([^*]{1,64}?)\s*:?\s*\*\*\s*:?\s*(.*)$/);
    if (!m) continue;
    const name = normName(m[1] ?? m[2]);
    const text = String(m[3] ?? m[2] ?? '').trim();
    if (name && text) out.push({ name, text });
  }
  return out;
}

async function runDialogue() {
  const castPath = str(ARGS.cast) || str(ARGS.script);
  if (!castPath) {
    die(2, 'dialogue4 用法：node scripts/rhv.mjs dialogue4 --cast cast.json [--out 目录] [--name 前缀] [--seed N] [--dry-run]\n' +
      '  cast.json 结构见 assets/casts/模板-两人对话.json / 模板-四人对话.json：\n' +
      '  { pause, seed, speakers:[{name,ref,ref_text,instruction,cfg}], script:[{speaker,text}] }\n' +
      '  speakers 给 2–4 个，少于 4 个时多余的槽自动填占位、不出场。单人说话请用 clone/design/director。');
  }
  const castFile = resolveInput(castPath);
  if (!existsSync(castFile)) die(2, `cast 文件不存在：${castFile}`);
  let cfg;
  try { cfg = JSON.parse(readFileSync(castFile, 'utf8')); } catch (e) { die(2, `cast 不是合法 JSON：${e.message}`); }

  const V = MODES.dialogue4.variants[0];
  const slots = V.slots;
  const speakers = (Array.isArray(cfg.speakers) ? cfg.speakers : []).slice();

  // 这条模式天生是「多人」：1 个人不必走多角色图，单人模式参数更少、也没有轮间拼接
  if (speakers.length < 2) {
    const who = speakers.length ? `现在只有「${str(speakers[0].name) || '未命名'}」一个角色` : 'cast 里 speakers 是空的';
    die(2, `dialogue4 只接 2–4 人，${who}。\n` +
      '  单人说话请用单人模式（都是同一套密钥、同样出音频，参数更少，不会有多余的轮间停顿）：\n' +
      '    node scripts/rhv.mjs clone    --ref 参考.mp3 --ref-text "逐字稿" --text "台词" --out <目录>\n' +
      '    node scripts/rhv.mjs design   --voice "音色描述" --text "台词" --out <目录>\n' +
      '    node scripts/rhv.mjs director --ref 参考.mp3 --ref-text "逐字稿" --direction "表演指令" --text "台词" --out <目录>\n' +
      '  要多人对白就把第二个角色补进 cast 的 speakers（模板：assets/casts/模板-两人对话.json）。');
  }
  if (speakers.length > slots.length) {
    die(2, `这张图只有 #${slots.join(' / #')} 共 ${slots.length} 个 Speaker 槽，装了 ${speakers.length} 个角色。\n` +
      '  超过 4 人要拆段（分成几次 dialogue4 再拼），或另建一张槽更多的图并在 MODES.dialogue4 里登记 slots。');
  }

  // 少于 4 人时补「合法但不出场」的占位槽：源码里没开口的槽既不编码参考音频也不生成，
  // 只需名字唯一 + 一条 instruction，避免 prepare 阶段的重名/空指令两连崩。
  const realCount = speakers.length;
  const taken = new Set(speakers.map((s) => normName(s.name)).filter(Boolean));
  while (speakers.length < slots.length) {
    const idx = speakers.length + 1;
    let nm = `unused_slot_${idx}`;
    while (taken.has(normName(nm))) nm += '_';
    taken.add(normName(nm));
    speakers.push({
      name: nm,
      instruction: 'unused placeholder slot, never speaks in this script',
      __placeholder: true,
    });
  }

  const seen = new Map();
  speakers.forEach((s, i) => {
    const name = str(s.name);
    if (!name) die(2, `第 ${i + 1} 个角色没有 name`);
    const k = normName(name);
    if (seen.has(k)) die(2, `角色重名：${name}（第 ${seen.get(k) + 1} 个和第 ${i + 1} 个）——节点会 Duplicate speaker name 硬报错`);
    seen.set(k, i);
    if (!s.ref && !str(s.instruction)) {
      die(2, `角色 ${name} 既没有 ref（参考音频）也没有 instruction（音色描述）。\n` +
        '  两样都空 → 节点报 no reference audio, so the instruction designs the voice；二选一必填。');
    }
  });

  // 有参考音频却没逐字稿 → 在**任何网络动作之前**拦下（上传、读图都还没做，一分钱没花）
  // 线上 auto_transcribe_if_empty 是坏的，放进去就是「任务 FAILED + 照扣费」，所以这里必拦
  const missRefText = speakers
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => str(s.ref) && !str(s.ref_text ?? s.refText));
  if (missRefText.length) {
    const lines = [
      `有 ${missRefText.length} 个角色给了参考音频，但没给 ref_text 逐字稿：${missRefText.map(({ s }) => str(s.name)).join('、')}`,
      '',
      '  为什么不能让它空着自动转：这张图的 auto_transcribe_if_empty 一旦为 true，节点内部 Whisper 会在 prepare 阶段崩',
      '  （generation config 与线上 transformers 不兼容 → ValueError），任务 FAILED 但照扣费，报错还只回一句「工作流运行失败」。',
      '',
      '  所以逐字稿得自己给。用本技能自带的 stt 模式（Whisper 语音转文字）先转一遍：',
      '',
    ];
    for (const { s } of missRefText) {
      const r = String(s.ref);
      const nm = `"${str(s.name)}"`;
      if (/^openapi\//.test(r)) {
        lines.push(`    # ${str(s.name)}：ref 是线上文件名 ${r}，本地没有源文件，先把原音频放回本地再转`);
        lines.push(`    node scripts/rhv.mjs stt --ref <本地音频> --name ${nm} --out ./stt-out`);
      } else {
        lines.push(`    node scripts/rhv.mjs stt --ref "${resolveInput(r)}" --name ${nm} --out ./stt-out`);
      }
    }
    lines.push(
      '',
      '  转完把生成的 txt 内容填回 cast 里对应角色的 ref_text，再跑一次 dialogue4。',
      '  ⚠ 填之前必过一眼同音字：实测「记得→计的」「脏活累活→脏货累货」「禁制→禁止」——错字不报错，只让克隆相似度悄悄变低。',
      '  这条拦截在 dry-run 下同样生效（故意的）：缺逐字稿的 cast 不可能跑成，先补齐比先看请求体有用。',
    );
    die(2, lines.join('\n'));
  }

  // 剧本：数组（推荐，LLM 友好）或字符串（纯文本 / 现成 JSON 都行，原样喂给 #37）
  let scriptText = '';
  if (typeof cfg.script === 'string') scriptText = cfg.script.trim();
  else if (Array.isArray(cfg.script)) scriptText = JSON.stringify(cfg.script);
  else if (typeof cfg.script_text === 'string') scriptText = cfg.script_text.trim();
  if (!scriptText) die(2, 'cast 里没有 script：给数组 [{"speaker","text"}] 或字符串（"名字: 台词" 逐行）');

  const turns = scriptTurns(cfg.script ?? cfg.script_text);
  if (!turns.length) die(2, '剧本里解析不出任何一轮对白。纯文本必须是「名字: 台词」逐行；JSON 必须有 speaker + text');

  const unknown = [...new Set(turns.map((t) => t.name))].filter((n) => !seen.has(n) && ![...seen.keys()].some((k) => compactName(k) === compactName(n)));
  if (unknown.length) {
    die(2, `剧本里的角色不在演员表：${unknown.join('、')}\n  可用：${speakers.map((s) => s.name).join('、')}\n` +
      '  节点会报 Script uses unknown speaker(s)，一个字都生成不了');
  }
  const used = new Set(turns.map((t) => seen.get(t.name) ?? [...seen.entries()].find(([k]) => compactName(k) === compactName(t.name))?.[1]));

  // 剧本里写到了占位名 → 一定是角色名写错/多写了一段，占位槽没有参考音频也没有像样的音色描述
  const hitPlaceholder = speakers.filter((s, i) => s.__placeholder && used.has(i));
  if (hitPlaceholder.length) {
    die(2, `剧本里出现了占位角色：${hitPlaceholder.map((s) => s.name).join('、')}\n` +
      '  这些槽只是为了凑满 4 位、本不该开口。多半是剧本里的角色名写错，改掉再跑。');
  }
  speakers.forEach((s, i) => {
    if (used.has(i) || s.__placeholder) return; // 占位本来就不出场，不刷警告
    console.warn(`[rhv] ⚠ 角色 ${s.name} 在剧本里一次都没说话：节点不会编码它的参考音频、也不会生成，只是白占一个槽（零开销、零额外费用）。想让日志干净就把它删掉`);
  });

  const chars = turns.reduce((n, t) => n + t.text.length, 0);
  const padCount = speakers.length - realCount;
  const outDir = defaultOutDir();
  const name = str(ARGS.name) || 'dialogue';
  const seedArg = Number(ARGS.seed ?? cfg.seed);
  const seed = Number.isFinite(seedArg) && seedArg > 0 ? seedArg : Math.floor(Math.random() * 2 ** 21);
  const pause = Number.isFinite(Number(cfg.pause)) ? Number(cfg.pause) : 0.3;
  const pollMs = Math.max(500, Number(ARGS.poll) || DEFAULT_POLL);
  // 逐轮生成，轮数越多越慢：默认给到 30 分钟，别让 600s 的通用值把长剧本判死
  const timeoutS = num(ARGS.timeout) || 1800;
  const dryRun = Boolean(ARGS['dry-run']);

  console.log(`[rhv] dialogue4 · ${realCount} 角色${padCount ? `（另 ${padCount} 个占位槽不出场）` : ''} / ${turns.length} 轮 / 共 ${chars} 字（约 ${(chars / 4).toFixed(0)}s 语音）· 轮间停 ${pause}s · seed=${seed}`);
  speakers.forEach((s, i) => {
    if (s.__placeholder) {
      console.log(`  #${slots[i]} ${s.name}  占位·不参与生成（不编码参考音频、不出音频）`);
      return;
    }
    const kind = s.ref ? '克隆' : '设计';
    console.log(`  #${slots[i]} ${s.name}  ${kind}${s.ref ? `  ← ${basename(String(s.ref))}` : ''}${str(s.instruction) ? `  指令 ${str(s.instruction).length} 字` : ''}  cfg=${Number.isFinite(Number(s.cfg)) ? Number(s.cfg) : (s.ref ? 1 : 4)}`);
  });

  const nodes = [];
  const uploads = [];
  const keyInfo = resolveKey();
  if (!keyInfo && !dryRun) die(3, keyHelp());
  if (keyInfo) console.log(`[rhv] 密钥来源：${keyInfo.from}`);
  if (!dryRun) mkdirSync(outDir, { recursive: true });

  // 预检在前、上传在后：图要是坏的，先省下四次上传和无谓的一次失败
  if (keyInfo && !ARGS['no-preflight']) {
    const problems = await preflightGraph(V, keyInfo);
    if (problems.length) {
      die(2, '付钱前预检没过（这次一分钱没花）：\n  - ' + problems.join('\n  - ') +
        '\n  先去网页把图改好再提交；确认是平台侧问题、非要硬跑，加 --no-preflight');
    }
    console.log('[rhv] 图预检通过：4 槽在位、字段齐全、auto_transcribe=false、输出 mp3');
  }

  for (let i = 0; i < speakers.length; i += 1) {
    const s = speakers[i];
    const nid = slots[i];
    let fileName = 'none';
    if (s.ref) {
      const r = String(s.ref);
      if (/^openapi\//.test(r)) fileName = r;
      else if (dryRun) fileName = '<上传后返回的 fileName>';
      else {
        const p = resolveInput(r);
        if (!existsSync(p)) die(2, `角色 ${s.name} 的参考音频不存在：${p}`);
        if (!AUDIO_EXT_RE.test(p)) die(2, `角色 ${s.name} 的参考音频不是音频文件：${p}`);
        const sec = probeSeconds(p);
        if (sec && sec > REF_BUDGET_LIMIT) {
          die(2, `角色 ${s.name} 的参考音频 ${sec.toFixed(0)}s 超出 ${REF_BUDGET_LIMIT}s 上限（节点自己会 raise）。先切一段 10–20s 再跑`);
        }
        if (sec && sec > REF_SOFT_LIMIT) console.warn(`[rhv] ⚠ 角色 ${s.name} 参考 ${sec.toFixed(0)}s，超 ${REF_SOFT_LIMIT}s 会把单轮台词空间挤小，建议 10–20s`);
        const up = await uploadAudio(p, keyInfo.key);
        fileName = up.fileName;
        uploads.push({ name: s.name, file: basename(p), fileName, cached: up.cached });
        console.log(`[rhv] ${s.name} 参考音频已上传 ${fileName}${up.cached ? '（命中缓存）' : ''}`);
      }
    }
    const refText = str(s.ref_text ?? s.refText);
    // 兜底：上面已在任何网络动作之前整体拦过，走到这里说明是循环内被清空的异常情况
    if (s.ref && !refText) die(2, `角色 ${s.name} 的 ref_text 为空（前置检查已过，属异常），停下不发请求`);
    nodes.push({ nodeId: nid, fieldName: 'name', fieldValue: str(s.name) });
    nodes.push({ nodeId: nid, fieldName: 'audio', fieldValue: fileName });
    nodes.push({ nodeId: nid, fieldName: 'reference_text', fieldValue: refText });
    // 线上 whisper 自动转写是坏的（见上面 die 的说明），这里恒关，只认手写逐字稿
    nodes.push({ nodeId: nid, fieldName: 'auto_transcribe_if_empty', fieldValue: false });
    nodes.push({ nodeId: nid, fieldName: 'instruction', fieldValue: str(s.instruction) });
    nodes.push({
      nodeId: nid, fieldName: 'cfg_scale',
      fieldValue: Number.isFinite(Number(s.cfg)) ? Number(s.cfg) : (s.ref ? 1 : 4),
    });
  }
  nodes.push({ nodeId: V.nodes.script[0], fieldName: V.nodes.script[1], fieldValue: scriptText });
  nodes.push({ nodeId: V.nodes.seed[0], fieldName: V.nodes.seed[1], fieldValue: seed });
  nodes.push({ nodeId: V.nodes.pause[0], fieldName: V.nodes.pause[1], fieldValue: pause });

  const t0 = Date.now();
  const taskId = await submit(V.wf, nodes, keyInfo?.key, dryRun);
  if (dryRun) return;

  console.log(`[rhv] 已提交 taskId=${taskId}（逐轮生成，轮数多就更慢，先别急着重跑）`);
  const body = await waitFor(taskId, keyInfo.key, { pollMs, timeoutS });
  const elapse = Math.round((Date.now() - t0) / 100) / 10;

  const url = pickAudioUrl(body) || await legacyOutputs(taskId, keyInfo.key);
  if (!url) {
    throw new Error('E_NO_OUTPUT 任务跑完（已扣费）但没返回音频。检查 #26 SaveAudioAdvanced 的 format 是否被改成非 mp3：\n' +
      `  原始返回：${JSON.stringify(body).slice(0, 400)}`);
  }
  const ext = outExtOf(url, 'mp3');
  const file = join(outDir, `${name}.${ext}`);
  const bytes = await download(url, file);
  const info = flacInfo(file);
  const sec = info.seconds;

  appendFileSync(join(outDir, '_voice.log.jsonl'), `${JSON.stringify({
    at: new Date().toISOString(), mode: 'dialogue4', workflowId: V.wf, taskId,
    file: basename(file), bytes, audioSeconds: sec ?? null,
    speakers: speakers.map((s) => s.name), turns: turns.length, chars, seed,
    charsPerSecond: sec ? Math.round((chars / sec) * 100) / 100 : null,
    elapsedSeconds: elapse, refs: uploads.map((u) => u.file),
  })}\n`, 'utf8');

  const spd = sec ? `，${(chars / sec).toFixed(2)} 字/秒` : '';
  console.log(`\n[rhv] 完成 ${file}`);
  console.log(`      ${sec ? `${sec.toFixed(2)}s` : `${(bytes / 1024).toFixed(0)}KB`}${spd} · ${turns.length} 轮 · 耗时 ${elapse}s · seed=${seed}`);
  if (sec && chars / sec > 9) console.warn('[rhv] ⚠ 字/秒 明显偏高：可能有个别轮次被截断，逐句听后核对');
  if (ARGS.json) {
    console.log(JSON.stringify({
      out: outDir, file, taskId, seed, seconds: sec, bytes, elapsedSeconds: elapse,
      speakers: speakers.map((s) => s.name), turns: turns.length, chars,
    }, null, 2));
  }
}

/* ══════════ 九点七、lufs：匹配响度（基准见 references/响度.md） ══════════ */

// 标准素材 assets/loudness-standard.mp3 的实测值：立体声 -14.4 / 单声道 -17.4
const STD_MONO = -17.4;
const STD_STEREO = -14.4;

function measureLoudness(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const txt = String(r.stderr || '');
  const pick = (re) => { const m = txt.match(re); return m ? Number(m[1]) : null; };
  const I = pick(/Integrated loudness:[\s\S]{0,40}?I:\s*(-?[\d.]+)\s*LUFS/);
  const LRA = pick(/Loudness range:[\s\S]{0,40}?LRA:\s*(-?[\d.]+)\s*LU/);
  const TP = pick(/True peak:[\s\S]{0,40}?Peak:\s*(-?[\d.]+)\s*dBFS/);
  let channels = 1; let sampleRate = 0;
  try {
    // 注意：ffprobe 的 csv 按流的内部顺序输出，不按参数顺序，必须按键名解析
    const p = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate', '-of', 'default=nw=1', file], { encoding: 'utf8' });
    for (const line of p.split('\n')) {
      const [k, v] = line.split('=');
      if (k === 'channels') channels = Number(v) || 1;
      if (k === 'sample_rate') sampleRate = Number(v) || 0;
    }
  } catch { /* 拿不到就当单声道 */ }
  return { I, LRA, TP, channels, sampleRate };
}

function encodeArgsFor(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.mp3') return ['-codec:a', 'libmp3lame', '-b:a', '192k'];
  if (ext === '.flac') return ['-codec:a', 'flac'];
  if (ext === '.wav') return ['-codec:a', 'pcm_s16le'];
  if (ext === '.m4a') return ['-codec:a', 'aac', '-b:a', '192k'];
  return ['-codec:a', 'libmp3lame', '-b:a', '192k'];
}

function applyGain(src, dst, gainDb) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-af', `volume=${gainDb.toFixed(2)}dB`, ...encodeArgsFor(dst), dst];
  execFileSync('ffmpeg', args, { stdio: 'ignore' });
}

function runLufs() {
  const inputs = (ARGS._ || []).slice(1).filter((x) => !x.startsWith('--'));
  if (!inputs.length) {
    die(2, '用法：node scripts/rhv.mjs lufs <音频…> [--target -17.4] [--tp -1.5] [--out 目录] [--suffix _std]\n' +
      '  默认目标：单声道 -17.4 LUFS / 立体声 -14.4 LUFS（来自 assets/loudness-standard.mp3，见 references/响度.md）');
  }
  const targetArg = num(ARGS.target);
  const hasTarget = ARGS.target !== undefined && Number.isFinite(targetArg);
  const tpLimit = Number.isFinite(num(ARGS.tp)) ? num(ARGS.tp) : -0.5;
  const suffix = str(ARGS.suffix) || '_std';
  const outDirArg = str(ARGS.out);
  const results = [];
  let failed = 0;

  for (const input of inputs) {
    const src = resolveInput(input);
    if (!existsSync(src)) { console.error(`[rhv] ⚠ 不存在，跳过：${src}`); failed += 1; continue; }
    const m0 = measureLoudness(src);
    if (m0.I == null) { console.error(`[rhv] ⚠ 量不出响度（ffmpeg 不可用或文件损坏），跳过：${basename(src)}`); failed += 1; continue; }

    const target = hasTarget ? targetArg : (m0.channels > 1 ? STD_STEREO : STD_MONO);
    const rawGain = target - m0.I;

    // 已达标就先跳过——不能先压峰值再判断，否则会把本来对齐的素材白白降下来
    if (Math.abs(rawGain) < 0.05) {
      console.log(`\n[rhv] ${basename(src)}`);
      console.log(`  源：I=${m0.I.toFixed(1)} LUFS  ${m0.channels}声道 → 目标 ${target.toFixed(1)}，已在 ±0.05 dB 内`);
      console.log('  已达标，不生成新文件');
      results.push({ file: basename(src), sourceI: m0.I, gain: 0, target, out: null, skipped: true });
      continue;
    }

    let gain = rawGain;
    let cappedByTp = false;
    if (m0.TP != null) {
      const tpCap = tpLimit - m0.TP;
      if (gain > tpCap + 0.01) { gain = tpCap; cappedByTp = true; }
    }

    const outDir = outDirArg ? resolve(outDirArg) : dirname(src);
    mkdirSync(outDir, { recursive: true });
    const dst = join(outDir, `${basename(src, extname(src))}${suffix}${extname(src)}`);

    console.log(`\n[rhv] ${basename(src)}`);
    console.log(`  源：I=${m0.I.toFixed(1)} LUFS  LRA=${m0.LRA ?? '?'} LU  TP=${m0.TP ?? '?'} dBTP  ${m0.channels}声道`);
    console.log(`  目标：${target.toFixed(1)} LUFS${hasTarget ? '（--target 指定）' : (m0.channels > 1 ? '（立体声口径）' : '（单声道口径）')} → 增益 ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} dB`);
    if (cappedByTp) console.warn(`  ⚠ 受真峰值 ${tpLimit} dBTP 限制，增益只到 ${gain.toFixed(2)} dB，响度差 ${Math.abs(rawGain - gain).toFixed(2)} dB（要精确对齐就放宽 --tp，例如 --tp 0）`);

    // 施增益 → 复核 → 残差 >0.15 dB 再补（绝对门限会让积分响度不完全线性）；
    // 一旦因峰值触顶，目标不可达，立刻停止追，别再回头把增益改回去
    let applied = gain;
    let m1 = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      applyGain(src, dst, applied);
      m1 = measureLoudness(dst);
      if (cappedByTp) break;
      const resid = m1.I == null ? 0 : target - m1.I;
      if (Math.abs(resid) <= 0.15) break;
      // 峰顶余量是「输出文件还能再抬多少 dB」，要与本次要加的增量比，
      // 不能拿累计总增益比——轻素材（源 -30 LUFS、总增益 +12 dB）会因此被误判为触顶、
      // 一次都不补，结果永远差 0.3 dB 左右。
      if (resid > 0 && m1.TP != null && resid > tpLimit - m1.TP + 0.01) { cappedByTp = true; break; }
      applied += resid;
    }

    console.log(`  结果：I=${m1?.I?.toFixed(1) ?? '?'} LUFS  LRA=${m1?.LRA ?? '?'} LU  TP=${m1?.TP ?? '?'} dBTP  → ${basename(dst)}`);
    if (m0.LRA != null && m1?.LRA != null && Math.abs(m1.LRA - m0.LRA) > 0.5) {
      console.warn(`  ⚠ LRA 从 ${m0.LRA} 变到 ${m1.LRA}，动态被改动过，检查是否误加了限幅`);
    }
    results.push({
      file: basename(src), sourceI: m0.I, sourceTp: m0.TP, sourceLra: m0.LRA,
      gain: Math.round(applied * 100) / 100, target,
      outI: m1?.I ?? null, outTp: m1?.TP ?? null, outLra: m1?.LRA ?? null,
      out: basename(dst), cappedByTp,
    });
  }

  // 全部输入都失败时必须非零退出：否则上层脚本/自动化拿到 exit 0，以为对齐成功
  if (!results.length && failed) die(2, `${failed} 个输入全部无法处理（不存在或量不出响度），没有生成任何文件`);

  if (ARGS.json) console.log(JSON.stringify({ target: hasTarget ? targetArg : 'auto', results }, null, 2));
  else if (results.length) {
    console.log(`\n[rhv] ${results.filter((r) => !r.skipped).length} 条已处理，${results.filter((r) => r.skipped).length} 条已达标跳过`);
  }
}

/* ══════════ 九点七、fx：音频 → 场景音（全本地，零花费） ══════════ */
/**
 * 为什么不做成一条 RunningHub 工作流：混响、带通、EQ 本来就是信号处理。
 * DSP 给的是确定结果——同参数同输入逐字节可复现、不扣币、断网也能跑。
 * 生成模型在这件事上没有优势，只有成本和不确定性。
 *
 * 两条接线铁律（都是实测出来的，改图前先看）：
 *   ① afir 的输出会被截断到干声长度，混响尾巴必须靠 apad 预留，否则"说完就断"；
 *   ② afir 的 dry/wet 是乘性增益、任一置 0 直接静音，所以固定 dry=1:wet=10，
 *      湿度靠混音时的线性权重控制，不用它自带的旋钮。
 *
 * IR 的 makeup_db 是逐条实测的卷积补偿（详见 assets/irs/IR来源与署名.md），
 * 换 IR 或换 ffmpeg 版本必须重测——别手调这些数字。
 */
const FX_IRS_FILE = join(SKILL_ROOT, 'assets', 'irs', 'irs.json');

const FX_PRESETS = [
  // ── 空间：干声套一个真实房间（OpenAIR 卷积混响） ──
  { id: 'church',        name: '教堂',        ir: 'cathedral-big',    wet: 0.35, desc: '大教堂，长尾巴，庄严/独白' },
  { id: 'dome',          name: '穹顶',        ir: 'cathedral-dome',   wet: 0.35, desc: '圣保罗穹顶，比教堂更厚' },
  { id: 'chapel',        name: '小教堂',      ir: 'church-small',     wet: 0.30, desc: '小教堂，5s 混响' },
  { id: 'hall',          name: '礼堂',        ir: 'hall',             wet: 0.30, desc: '大学礼堂，日常大厅' },
  { id: 'concert',       name: '音乐厅',      ir: 'concert-hall',     wet: 0.28, desc: '音乐厅，4s' },
  { id: 'concert-big',   name: '大音乐厅',    ir: 'concert-hall-big', wet: 0.30, desc: '交响大厅' },
  { id: 'theatre',       name: '小剧场',      ir: 'theatre-small',    wet: 0.25, desc: '排练厅/黑匣子剧场' },
  { id: 'gym',           name: '体育馆',      ir: 'gym',              wet: 0.35, desc: '体育馆，大而闷' },
  { id: 'tunnel',        name: '隧道',        ir: 'tunnel',           wet: 0.40, desc: '铁路隧道，中级混响' },
  { id: 'mine',          name: '矿洞',        ir: 'mine',             wet: 0.35, desc: '矿洞，空腔感' },
  { id: 'stone',         name: '石室',        ir: 'stone-dungeon',    wet: 0.45, desc: '地下石室，短而硬' },
  { id: 'tomb',          name: '史前墓室',    ir: 'tomb',             wet: 0.40, desc: '1s，极干极硬' },
  { id: 'tomb-passage',  name: '石墓甬道',    ir: 'tomb-passage',     wet: 0.40, desc: '长甬道，拖尾' },
  { id: 'mausoleum',     name: '陵墓',        ir: 'mausoleum',        wet: 0.40, desc: '陵墓，宏大空旷' },
  { id: 'warehouse',     name: '厂房',        ir: 'warehouse',        wet: 0.35, desc: '厂房仓库，工业混响' },
  { id: 'industrial',    name: '巨型工业',    ir: 'industrial-huge',  wet: 0.40, desc: '反应堆大厅，科幻/巨型空间' },
  { id: 'outdoor',       name: '户外',        ir: 'outdoor-open',     wet: 0.22, desc: '空旷户外，几乎无混响但有距离' },

  // ── 通信与音色：靠滤波链改造，不用 IR（少数再叠一点房间） ──
  {
    id: 'phone', name: '电话听筒', alias: ['电话'],
    pre: 'highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,'
      + 'acompressor=threshold=-20dB:ratio=4:attack=4:release=80',
    post: 'volume=1.5',
    desc: '手机/座机通话中，对方在听筒里',
  },
  {
    id: 'phone-room', name: '电话另一头', alias: ['电话那头'],
    pre: 'highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,'
      + 'acompressor=threshold=-20dB:ratio=4:attack=4:release=80',
    ir: 'hall', wet: 0.15, post: 'volume=1.5',
    desc: '电话声 + 那头的房间，画外人说话',
  },
  {
    id: 'speakerphone', name: '免提', alias: ['免提电话'],
    pre: 'highpass=f=250,highpass=f=250,lowpass=f=3500,lowpass=f=3500,'
      + 'acompressor=threshold=-22dB:ratio=3:attack=6:release=100',
    ir: 'hall', wet: 0.20, post: 'volume=1.4',
    desc: '开着免提，声音散在房间里',
  },
  {
    id: 'walkie', name: '对讲机', alias: ['无线电'],
    pre: 'highpass=f=250,highpass=f=250,lowpass=f=3000,lowpass=f=3000,'
      + 'acrusher=bits=8:mix=0.6:mode=log,acompressor=threshold=-24dB:ratio=6:attack=3:release=60',
    post: 'volume=1.8',
    desc: '警匪/保安对讲机，窄带 + 削波',
  },
  {
    id: 'vintage-phone', name: '老式电话', alias: ['年代电话'],
    pre: 'highpass=f=400,highpass=f=400,lowpass=f=2800,lowpass=f=2800,'
      + 'vibrato=f=3:d=0.06,acrusher=bits=8:mix=0.8:mode=log',
    post: 'volume=1.6',
    desc: '年代戏里的老电话/录音，带转速抖动',
  },
  {
    id: 'pa', name: '大喇叭', alias: ['广播', '喊话'],
    pre: 'highpass=f=500,highpass=f=500,lowpass=f=4000,lowpass=f=4000,'
      + 'equalizer=f=2000:t=q:w=1:g=5,acompressor=threshold=-20dB:ratio=5:attack=3:release=60',
    ir: 'cathedral-big', wet: 0.25,
    post: 'acrusher=bits=10:mix=0.3:mode=log,volume=1.4',
    desc: '车站/校园/广场大喇叭喊话',
  },
  {
    id: 'tv', name: '电视里传出', alias: ['电视机', '收音机'],
    pre: 'highpass=f=200,highpass=f=200,lowpass=f=5000,lowpass=f=5000,'
      + 'acrusher=bits=10:mix=0.4:mode=log,acompressor=threshold=-20dB:ratio=4:attack=4:release=80',
    post: 'volume=1.3',
    desc: '声音从电视机/收音机里出来',
  },
  {
    id: 'next-room', name: '隔壁房间', alias: ['隔墙'],
    pre: 'lowpass=f=900,lowpass=f=900,volume=-4dB',
    ir: 'hall', wet: 0.35,
    desc: '隔着墙听见有人说话',
  },
  {
    id: 'inner-voice', name: '内心独白', alias: ['旁白', '心声'],
    pre: 'equalizer=f=120:t=q:w=1:g=3,equalizer=f=3000:t=q:w=1:g=1.5,'
      + 'acompressor=threshold=-24dB:ratio=3:attack=5:release=120',
    post: 'volume=1.25',
    desc: 'VO/心声，贴耳、低频厚、零空间',
  },
  {
    id: 'underwater', name: '水下',
    pre: 'lowpass=f=400,lowpass=f=400,rubberband=pitch=0.94',
    ir: 'hall', wet: 0.18, post: 'volume=1.3',
    desc: '溺水/水下视角，闷 + 略降调',
  },
  {
    id: 'demon', name: '恶魔', alias: ['异类', '附身'],
    pre: 'rubberband=pitch=0.72',
    ir: 'cathedral-big', wet: 0.35,
    post: 'acrusher=bits=12:mix=0.2:mode=log,volume=1.3',
    desc: '附身/异类说话，降调 + 长混响 + 轻失真',
  },
];

function fxPreset(key) {
  const k = String(key || '').trim().toLowerCase();
  if (!k) return null;
  return FX_PRESETS.find((p) => p.id === k || p.name === String(key).trim()
    || (p.alias || []).some((a) => a === String(key).trim() || a.toLowerCase() === k)) || null;
}

function loadFxIrs() {
  if (!existsSync(FX_IRS_FILE)) die(2, `没有 IR 清单：${FX_IRS_FILE}\n  重新抓取见 assets/irs/IR来源与署名.md`);
  let j;
  try { j = JSON.parse(readFileSync(FX_IRS_FILE, 'utf8')); } catch { die(2, `IR 清单不是合法 JSON：${FX_IRS_FILE}`); }
  const map = {};
  for (const ir of j.irs || []) map[ir.id] = ir;
  return map;
}

// 中文字符占两格，padEnd 按码点算会把表格拉歪
const dispW = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const padD = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispW(s)));

function fxList() {
  const irs = loadFxIrs();
  console.log('\n空间（卷积混响 · 来源 OpenAIR / CC BY 4.0）');
  for (const p of FX_PRESETS.filter((x) => x.ir && !x.pre)) {
    const ir = irs[p.ir];
    console.log(`  ${padD(p.name, 12)}${padD(p.id, 14)}混响 ${padD(ir ? ir.seconds : '?', 5)}湿度 ${padD(p.wet, 6)}${p.desc}`);
  }
  console.log('\n通信与音色（滤波链，个别叠加房间）');
  for (const p of FX_PRESETS.filter((x) => x.pre)) {
    const ir = p.ir ? irs[p.ir] : null;
    const extra = ir ? `+ ${ir.scene} 湿度 ${p.wet}` : '';
    console.log(`  ${padD(p.name, 12)}${padD(p.id, 14)}${padD(extra, 22)}${p.desc}`);
  }
  console.log(`\n共 ${FX_PRESETS.length} 个预设。用法：node scripts/rhv.mjs fx --in 干声.flac --preset 电话听筒\n`);
}

function runFx() {
  if (ARGS.list) { fxList(); return; }

  const rawIn = str(ARGS.in) || (ARGS._[1] || '');
  if (!rawIn) die(2, '用法：node scripts/rhv.mjs fx --in <干声音频> --preset <预设名> [--mix 0.35] [--out 目录]\n'
    + '  看全部预设：node scripts/rhv.mjs fx --list');
  const src = resolveInput(rawIn);
  if (!existsSync(src)) die(2, `输入不存在：${src}`);

  const preset = fxPreset(str(ARGS.preset));
  if (!preset) {
    die(2, `没有这个预设：${ARGS.preset}\n  可用：${FX_PRESETS.map((p) => p.name).join(' / ')}\n  看全部：node scripts/rhv.mjs fx --list`);
  }

  const irs = loadFxIrs();
  const ir = preset.ir ? irs[preset.ir] : null;
  if (preset.ir && !ir) die(2, `预设 ${preset.name} 指向的 IR「${preset.ir}」不在 ${FX_IRS_FILE} 里`);

  const mixArg = num(ARGS.mix);
  const wet = Number.isFinite(mixArg) && mixArg >= 0 && mixArg <= 1 ? mixArg : (preset.wet ?? 0.3);
  if (ir) {
    const irPath = join(SKILL_ROOT, 'assets', 'irs', ir.file);
    if (!existsSync(irPath)) die(2, `IR 文件缺失：${irPath}`);
  }

  const outDir = resolve(str(ARGS.out) || './fx-out');
  // dry-run 只打印链路，不落任何东西——目录留到真要渲染前再建。
  if (!ARGS['dry-run']) mkdirSync(outDir, { recursive: true });
  const stem = basename(src, extname(src));
  const toMp3Out = Boolean(ARGS.mp3);
  const dst = join(outDir, `${str(ARGS.name) || `${stem}_${preset.id}`}.${toMp3Out ? 'mp3' : 'flac'}`);

  const chain = ['aresample=48000', 'aformat=channel_layouts=stereo'];
  if (preset.pre) chain.push(preset.pre);
  const tailArg = num(ARGS.tail);
  const tail = Number.isFinite(tailArg) && tailArg > 0 ? tailArg : (ir ? Math.min(ir.seconds + 1, 12) : 0);

  let graph;
  if (ir) {
    // 湿声线性增益 = 湿度 × 10^(makeup/20)；干声拿剩下的权重。两个权重都是纯增益，不改变 LRA。
    const wg = wet * 10 ** (ir.makeup_db / 20);
    const dg = 1 - wet;
    const post = preset.post ? `,${preset.post}` : '';
    graph = `[0:a]${chain.join(',')},apad=pad_dur=${tail},asplit=2[d1][d2];`
      + `[d1][1:a]afir=dry=1:wet=10,volume=${wg.toFixed(4)}[w];`
      + `[d2]volume=${dg.toFixed(4)}[d];`
      + `[d][w]amix=inputs=2:normalize=0${post},alimiter=limit=0.94[o]`;
  } else {
    const post = preset.post ? `,${preset.post}` : '';
    graph = `[0:a]${chain.join(',')}${post},alimiter=limit=0.94[o]`;
  }

  console.log(`[rhv] fx · ${preset.name}（${preset.id}）· 湿度 ${wet}${ir ? ` · IR ${ir.scene} ${ir.seconds}s` : ''}`);
  console.log(`[rhv] 输入 ${src}`);

  const renderArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  if (ir) renderArgs.push('-i', join(SKILL_ROOT, 'assets', 'irs', ir.file));
  renderArgs.push('-filter_complex', graph, '-map', '[o]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le');

  const tmpWav = join(outDir, `.${stem}_${preset.id}.fx.tmp.wav`);
  if (ARGS['dry-run']) {
    console.log(`[rhv] 滤镜链：\n  ${graph}`);
    console.log(`[rhv] 命令：ffmpeg ${[...renderArgs, tmpWav, '→', dst].join(' ')}`);
    return;
  }

  try { execFileSync('ffmpeg', [...renderArgs, tmpWav], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) {
    die(2, `ffmpeg 处理失败：${String(e.stderr || e.message).trim().split('\n').slice(-4).join('\n  ')}`);
  }
  if (!existsSync(tmpWav)) die(2, '处理完但没生成中间文件（检查 ffmpeg 版本是否带 afir / rubberband / acrusher）');

  // 干湿交叉会让整体电平掉 4–6 dB（湿声与干声不相干，叠加不等于相加）。
  // 默认按输入响度线性补回来——同一句台词走完 fx 不该变小声；要"远/轻"就用 --no-level。
  const mIn = measureLoudness(src);
  const mDry = measureLoudness(tmpWav);
  let gainDb = 0;
  const gainArg = Number(ARGS.gain);
  if (Number.isFinite(gainArg)) {
    gainDb = gainArg;
  } else if (!ARGS['no-level'] && mIn?.I != null && mDry?.I != null) {
    gainDb = mIn.I - mDry.I;
    const tpLimit = -1;
    if (mDry.TP != null && gainDb > tpLimit - mDry.TP) gainDb = tpLimit - mDry.TP;
  }

  const finalArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmpWav,
    '-af', `volume=${gainDb.toFixed(2)}dB`,
    ...(toMp3Out ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'flac']), dst];
  try { execFileSync('ffmpeg', finalArgs, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) {
    die(2, `写最终文件失败：${String(e.stderr || e.message).trim().split('\n').slice(-3).join('\n  ')}`);
  }
  try { rmSync(tmpWav, { force: true }); } catch { /* 留着也不影响产物 */ }

  const sec = probeSeconds(dst);
  const m = measureLoudness(dst);
  console.log(`[rhv] 电平 ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(2)} dB（${Number.isFinite(gainArg) ? '--gain 指定' : ARGS['no-level'] ? '--no-level，保留干湿交叉的自然衰减' : `对齐输入 ${mIn?.I?.toFixed(1) ?? '?'} LUFS`}）`);
  console.log(`[rhv] 完成 ${dst}`);
  console.log(`[rhv] ${sec ? `${sec.toFixed(2)}s` : '时长未知'}${m?.I != null ? `，I=${m.I.toFixed(1)} LUFS，TP=${m.TP ?? '?'} dBTP` : ''}`);

  if (ARGS.json) {
    console.log(JSON.stringify({
      mode: 'fx', preset: preset.id, name: preset.name, wet, ir: ir ? ir.id : null,
      tail, gainDb: Math.round(gainDb * 100) / 100,
      out: dst, seconds: sec, I: m?.I ?? null, TP: m?.TP ?? null,
    }, null, 2));
  }
}

/* ══════════ 十、主流程 ══════════ */
function readMaybe(argName, fileArg) {
  if (str(ARGS[argName])) return str(ARGS[argName]);
  if (str(ARGS[fileArg])) {
    const p = resolve(str(ARGS[fileArg]));
    if (!existsSync(p)) die(2, `--${fileArg} 指向的文件不存在：${p}（相对路径会先查当前目录，再查技能根目录）`);
    return readFileSync(p, 'utf8').trim();
  }
  return '';
}

async function main() {
  const mode = ARGS._[0];
  if (!mode || ARGS.help || ARGS.h || mode === 'help') { help(); return; }
  if (mode === 'wf') { await wfCommand(ARGS._[1] || 'all'); return; }

  if (mode === 'upload') {
    const f = ARGS._[1];
    if (!f || !existsSync(resolveInput(f))) die(2, '用法：node scripts/rhv.mjs upload <音频文件>');
    const k = resolveKey();
    if (!k) die(3, keyHelp());
    const up = await uploadAudio(resolveInput(f), k.key);
    console.log(JSON.stringify({ file: resolveInput(f), ...up }, null, 2));
    return;
  }

  if (mode === 'lufs') { runLufs(); return; }

  if (mode === 'fx') { runFx(); return; }

  if (mode === 'stt') { await runStt(); return; }

  if (mode === 'dialogue4' || mode === 'dialogue') { await runDialogue(); return; }

  const M = MODES[mode];
  if (!M) die(2, `未知模式 ${mode}。可用：design / clone / director / dialogue4 / stt / fx / wf / upload / lufs`);

  const text = readMaybe('text', 'text-file');
  const voice = readMaybe('voice', 'voice-file');
  const direction = readMaybe('direction', 'direction-file');
  const refText = readMaybe('ref-text', 'ref-text-file');
  const ref = str(ARGS.ref);
  const instruction = str(ARGS.instruction);

  // 给了参考文稿就走「带参考文稿」那条图，没给就走内置 Whisper 那条
  const hasTextVariant = M.variants.some((v) => 'refText' in v.nodes);
  if (refText && !hasTextVariant) die(2, `${mode} 没有带参考文稿的工作流，--ref-text 用不上`);
  const V = refText ? M.variants[M.variants.length - 1] : M.variants[0];

  if (!text) die(2, '缺台词：--text "要念的话"（长文本用 --text-file 路径.txt）');
  if (V.need.includes('voice') && !voice) {
    die(2, '缺 --voice（音色描述）。这模式不给音色 ID，要写一句人话：\n' +
      '  例：--voice "三十二岁男声，音色偏中低，干净不带沙，语速中等偏慢，尾音往下收，像在屋里压低嗓子跟人商量事情。"');
  }
  if (V.need.includes('direction') && !direction) {
    die(2, '缺 --direction（导演指令）。写密才改得动：\n' +
      '  例：--direction "语速放慢到原来的七成，音量压低，气声多，每句话结尾停顿半拍，情绪克制带一点疲惫，普通话标准不带口音。"');
  }
  if (V.need.includes('ref')) {
    if (!ref) die(2, '缺 --ref（参考音频）。克隆/导演必须先有声音样本，10–20s、干净、单人、无配乐、不循环。');
    if (!existsSync(resolveInput(ref)) && !/^openapi\//.test(ref)) die(2, `参考音频不存在：${resolveInput(ref)}`);
  }

  // 只体检这个模式实际用得上的输入，别拿别的模式的要求来吓人
  if (voice) {
    for (const it of checkVoice(voice)) {
      if (it.level === 'info') console.log(`[rhv] ${it.msg}`);
      else console.warn(`[rhv] ⚠ ${it.msg}`);
    }
  }
  if (direction) checkDirection(direction).forEach((w) => console.warn(`[rhv] ⚠ ${w}`));

  const outDir = defaultOutDir();
  const name = str(ARGS.name) || mode;
  const seedArg = Number(ARGS.seed);
  const seed = Number.isFinite(seedArg) ? seedArg : Math.floor(Math.random() * 2 ** 21);
  const pollMs = Math.max(500, num(ARGS.poll) || DEFAULT_POLL);
  const timeoutS = num(ARGS.timeout) || DEFAULT_TIMEOUT;
  const dryRun = Boolean(ARGS['dry-run']);
  const cfgRaw = Number(ARGS.cfg);

  if (text.length > SEG_LIMIT) {
    console.warn(`[rhv] ⚠ 台词 ${text.length} 字，超过 ${SEG_LIMIT} 字后后半段语调容易飘。`);
    console.warn('[rhv]   本技能不自动切：自己拆成几条命令分别跑，或在台词里靠标点把节奏切开。');
    const withRef = V.need.includes('ref');
    const hardCut = withRef ? HARD_CUT_REF : HARD_CUT_DESIGN;
    if (text.length > hardCut) {
      console.warn(`[rhv] ⚠⚠ 已过硬上限：本模式约 ${hardCut} 字之后，结尾会被**静默吞掉**——`);
      console.warn(`[rhv]   退出码照样 0、文件照样出、时长照样正常，只是结尾没念完（可能整段没念，也可能只少最后一个字）${withRef ? '；参考音频按 12.5 token/秒先占掉预算' : ''}。`);
      console.warn('[rhv]   要完整就必须拆条。别拿「有文件落盘」当作念完了。');
    }
  }

  console.log(`[rhv] ${mode} · 台词 ${text.length} 字` +
    (voice ? ` · 音色 ${voice.length} 字` : '') + (direction ? ` · 指令 ${direction.length} 字` : '') + ` · seed=${seed}`);
  if (mode !== 'design') {
    console.log(`[rhv] 参考音频：${ref}`);
    console.log(`[rhv] 工作流 ${V.wf}${refText ? `（带参考文稿 ${refText.length} 字，跳过 Whisper）` : '（内置 Whisper 自动转写）'}`);
    if (!refText) {
      console.warn('[rhv] ⚠ 没给 --ref-text：这条图走平台侧 Whisper 自动转写参考文稿。');
      console.warn('[rhv]   能跑（2026-10-30 实测：clone 自动转写 2.40s / 带稿 2.32s，都正常出音频），');
      console.warn('[rhv]   但转写错字会跟着进音色与韵律。要精确复刻：先 stt 出逐字稿，再 --ref-text 重跑（多花一次币）。');
    }
  }

  // 参考音频：时长体检 → 必要时裁剪 → 上传
  let refFileName = null;
  let refSeconds = null;
  // 真正要上传的本地文件：裁剪后是临时副本，不裁就是原文件。
  // 上传必须用它，不能回头用 resolveInput(ref) —— 否则 --trim 只改日志不改素材。
  let refLocalPath = null;
  if (V.need.includes('ref')) {
    let refPath = resolveInput(ref);
    if (/^openapi\//.test(ref)) {
      refFileName = ref;
      console.log('[rhv] 参考音频已是平台文件名，跳过上传');
    } else {
      if (!AUDIO_EXT_RE.test(refPath)) {
        die(2, `参考音频不是音频文件：${refPath}\n  只吃 mp3 / wav / flac / m4a / ogg / aac / opus`);
      }
      refSeconds = probeSeconds(refPath);
      if (refSeconds) {
        console.log(`[rhv] 参考音频 ${refSeconds.toFixed(1)}s`);
        // 顺序是「先裁、再判预算」：超 60s 时 --trim 是唯一的活路，
        // 反过来先拒就变成「报错让你加 --trim，加了照样拒」。
        const trimArg = num(ARGS.trim);
        const trimGiven = ARGS.trim !== undefined;
        // 0.5s 容差：剪好的 20s 素材 ffprobe 常报 20.04s，不该被当成「超了」而逼着再截一次
        if (trimGiven && refSeconds > REF_SOFT_LIMIT + 0.5) {
          // 裸 --trim 表示「截到默认 20s」，不是「截到 1s」——见 num() 的注释
          const sec = Number.isFinite(trimArg) && trimArg > 0 ? trimArg : REF_SOFT_LIMIT;
          const cut = trimRef(refPath, sec);
          if (!cut) die(2, '裁剪失败（ffmpeg 不可用？）——手工剪一段再跑');
          const cutSeconds = probeSeconds(cut);
          console.log(`[rhv] 已截前 ${sec}s → ${cut}${cutSeconds ? `（${cutSeconds.toFixed(1)}s）` : ''}`);
          if (cutSeconds && cutSeconds > REF_BUDGET_LIMIT) {
            die(2, `--trim ${sec} 之后仍有 ${cutSeconds.toFixed(0)}s，超出 ${REF_BUDGET_LIMIT}s 预算。截短一点：--trim ${REF_SOFT_LIMIT}`);
          }
          refPath = cut;
          refSeconds = cutSeconds ?? sec;
        } else if (refSeconds > REF_BUDGET_LIMIT) {
          die(2, `参考音频 ${refSeconds.toFixed(0)}s 超出 ${REF_BUDGET_LIMIT}s 预算：参考和台词共用 MAX_SEQ_LEN 2048 个 token，参考越长台词空间越小。先切一段：加 --trim ${REF_SOFT_LIMIT}`);
        } else if (refSeconds > REF_SOFT_LIMIT + 0.5) {
          console.warn(`[rhv] ⚠ 参考音频 ${refSeconds.toFixed(1)}s，已达推荐上限 ${REF_SOFT_LIMIT}s：每多 1 秒就吃掉 1 秒台词额度，后面部分模型也容易跑偏。要截断加 --trim ${REF_SOFT_LIMIT}`);
        }
      }
      refLocalPath = refPath;
    }
  }

  let keyInfo = null;
  if (!dryRun) {
    keyInfo = resolveKey();
    if (!keyInfo) die(3, keyHelp());
    console.log(`[rhv] 密钥来源：${keyInfo.from}`);
    mkdirSync(outDir, { recursive: true });
    if (V.need.includes('ref') && !refFileName) {
      const up = await uploadAudio(refLocalPath || resolveInput(ref), keyInfo.key);
      refFileName = up.fileName;
      console.log(`[rhv] 参考音频已上传 ${refFileName}${up.cached ? '（命中缓存，未重复上传）' : ''}`);
    }
  } else if (V.need.includes('ref') && !refFileName) {
    refFileName = '<上传后返回的 fileName>'; // 空跑不真上传，占位让 payload 结构完整
  }

  const N = V.nodes;
  const nodes = [];
  const push = (slot, value) => {
    const s = N[slot];
    if (!s) return;
    nodes.push({ nodeId: s[0], fieldName: s[1], fieldValue: value });
  };

  push('text', text);
  if (voice) push('voice', voice);
  if (direction) push('direction', direction);
  if (refFileName) push('ref', refFileName);
  if (refText) push('refText', refText);
  if (Number.isFinite(cfgRaw) && cfgRaw > 0) push('cfg', cfgRaw);
  if (instruction && N.instruction) push('instruction', instruction);
  push('seed', seed);

  const t0 = Date.now();
  const taskId = await submit(V.wf, nodes, keyInfo?.key, dryRun);
  if (dryRun) return;

  console.log(`[rhv] 已提交 taskId=${taskId}`);
  const body = await waitFor(taskId, keyInfo.key, { pollMs, timeoutS });
  const elapse = Math.round((Date.now() - t0) / 100) / 10;

  const url = pickAudioUrl(body) || await legacyOutputs(taskId, keyInfo.key);
  if (!url) {
    throw new Error('E_NO_OUTPUT 任务跑完（已扣费）但没返回音频。多半是输出节点不被平台识别：\n' +
      '  去 RH 网页把 T8_BreezeTTS_Generate 的 AUDIO 接到 PreviewAudio 或 SaveAudio，保存并在线跑一次。\n' +
      `  原始返回：${JSON.stringify(body).slice(0, 240)}`);
  }

  const ext = outExtOf(url, 'flac');
  const file = join(outDir, `${name}.${ext}`);
  const bytes = await download(url, file);
  const info = flacInfo(file);

  let delivered = file;
  if (ARGS.mp3) {
    const mp3 = toMp3(file);
    if (mp3) delivered = mp3; else console.warn('[rhv] ⚠ 想转 mp3 但没有 ffmpeg，保留 flac');
  }

  const rec = {
    at: new Date().toISOString(), mode, workflowId: V.wf, taskId,
    file: basename(delivered), bytes, audioSeconds: info.seconds ?? null,
    chars: text.length, seed, elapsedSeconds: elapse,
    ref: ref ? basename(ref) : null,
  };
  appendFileSync(join(outDir, '_voice.log.jsonl'), `${JSON.stringify(rec)}\n`, 'utf8');

  const dur = info.seconds ? `音频 ${info.seconds.toFixed(2)}s` : `体积 ${(bytes / 1024).toFixed(0)}KB`;
  const spd = info.seconds && text.length ? `，${(text.length / info.seconds).toFixed(2)} 字/秒` : '';
  console.log(`[rhv] 完成 ${delivered}（${dur}${spd}；耗时 ${elapse}s）`);

  if (ARGS.json) console.log(JSON.stringify({ out: outDir, files: [rec] }, null, 2));
  else console.log(`\n[rhv] 1 个音频 → ${outDir}`);
}

main().catch((e) => {
  const msg = String(e?.message || e);
  console.error(`\n[rhv] 失败：${msg}`);
  if (/E_SUBMIT/.test(msg) && /401|403|invalid.*(key|token)/i.test(msg)) {
    console.error('[rhv] 密钥无效 → 「个人中心 → API 控制台」重新生成，写回环境变量或 RUNNINGHUB_API_KEY 文件。');
  } else if (/E_SUBMIT/.test(msg) && /not exist|不存在|no permission|无权限/i.test(msg)) {
    console.error('[rhv] 两种可能：① 密钥不是这条工作流所在账号的；② 这条工作流没在该账号的网页上在线跑过一次（RH 硬规定）。');
    console.error('        排掉 ① 后去网页点一次运行，出过一段音频再回来重跑。');
  }
  process.exit(4);
});
