/* global window, document */

const LS_KEY = "spanish_reader_state_v1";

const ES_COL_INDEX = 0;
const ZH_COL_INDEX = 1;

const DAILY_PAIRS = 50;
const SETTINGS_LS_KEY = "spanish_reader_settings_v1";

const DEFAULT_REPEAT_COUNT = 5; // 每句（西语+中文这对）默认重复次数
const DEFAULT_WAIT_SECONDS = 3; // 中文结束 -> 下一次朗读/下一条之间等待（秒）

const $ = (sel) => document.querySelector(sel);

const state = {
  ready: false,
  isPlaying: false,
  isPaused: false,
  pairs: [],
  // 用于区分“当前正在执行的朗读链”和“用户触发跳转/暂停后作废的旧朗读链”
  playToken: 0,
  settings: {
    repeatCount: DEFAULT_REPEAT_COUNT,
    waitSeconds: DEFAULT_WAIT_SECONDS,
    waitMs: DEFAULT_WAIT_SECONDS * 1000,
  },
  // ids: 保存每条的原始行 id（用于洗牌与进度）
  dayBatchIds: [],
  dayBatchPointer: 0, // 当前在 dayBatchIds 的下标
  todayTotalCompleted: 0, // 今日累计完成的“对数”（用于显示进度和循环次数）
  // 队列与指针：决定“每天抽取哪 50 对”
  queueOrder: [],
  queuePointer: 0,
  todayStr: "",
};

function getLocalDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 轻量种子随机数（Mulberry32）
function makeRng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromStr(str) {
  // 简单 hash：足够用于“每天/每轮洗牌”随机性
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function safeText(v) {
  return String(v ?? "").replace(/\r?\n/g, " ").trim();
}

function normalizeSpanishForTTS(text) {
  // Web Speech 对引号/破折号有时会读得很含糊；对西语做轻量清洗提升清晰度
  let t = safeText(text);
  t = t.replace(/"/g, ""); // 去掉双引号
  t = t.replace(/[—–]/g, " "); // em/en dash -> space
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function parseCSV(text) {
  // 支持字段带引号、字段内逗号、引号转义 ""。
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // escaped quote
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(cur);
      cur = "";
      continue;
    }

    if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      continue;
    }

    if (ch === "\r") {
      // ignore
      continue;
    }

    cur += ch;
  }

  // last line
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }

  return rows;
}

function pickVoiceByLang(voices, desiredLangPrefix) {
  if (!voices || voices.length === 0) return null;
  const exact = voices.find((v) => (v.lang || "").toLowerCase() === desiredLangPrefix.toLowerCase());
  if (exact) return exact;
  const prefix = voices.find((v) => (v.lang || "").toLowerCase().startsWith(desiredLangPrefix.toLowerCase().split("-")[0]));
  return prefix || null;
}

function getState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setState() {
  const persist = {
    queueOrder: state.queueOrder,
    queuePointer: state.queuePointer,
    todayStr: state.todayStr,
    dayBatchIds: state.dayBatchIds,
    dayBatchPointer: state.dayBatchPointer,
    todayTotalCompleted: state.todayTotalCompleted,
  };
  localStorage.setItem(LS_KEY, JSON.stringify(persist));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);

    const repeatCount = Number(parsed?.repeatCount);
    const waitSeconds = Number(parsed?.waitSeconds);

    if (Number.isFinite(repeatCount)) {
      state.settings.repeatCount = Math.min(10, Math.max(1, Math.round(repeatCount)));
    }
    if (Number.isFinite(waitSeconds)) {
      const clamped = Math.min(10, Math.max(0, waitSeconds));
      state.settings.waitSeconds = clamped;
      state.settings.waitMs = clamped * 1000;
    }
  } catch {
    // ignore
  }
}

function saveSettings() {
  const persist = {
    repeatCount: state.settings.repeatCount,
    waitSeconds: state.settings.waitSeconds,
  };
  localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(persist));
}

function applySettingsToUI() {
  const repeatCount = state.settings.repeatCount;
  const waitSeconds = state.settings.waitSeconds;

  const repeatSlider = $("#repeatCount");
  const repeatLabel = $("#repeatCountLabel");
  if (repeatSlider) repeatSlider.value = String(repeatCount);
  if (repeatLabel) repeatLabel.textContent = String(repeatCount);

  const waitSlider = $("#waitSeconds");
  const waitLabel = $("#waitSecondsLabel");
  if (waitSlider) waitSlider.value = String(waitSeconds);
  if (waitLabel) waitLabel.textContent = Number(waitSeconds).toFixed(1);

  const waitHint = $("#waitSecondsHint");
  if (waitHint) waitHint.textContent = Number(waitSeconds).toFixed(1);
}

function updateUI() {
  $("#todayStr").textContent = state.todayStr || "-";

  const completedMod = state.todayTotalCompleted % DAILY_PAIRS;
  const completedToday = completedMod === 0 ? DAILY_PAIRS : completedMod;

  const cycleTimes = Math.floor(state.todayTotalCompleted / DAILY_PAIRS);
  const cycleText = cycleTimes > 0 ? `（已循环 ${cycleTimes} 次）` : "";

  $("#progressStr").textContent = `${completedToday} / ${DAILY_PAIRS} ${cycleText}`.trim();

  const mode = $("#displayMode").value;
  const esText = $("#esText");
  const zhText = $("#zhText");

  const currentPair = state.dayBatchIds[state.dayBatchPointer];
  // 播放过程中显示策略会在 speak 阶段更新，这里只做“基础显示”
  if (mode === "esOnly") {
    zhText.style.display = "none";
  } else if (mode === "esThenZh") {
    // 根据是否已进入中文播报控制显示：用 aria 属性做轻量状态
    const inZh = esText.dataset.inZh === "1";
    zhText.style.display = inZh ? "block" : "none";
  } else {
    zhText.style.display = "block";
  }

  // 当前文本
  if (currentPair != null && state.pairs[currentPair]) {
    esText.textContent = state.pairs[currentPair].es;
    zhText.textContent = state.pairs[currentPair].zh;
  }
}

function cancelSpeech({ bumpToken = false } = {}) {
  try {
    window.speechSynthesis && window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
  if (bumpToken) state.playToken += 1;
}

function speakText(text, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error("speechSynthesis not supported"));
      return;
    }

    const u = new SpeechSynthesisUtterance(text);
    if (opts.lang) u.lang = opts.lang;
    if (opts.voice) u.voice = opts.voice;
    if (typeof opts.rate === "number") u.rate = opts.rate;
    if (typeof opts.pitch === "number") u.pitch = opts.pitch;
    if (typeof opts.volume === "number") u.volume = opts.volume;

    u.onend = () => resolve();
    u.onerror = (e) => reject(e);

    window.speechSynthesis.speak(u);
  });
}

async function playCurrentPair() {
  if (!state.pairs.length || !state.dayBatchIds.length) return;

  const token = (state.playToken += 1);

  // 若页面一直开着到第二天：切换到“当天”的 50 对批次
  const today = getLocalDateStr();
  if (state.todayStr !== today) {
    buildTodayBatchIfNeeded();
  }

  const pairId = state.dayBatchIds[state.dayBatchPointer];
  const pair = state.pairs[pairId];
  if (!pair) return;

  // 开始时：假如是 esThenZh，先只显示西语
  const mode = $("#displayMode").value;
  $("#esText").dataset.inZh = "0";
  if (mode === "esOnly") $("#zhText").style.display = "none";
  if (mode === "esThenZh") $("#zhText").style.display = "none";
  if (mode === "both") $("#zhText").style.display = "block";

  // 更新文本
  $("#esText").textContent = pair.es;
  $("#zhText").textContent = pair.zh;
  updateUI();

  const voices = window.__voicesCache || [];
  const voiceEsSelected = $("#voiceEs").value;
  const voiceZhSelected = $("#voiceZh").value;

  const voiceEs =
    voices.find((v) => String(v.name) === voiceEsSelected) ||
    pickVoiceByLang(voices, "es") ||
    null;
  const voiceZh =
    voices.find((v) => String(v.name) === voiceZhSelected) ||
    pickVoiceByLang(voices, "zh") ||
    null;

  const esRate = Number($("#esRate").value);
  const esForTts = normalizeSpanishForTTS(pair.es);
  const repeatCount = state.settings.repeatCount;
  const waitMs = state.settings.waitMs;

  cancelSpeech();
  try {
    for (let rep = 0; rep < repeatCount; rep++) {
      if (token !== state.playToken) return;

      // 每次重复的开始：按显示模式重置中文显示状态
      $("#esText").dataset.inZh = "0";
      if (mode === "esOnly") $("#zhText").style.display = "none";
      if (mode === "esThenZh") $("#zhText").style.display = "none";
      if (mode === "both") $("#zhText").style.display = "block";
      updateUI();

      cancelSpeech();
      await speakText(esForTts, {
        voice: voiceEs || undefined,
        lang: voiceEs?.lang || "es-ES",
        rate: esRate,
      });
      if (token !== state.playToken) return;

      // 西语结束 -> 中文开始
      $("#esText").dataset.inZh = "1";
      if ($("#displayMode").value === "esThenZh") $("#zhText").style.display = "block";
      updateUI();

      cancelSpeech(); // 避免上一次残留影响
      await speakText(pair.zh, {
        voice: voiceZh || undefined,
        lang: voiceZh?.lang || "zh-CN",
        rate: 1.0,
      });
      if (token !== state.playToken) return;

      // 中文结束 -> 等待（用于重复下一次/或下一对）
      await new Promise((r) => setTimeout(r, waitMs));
      if (token !== state.playToken) return;
    }

    // 自动推进下一对：达到 50 后重复当天这一批
    state.todayTotalCompleted += 1;
    state.dayBatchPointer += 1;
    if (state.dayBatchPointer >= state.dayBatchIds.length) {
      state.dayBatchPointer = 0;
    }

    setState();
    updateUI();

    if (state.isPlaying && !state.isPaused) {
      playCurrentPair().catch(() => {
        // 若 TTS 报错，停止播放避免无限报错
        stopPlaying("TTS 播放失败，请手动检查声音权限或浏览器设置。");
      });
    }
  } catch (e) {
    // 如果是“用户点了下一对/上一对/暂停/重置”导致的取消，就别把播放停掉
    if (token !== state.playToken) return;
    stopPlaying("TTS 播放失败，请手动点击“开始播放”，并检查浏览器是否允许语音。");
  }
}

function stopPlaying(message) {
  state.isPlaying = false;
  state.isPaused = false;
  cancelSpeech();
  const pauseBtn = $("#btnPause");
  const resumeBtn = $("#btnResume");
  pauseBtn.disabled = true;
  resumeBtn.disabled = true;
  $("#btnStart").disabled = false;
  if (message) {
    const esText = $("#esText");
    esText.textContent = message;
  }
}

function startPlaying() {
  if (!state.ready) return;
  if (state.isPlaying && !state.isPaused) return;

  state.isPlaying = true;
  state.isPaused = false;
  $("#btnStart").disabled = true;
  $("#btnPause").disabled = false;
  $("#btnResume").disabled = true;
  playCurrentPair().catch(() => {});
}

function pausePlaying() {
  if (!state.isPlaying) return;
  state.isPaused = true;
  cancelSpeech({ bumpToken: true });
  $("#btnPause").disabled = true;
  $("#btnResume").disabled = false;
}

function resumePlaying() {
  if (!state.isPlaying) return startPlaying();
  if (!state.isPaused) return;
  state.isPaused = false;
  $("#btnPause").disabled = false;
  $("#btnResume").disabled = true;
  playCurrentPair().catch(() => {});
}

function nextPair() {
  if (!state.ready) return;
  cancelSpeech({ bumpToken: true });
  state.dayBatchPointer += 1;
  if (state.dayBatchPointer >= state.dayBatchIds.length) state.dayBatchPointer = 0;
  setState();
  updateUI();
  if (state.isPlaying && !state.isPaused) playCurrentPair().catch(() => {});
}

function prevPair() {
  if (!state.ready) return;
  cancelSpeech({ bumpToken: true });
  // prev 不减少 todayTotalCompleted：它是“累计已播放次数”，回看不影响进度语义
  state.dayBatchPointer = Math.max(0, state.dayBatchPointer - 1);
  setState();
  updateUI();
  if (state.isPlaying && !state.isPaused) playCurrentPair().catch(() => {});
}

function resetToday() {
  if (!state.ready) return;
  cancelSpeech({ bumpToken: true });
  state.dayBatchPointer = 0;
  state.todayTotalCompleted = 0;
  state.todayStr = getLocalDateStr();
  // 重新抽今天的 50 对，但不改变“队列抽样之后的指针”更贴近“重新开始当日”
  // 所以我们重新基于当前 queuePointer 重新生成 today batch。
  // 为避免复杂，我们用当天重置只影响 playback position，不回滚抽样指针。
  // 你若希望完全回滚抽样，我可以后续再加开关。
  setState();
  updateUI();
}

function buildTodayBatchIfNeeded() {
  const today = getLocalDateStr();

  // 新启动 or 日期变了：重新生成今日批次
  const needsNewDay = !state.todayStr || state.todayStr !== today || !state.dayBatchIds || state.dayBatchIds.length === 0;

  if (!needsNewDay) return;

  state.todayStr = today;
  state.dayBatchPointer = 0;
  state.todayTotalCompleted = 0;

  // 从 queueOrder + queuePointer 里抽 DAILY_PAIRS；抽完更新 queuePointer
  const need = DAILY_PAIRS;
  let remainingNeed = need;
  let ptr = state.queuePointer || 0;

  const batch = [];
  while (remainingNeed > 0) {
    if (!state.queueOrder || state.queueOrder.length === 0) {
      state.queueOrder = [];
      state.queuePointer = 0;
      break;
    }

    if (ptr >= state.queueOrder.length) {
      // 用完一整轮：重新洗牌
      const seed = seedFromStr(`${today}:cycle:${Date.now()}`);
      const rng = makeRng(seed);
      state.queueOrder = shuffleInPlace(state.queueOrder.slice(), rng);
      ptr = 0;
    }

    const takeCount = Math.min(remainingNeed, state.queueOrder.length - ptr);
    const slice = state.queueOrder.slice(ptr, ptr + takeCount);
    batch.push(...slice);
    ptr += takeCount;
    remainingNeed -= takeCount;

    if (remainingNeed > 0 && ptr >= state.queueOrder.length) {
      // 继续填剩下的：洗牌后再抽
      const seed = seedFromStr(`${today}:cycle:${Date.now()}:${batch.length}`);
      const rng = makeRng(seed);
      state.queueOrder = shuffleInPlace(state.queueOrder.slice(), rng);
      ptr = 0;
    }
  }

  state.dayBatchIds = batch;
  state.queuePointer = ptr;
  setState();
  updateUI();
}

function initVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return;

  function populate() {
    const voices = synth.getVoices ? synth.getVoices() : [];
    window.__voicesCache = voices || [];
    const voiceEs = $("#voiceEs");
    const voiceZh = $("#voiceZh");
    const esList = (voices || []).filter((v) => (v.lang || "").toLowerCase().startsWith("es"));
    const zhList = (voices || []).filter((v) => (v.lang || "").toLowerCase().startsWith("zh"));

    // 保底：把所有 voices 也放进去，避免列表为空导致选项缺失
    const allList = voices || [];

    voiceEs.innerHTML = "";
    voiceZh.innerHTML = "";

    const esPick = esList.length ? esList : allList;
    const zhPick = zhList.length ? zhList : allList;

    for (const v of esPick) {
      const opt = document.createElement("option");
      opt.value = String(v.name);
      opt.textContent = `${v.name} (${v.lang || "unknown"})`;
      voiceEs.appendChild(opt);
    }
    for (const v of zhPick) {
      const opt = document.createElement("option");
      opt.value = String(v.name);
      opt.textContent = `${v.name} (${v.lang || "unknown"})`;
      voiceZh.appendChild(opt);
    }

    // 选择“最像”的默认；优先使用你指定的 Google español (es-ES)
    const lowerVoices = (voices || []).map((v) => ({
      v,
      nameLower: String(v.name || "").toLowerCase(),
      langLower: String(v.lang || "").toLowerCase(),
    }));

    // 1) 绝对优先：es-ES / España / Spain
    const spainEs =
      lowerVoices.find((x) => x.langLower === "es-es")?.v ||
      lowerVoices.find((x) => x.langLower.includes("es-es"))?.v ||
      lowerVoices.find((x) => x.nameLower.includes("españa"))?.v ||
      lowerVoices.find((x) => x.nameLower.includes("spain"))?.v ||
      null;

    // 2) 其次：你桌面端截图的 Google español（es-ES）
    const googleEs =
      lowerVoices.find(
        (x) =>
          x.nameLower.includes("google español") && x.langLower.includes("es-es")
      )?.v || null;

    // 3) 最后：普通西语 voice
    const defEs = spainEs || googleEs || pickVoiceByLang(esPick, "es") || esPick[0] || null;
    const defZh = pickVoiceByLang(zhPick, "zh") || zhPick[0] || null;
    if (defEs) voiceEs.value = String(defEs.name);
    if (defZh) voiceZh.value = String(defZh.name);
  }

  populate();
  synth.onvoiceschanged = populate;
}

function wireUI() {
  $("#btnStart").addEventListener("click", () => startPlaying());
  $("#btnPause").addEventListener("click", () => pausePlaying());
  $("#btnResume").addEventListener("click", () => resumePlaying());
  $("#btnNext").addEventListener("click", () => nextPair());
  $("#btnPrev").addEventListener("click", () => prevPair());
  $("#btnResetDay").addEventListener("click", () => resetToday());

  $("#esRate").addEventListener("input", () => {
    $("#esRateLabel").textContent = Number($("#esRate").value).toFixed(2);
  });

  $("#repeatCount").addEventListener("input", () => {
    const v = Number($("#repeatCount").value);
    state.settings.repeatCount = Math.min(10, Math.max(1, Math.round(v)));
    $("#repeatCountLabel").textContent = String(state.settings.repeatCount);
    saveSettings();
  });

  $("#waitSeconds").addEventListener("input", () => {
    const v = Number($("#waitSeconds").value);
    const clamped = Math.min(10, Math.max(0, v));
    state.settings.waitSeconds = clamped;
    state.settings.waitMs = clamped * 1000;
    $("#waitSecondsLabel").textContent = Number(clamped).toFixed(1);
    $("#waitSecondsHint").textContent = Number(clamped).toFixed(1);
    saveSettings();
  });

  $("#displayMode").addEventListener("change", () => updateUI());
}

async function loadCSV() {
  const res = await fetch("./例句.csv", { cache: "no-store" });
  const text = await res.text();
  const rows = parseCSV(text);
  if (!rows || rows.length < 2) throw new Error("CSV rows empty");

  // 跳过表头：如果第一行像“西班牙语例句,中文翻译”
  const maybeHeader = rows[0] || [];
  const hasHeader = safeText(maybeHeader[0]) === "西班牙语例句" && safeText(maybeHeader[1]) === "中文翻译";
  const startIndex = hasHeader ? 1 : 0;

  const pairs = [];
  for (let i = startIndex; i < rows.length; i++) {
    const r = rows[i] || [];
    const es = safeText(r[ES_COL_INDEX]);
    const zh = safeText(r[ZH_COL_INDEX]);
    if (!es && !zh) continue;
    pairs.push({ es, zh });
  }
  state.pairs = pairs;
}

function initQueueAndStateAfterCSV() {
  // 从本地恢复（如果没有就初始化）
  const persist = getState();

  // 初始化队列：一开始没队列则创建
  if (persist && Array.isArray(persist.queueOrder) && persist.queueOrder.length) {
    state.queueOrder = persist.queueOrder;
    state.queuePointer = typeof persist.queuePointer === "number" ? persist.queuePointer : 0;
  } else {
    // queueOrder: [0..pairs.length-1] 洗牌
    state.queueOrder = Array.from({ length: state.pairs.length }, (_, i) => i);
    const seed = seedFromStr(`init:${state.pairs.length}:${Date.now()}`);
    const rng = makeRng(seed);
    state.queueOrder = shuffleInPlace(state.queueOrder, rng);
    state.queuePointer = 0;
  }

  state.todayStr = persist?.todayStr || "";
  state.dayBatchIds = persist?.dayBatchIds || [];
  state.dayBatchPointer = typeof persist?.dayBatchPointer === "number" ? persist.dayBatchPointer : 0;
  state.todayTotalCompleted = typeof persist?.todayTotalCompleted === "number" ? persist.todayTotalCompleted : 0;

  // 如果旧数据长度与当前 CSV 不一致，重置队列与进度
  if (state.queueOrder.length !== state.pairs.length) {
    state.queueOrder = Array.from({ length: state.pairs.length }, (_, i) => i);
    const seed = seedFromStr(`reinit:${state.pairs.length}:${Date.now()}`);
    const rng = makeRng(seed);
    state.queueOrder = shuffleInPlace(state.queueOrder, rng);
    state.queuePointer = 0;
    state.todayStr = "";
    state.dayBatchIds = [];
    state.dayBatchPointer = 0;
    state.todayTotalCompleted = 0;
  }
}

async function init() {
  wireUI();
  loadSettings();
  applySettingsToUI();
  initVoices();

  try {
    await loadCSV();
  } catch (e) {
    $("#esText").textContent = "加载 CSV 失败：请确保 `例句.csv` 与此网页同目录，并且文件编码/权限正常。";
    $("#zhText").textContent = "";
    return;
  }

  initQueueAndStateAfterCSV();
  buildTodayBatchIfNeeded();

  // 初始显示今日第一对文本（不自动播放）
  const pairId = state.dayBatchIds[state.dayBatchPointer];
  if (pairId != null && state.pairs[pairId]) {
    state.dayBatchPointer = state.dayBatchPointer;
    $("#esText").textContent = state.pairs[pairId].es;
    $("#zhText").textContent = state.pairs[pairId].zh;
  }

  // 初始 UI 状态
  updateUI();
  state.ready = true;
  $("#btnStart").disabled = false;
}

document.addEventListener("DOMContentLoaded", () => {
  $("#btnStart").disabled = false;
  init().catch(() => {
    $("#esText").textContent = "初始化失败：请刷新页面后重试。";
  });
});

