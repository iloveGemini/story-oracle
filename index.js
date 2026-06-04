/*
 * 故事神谕（Story Oracle）—— SillyTavern 的侧边问答窗口。
 *
 * 让你在不污染主聊天的前提下，向 LLM 询问关于当前剧情的问题。窗口拥有自己
 * 独立的问答历史（永不写入 `chat`），会自动把当前角色卡 + 最近的对话记录作为
 * 上下文，并可随时清空。
 *
 * 两种连接模式（均兼容 OpenAI 接口）：
 *   - "direct"  ：浏览器直接请求你的端点（需自行填写 URL + 密钥 + 模型）。
 *                 视服务器配置，可能会被 CORS 拦截。
 *   - "profile" ：通过 SillyTavern 后端，使用你保存的某个连接配置文件转发请求。
 *                 不会有 CORS 问题。
 */

const MODULE = 'storyOracle';

const DEFAULT_SYSTEM_PROMPT =
`你是「故事神谕」，一个为正在进行的角色扮演/故事服务的“戏外”分析者。
下方提供了当前的故事上下文（角色信息与最近的对话记录）。
请基于这些上下文，准确地回答用户关于这个故事的问题。

规则：
- 你不是故事里的角色。不要进行角色扮演、旁白叙述，也不要续写剧情。
- 除非用户要求展开细节，否则请简明、直接地回答。
- 如果某些内容在所提供的上下文中并不存在，请如实说明，不要凭空编造。`;

const DIAGNOSE_SYSTEM_PROMPT =
`你是一个用于 SillyTavern 角色扮演的 MVU 变量修复助手。玩家的状态由 MVU 框架追踪，它会应用故事模型每一回合发出的更新指令。有时这些更新是错误的，而你的工作就是修正它们。

你会收到：
- 角色卡 MVU 规则（位于世界书部分）：本角色卡中合法路径、类型、取值范围，以及各字段更新约束（即 “check” 规则）的权威定义。不同角色卡的规则各不相同——只依据这里提供的规则，绝不要套用其它配置下的假设。
- 当前变量状态（stat_data），以 JSON 形式给出：此刻的实时数值，且已经是在最新一次更新被应用之后的结果。
- 最新更新区块：故事模型在最新一条回复中发出的 <UpdateVariable>。
- 最近的故事对话记录：用于判断这些数值“应该”是多少。

至关重要——当前状态才是事实依据，而非更新区块：
- 当前状态已经反映了最新更新实际造成的一切结果。MVU 是有容错能力的：它可能把一次局部插入补全为完整 schema、从轻微的 JSON 格式错误中恢复，或采用合并而非整体覆盖。因此你必须依据状态所“显示”的结果来判断，而不是依据某个操作“看起来会”造成什么。
- 在评论任何操作之前，先检查它的效果是否已经体现在当前状态中。如果效果已经在那里，那么该操作就是成功的——不要把它描述成可能失败、覆盖、重复或未生效的样子。请直接说明它已生效。
- 只报告状态确凿显示出来的问题。不要使用推测或假设性的措辞（“会覆盖”“可能失败”“取决于实现”）。如果你无法在当前状态中指出一个具体的错误数值，那它就不是缺陷——不要提出。
- 一个操作“冗余”（它设置的值本来就已经正确）并不是缺陷。不要把冗余或风格选择当成问题。对一个新的对象键使用 \`insert\` 是添加条目的正确操作——只要该条目已存在于状态中，就绝不要把它判为错误。

什么才算真正的缺陷（只标记这些，且仅当它们在当前状态中可见时）：
- 当前状态中某个值与剧情矛盾，或违反了角色卡 MVU 规则中的某条规则/范围/类型。
- 数据被丢弃或丢失——例如模型显然想要设置的某个字段，因为用错了键名或路径，在状态中变为空或缺失。
- 在规则要求具体空值的地方却出现了 null；本应是数字却被存成了带引号的字符串；或出现了规则不允许的操作。

你的任务：
1. 诊断。逐项核对最新更新在当前状态中体现出的效果。对每一项，说明它是否正确生效。然后只列出真正的缺陷（依照上面的定义），每一条都对应当前状态中的一个具体数值。
2. 简明、平实地解释每个缺陷。
3. 生成一份纠正补丁——最小且保守。只修正确凿错误的字段。不要改动已经正确的字段，也不要去“优化”或丰富那些并无缺陷的值。
   如果用户要求你审计整个状态，而不只是最新一次更新，那就照做——把当前 stat_data 与完整对话记录进行核对，修正任何偏差，但同样要保守。

输出规则：
- 严格按照角色卡规则所规定的根相对路径书写（例如 /主角状态/修为/进度百分比）。
- 使用与角色卡相同的那套 JSONPatch 操作（replace、delta、insert、remove、move）。delta 的值是裸数字，不是字符串。绝不要使用 null——请使用一个具体的空值。
- 你写入的每个字段都要匹配 schema 中的类型。如果某字段是一个有类型的对象（例如带有 类型/效果/层数/剩余时间/来源 的状态效果），就要写出那个对象的结构——绝不要把纯文本字符串塞进一个有类型的对象槽位里。保留同级的其它数据；只改动你有意修复的部分。
- 不要编造剧情事实。只使用对话记录与角色信息中确实陈述过的内容；不要添加文本里没有的细节（日期、地名、事件）。
- 补丁会通过 MVU 自己的管线、叠加在当前状态之上应用，所以请把它写成针对当前 stat_data 的补丁，而不是整体重写。
- 把最终的纠正指令放进回复末尾的一个 <UpdateVariable> 区块里，严格采用如下结构，以便能被自动应用：

<UpdateVariable>
<Analysis>对所做修复的简短中文说明</Analysis>
<JSONPatch>
[ ...纠正操作... ]
</JSONPatch>
</UpdateVariable>

- 如果实际上没有任何问题，请如实说明，并在 JSONPatch 中输出一个空数组（[]）。一次没有缺陷的干净更新是合法且常见的结果——不要为了凑出一个补丁而制造问题。`;

const defaults = {
    mode: 'direct',            // 'direct' | 'profile'
    // direct mode
    endpoint: '',
    apiKey: '',
    model: '',
    stream: true,
    // profile mode
    profileId: '',
    // shared generation params
    temperature: 0.7,
    maxTokens: 800,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    contextDepth: 30,          // last N non-system messages; -1 = entire chat; 0 = none
    includeCard: true,
    applyRegex: true,          // run ST's prompt-altering regex (thinking strip, summaries, etc.)
    worldInfoMode: 'off',      // 'off' | 'st' (constant + keyword) | 'all' (every entry)
    sendTemperature: true,     // include temperature in the request (some models reject it)
    // window geometry
    winLeft: null,
    winTop: null,
    winWidth: 380,
    winHeight: 540,
};

// In-memory side-chat history (cleared on page reload or via the Clear button).
let convo = [];
let isGenerating = false;
let abortCtl = null;
// Cached ST regex engine module: null = not tried, false = unavailable, object = loaded.
let regexEngine = null;
// Cached ST world-info module (for "all entries" mode).
let worldInfoModule = null;
// World-info text computed (async) in onSend, read (sync) in buildSystemPrompt.
let worldInfoBlock = '';
// Diagnose mode state.
let diagnoseMode = false;
let diagStatData = '';      // stringified current stat_data, computed in onSend
let diagLatestUpdate = '';  // raw <UpdateVariable> block from the latest AI reply
let mvuApi = null;          // cached window.Mvu
// Last prompt actually sent (for the debug viewer), captured in onSend.
let lastPrompt = null;
let lastPromptMeta = null;

jQuery(() => {
    try {
        init();
    } catch (e) {
        console.error('[Story Oracle] init failed:', e);
    }
});

function getCtx() {
    return SillyTavern.getContext();
}

function getSettings() {
    const ctx = getCtx();
    if (!ctx.extensionSettings[MODULE] || typeof ctx.extensionSettings[MODULE] !== 'object') {
        ctx.extensionSettings[MODULE] = {};
    }
    const s = ctx.extensionSettings[MODULE];
    // Fill in any missing defaults IN PLACE so the reference stays stable.
    // (Rebuilding the object here would orphan the values written by event handlers.)
    for (const [k, v] of Object.entries(defaults)) {
        if (!(k in s)) s[k] = v;
    }
    return s;
}

function save() {
    getCtx().saveSettingsDebounced();
}

function init() {
    getSettings();
    injectWandButton();
    buildWindow();
    loadRegexEngine(); // warm the cache so it's ready by first send
}

/**
 * Lazily import SillyTavern's regex engine from its served path. The absolute
 * URL resolves against ST's web root, so it works whether this extension lives
 * in the data dir or in third-party. Returns the module, or false if unavailable.
 */
async function loadRegexEngine() {
    if (regexEngine !== null) return regexEngine;
    try {
        const mod = await import('/scripts/extensions/regex/engine.js');
        regexEngine = (mod && mod.getRegexedString && mod.regex_placement) ? mod : false;
        if (!regexEngine) console.warn('[Story Oracle] regex engine loaded but missing exports; sending raw text.');
    } catch (e) {
        console.warn('[Story Oracle] Could not load regex engine; sending raw messages.', e);
        regexEngine = false;
    }
    return regexEngine;
}

async function loadWorldInfoModule() {
    if (worldInfoModule !== null) return worldInfoModule;
    try {
        const mod = await import('/scripts/world-info.js');
        worldInfoModule = (mod && mod.getSortedEntries) ? mod : false;
    } catch (e) {
        console.warn('[Story Oracle] Could not load world-info module.', e);
        worldInfoModule = false;
    }
    return worldInfoModule;
}

/**
 * Build the world-info / lorebook block for the system prompt.
 *   'st'  -> faithful ST scan: constant (blue) entries always, keyword (green)
 *            entries only when their keys match the chat/card. Uses a dry run so
 *            it never disturbs the main chat's sticky/cooldown state.
 *   'all' -> every non-disabled entry from the active books, regardless of keys.
 */
async function buildWorldInfo(forceMode) {
    const ctx = getCtx();
    const s = getSettings();
    const mode = forceMode || s.worldInfoMode;
    if (mode === 'off') return '';

    try {
        if (mode === 'all') {
            const mod = await loadWorldInfoModule();
            if (!mod || !mod.getSortedEntries) return '';
            const entries = await mod.getSortedEntries();
            return (entries || [])
                .filter((e) => e && !e.disable && typeof e.content === 'string' && e.content.trim())
                .map((e) => e.content.trim())
                .join('\n\n');
        }

        // 'st' mode — replicate ST's scan input.
        if (typeof ctx.getWorldInfoPrompt !== 'function') return '';
        const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
        const chatForWI = coreChat
            .map((m) => `${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${m.mes}`)
            .reverse(); // most-recent first, as ST does

        let card = {};
        try { card = ctx.getCharacterCardFields() || {}; } catch (e) { /* group/no char */ }
        const globalScanData = {
            personaDescription: card.persona,
            characterDescription: card.description,
            characterPersonality: card.personality,
            characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario,
            creatorNotes: card.creatorNotes,
            trigger: 'normal',
        };

        const budget = Number(ctx.maxContext) > 0 ? Number(ctx.maxContext) : 1048576;
        const res = await ctx.getWorldInfoPrompt(chatForWI, budget, /*isDryRun*/ true, globalScanData);

        // getWorldInfoPrompt buckets the activated entries by insertion position.
        // worldInfoString only holds Before/After Char Defs (positions 0/1), so
        // drain every bucket — otherwise @D, Author's Note, example-message and
        // outlet entries (including *constant* ones) get silently dropped.
        // The `|| []` / `|| {}` guards keep this safe on older ST builds that
        // don't return the newer fields (anBefore/anAfter/outletEntries).
        const parts = [];
        const push = (v) => { if (typeof v === 'string' && v.trim()) parts.push(v.trim()); };

        push(res?.worldInfoBefore);                                    // 0  Before Char Defs
        push(res?.worldInfoAfter);                                     // 1  After Char Defs
        for (const s of (res?.anBefore || [])) push(s);                // 2  Top of AN
        for (const s of (res?.anAfter  || [])) push(s);                // 3  Bottom of AN
        for (const d of (res?.worldInfoDepth || [])) (d?.entries || []).forEach(push); // 4  @D
        for (const e of (res?.worldInfoExamples || [])) push(typeof e === 'string' ? e : e?.content); // 5/6 Example Messages
        for (const arr of Object.values(res?.outletEntries || {})) (arr || []).forEach(push);          // 7  Outlet

        return parts.join('\n\n').trim();
    } catch (e) {
        console.warn('[Story Oracle] World info build failed:', e);
        return '';
    }
}

/*
 * Collect the card's [mvu_update] rule entries straight from the stored
 * world books, bypassing the live WI scan.
 *
 * Why this is needed: MagVarUpdate, in "extra-model-parsing" update mode,
 * strips pure [mvu_update] entries from the lore arrays on the
 * `worldinfo_entries_loaded` event. That event fires inside getSortedEntries,
 * upstream of BOTH getWorldInfoPrompt ('st') and getSortedEntries ('all'),
 * so neither scan mode can see those entries. loadWorldInfo() reads the raw
 * cached book data, which MVU never mutates, so it always sees them.
 *
 * Matching mirrors MVU's own UPDATE_REGEX exactly: /[mvu_update]/i on the
 * comment. Constant-only and enabled-only, per the Diagnose use case.
 * `existingBlock` is the already-built scan block, used to dedupe so we don't
 * repeat an entry the scan already included (e.g. on a non-extra-parsing card).
 */
const MVU_UPDATE_TAG = /\[mvu_update\]/i;

async function collectMvuUpdateRules(existingBlock) {
    const ctx = getCtx();
    const mod = await loadWorldInfoModule();
    if (!mod || typeof mod.getSortedEntries !== 'function' || typeof mod.loadWorldInfo !== 'function') {
        return [];
    }

    // Discover active book names. The entries themselves may have been stripped
    // by MVU, but the books still surface via their surviving (untagged) entries.
    let names = [];
    try {
        const sorted = await mod.getSortedEntries();
        names = [...new Set((sorted || []).map((e) => e && e.world).filter(Boolean))];
    } catch (e) {
        console.warn('[Story Oracle] Could not enumerate world books for MVU rules:', e);
        return [];
    }

    const seen = existingBlock || '';
    const collected = [];
    for (const name of names) {
        let book;
        try { book = await mod.loadWorldInfo(name); } catch (e) { continue; }
        const entries = book && book.entries ? Object.values(book.entries) : [];
        for (const e of entries) {
            if (!e || e.constant !== true || e.disable) continue;
            if (!MVU_UPDATE_TAG.test(e.comment || '')) continue;
            let content = typeof e.content === 'string' ? e.content : '';
            try { content = ctx.substituteParams(content); } catch (_) { /* leave raw */ }
            content = content.trim();
            if (!content) continue;
            if (seen.includes(content)) continue;                 // already in the scan block
            if (collected.some((c) => c.content === content)) continue; // dupe across books
            collected.push({ order: Number(e.order) || 0, content });
        }
    }

    collected.sort((a, b) => a.order - b.order);
    return collected.map((c) => c.content);
}

/* ------------------------------------------------------------------ *
 * MVU (MagVarUpdate via JS-Slash-Runner) integration for Diagnose mode
 * ------------------------------------------------------------------ */
async function getMvu() {
    if (mvuApi) return mvuApi;
    if (window.Mvu) { mvuApi = window.Mvu; return mvuApi; }
    const th = window.TavernHelper;
    if (th && typeof th.waitGlobalInitialized === 'function') {
        try {
            mvuApi = await Promise.race([
                th.waitGlobalInitialized('Mvu'),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);
            if (mvuApi) return mvuApi;
        } catch (e) { /* fall through */ }
    }
    return window.Mvu || null;
}

async function getMvuStatData() {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.getMvuData !== 'function') return null;
    try {
        const data = Mvu.getMvuData({ type: 'message', message_id: 'latest' });
        return (data && data.stat_data) ? data.stat_data : (data ?? null);
    } catch (e) {
        console.warn('[Story Oracle] getMvuData failed:', e);
        return null;
    }
}

function getLatestAiMessageText() {
    const chat = getCtx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && !m.is_user && !m.is_system && typeof m.mes === 'string' && m.mes.trim()) return m.mes;
    }
    return '';
}

function extractUpdateBlock(text) {
    const m = (text || '').match(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/i);
    return m ? m[0] : '';
}

// Apply a corrective <UpdateVariable> block through MVU's own pipeline.
// Returns a snapshot of the pre-apply data (for undo), or null on failure.
async function applyFix(patchBlock, statusEl) {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.parseMessage !== 'function') {
        statusEl.textContent = '未检测到 MVU —— 无法自动应用。';
        statusEl.classList.add('so-hint-error');
        return null;
    }
    const opts = { type: 'message', message_id: 'latest' };
    const oldData = Mvu.getMvuData(opts);
    const snapshot = JSON.parse(JSON.stringify(oldData));
    const newData = await Mvu.parseMessage(patchBlock, oldData);
    if (!newData) {
        statusEl.textContent = '补丁未解析出任何改动 —— 请检查指令。';
        statusEl.classList.add('so-hint-error');
        return null;
    }
    await Mvu.replaceMvuData(newData, opts);
    return snapshot;
}

async function undoFix(snapshot) {
    const Mvu = await getMvu();
    if (!Mvu || typeof Mvu.replaceMvuData !== 'function') throw new Error('MVU not available');
    await Mvu.replaceMvuData(snapshot, { type: 'message', message_id: 'latest' });
}

function injectWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('so-wand-button')) return;

    const item = document.createElement('div');
    item.id = 'so-wand-button';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<i class="fa-solid fa-moon"></i><span>故事神谕</span>`;
    item.addEventListener('click', () => {
        // Just open our window. SillyTavern's own outside-click handler closes
        // the wand menu (our item isn't a no-close target). Do NOT touch
        // #extensionsMenu here: adding .displayNone (display:none !important)
        // permanently breaks ST's fadeIn and the menu never reopens.
        toggleWindow(true);
    });
    menu.appendChild(item);
}

/* ------------------------------------------------------------------ *
 * The floating window
 * ------------------------------------------------------------------ */
let win, messagesEl, inputEl, sendBtn, modeBadge;

function buildWindow() {
    if (document.getElementById('so-window')) return;
    const s = getSettings();

    win = document.createElement('div');
    win.id = 'so-window';
    win.style.display = 'none';
    win.style.width = `${s.winWidth}px`;
    win.style.height = `${s.winHeight}px`;
    if (s.winLeft != null && s.winTop != null) {
        win.style.left = `${s.winLeft}px`;
        win.style.top = `${s.winTop}px`;
        win.style.right = 'auto';
    }

    win.innerHTML = `
        <div id="so-header">
            <div id="so-title"><i class="fa-solid fa-moon"></i> 故事神谕 <span id="so-mode-badge"></span><span id="so-diag-pill">诊断</span></div>
            <div id="so-header-btns">
                <div class="so-iconbtn" id="so-diagnose-btn" title="诊断模式 —— 修复 MVU 状态变量"><i class="fa-solid fa-stethoscope"></i></div>
                <div class="so-iconbtn" id="so-debug-btn" title="查看上一次发送的提示词"><i class="fa-solid fa-bug"></i></div>
                <div class="so-iconbtn" id="so-settings-btn" title="设置"><i class="fa-solid fa-gear"></i></div>
                <div class="so-iconbtn" id="so-clear-btn" title="清空对话"><i class="fa-solid fa-trash-can"></i></div>
                <div class="so-iconbtn" id="so-close-btn" title="关闭"><i class="fa-solid fa-xmark"></i></div>
            </div>
        </div>

        <div id="so-settings">
            <label class="so-row"><span>连接模式</span>
                <select id="so-mode">
                    <option value="direct">直连（自定义 URL）</option>
                    <option value="profile">连接配置文件</option>
                </select>
            </label>

            <div id="so-direct-fields">
                <label class="so-field"><span>端点 URL</span>
                    <input id="so-endpoint" type="text" placeholder="https://your-proxy.com/v1">
                </label>
                <label class="so-field"><span>API 密钥</span>
                    <input id="so-apikey" type="password" placeholder="sk-...">
                </label>
                <label class="so-field"><span>模型</span>
                    <div class="so-model-row">
                        <input id="so-model" type="text" placeholder="gpt-4o-mini">
                        <div class="so-iconbtn" id="so-model-fetch" title="从服务商获取可用模型列表"><i class="fa-solid fa-cloud-arrow-down"></i></div>
                    </div>
                    <select id="so-model-list" style="display:none"></select>
                    <div class="so-hint" id="so-model-hint"></div>
                </label>
                <div class="so-hint">如果请求因 CORS / 网络错误失败，请切换到“连接配置文件”模式（通过 ST 服务器转发）。</div>
            </div>

            <div id="so-profile-fields">
                <label class="so-field"><span>配置文件</span>
                    <div class="so-profile-row">
                        <select id="so-profile"></select>
                        <div class="so-iconbtn" id="so-profile-refresh" title="刷新配置文件列表"><i class="fa-solid fa-rotate-right"></i></div>
                    </div>
                </label>
                <div class="so-hint" id="so-profile-hint">使用已保存的连接配置文件，通过 ST 服务器转发（无 CORS 问题）。</div>
            </div>

            <div class="so-grid2">
                <label class="so-field"><span>温度</span>
                    <input id="so-temp" type="number" step="0.05" min="0" max="2">
                </label>
                <label class="so-field"><span>最大 token 数</span>
                    <input id="so-maxtok" type="number" step="50" min="1">
                </label>
            </div>

            <label class="so-check"><input id="so-stream" type="checkbox"><span>流式输出</span></label>

            <label class="so-field"><span>上下文深度（消息条数，-1 = 全部，0 = 不带）</span>
                <input id="so-depth" type="number" step="1" min="-1">
            </label>
            <label class="so-check"><input id="so-card" type="checkbox"><span>包含角色卡（描述 / 性格 / 场景）</span></label>
            <label class="so-check"><input id="so-regex" type="checkbox"><span>应用剧情正则（剥离思维链 / 状态栏、使用总结）—— 与主聊天保持一致</span></label>

            <label class="so-row"><span>世界书 / 知识库</span>
                <select id="so-wi">
                    <option value="off">关闭</option>
                    <option value="st">常驻 + 关键词匹配（ST 默认行为）</option>
                    <option value="all">全部条目（规划用 —— 忽略关键词）</option>
                </select>
            </label>
            <div class="so-hint" id="so-wi-hint"></div>

            <label class="so-check"><input id="so-sendtemp" type="checkbox"><span>发送温度参数（部分拒收该参数的模型请关闭）</span></label>

            <label class="so-field"><span>系统提示词</span>
                <textarea id="so-sysprompt" rows="5"></textarea>
            </label>
        </div>

        <div id="so-messages"></div>

        <div id="so-footer">
            <textarea id="so-input" rows="2" placeholder="就当前剧情提问…（Enter 发送，Shift+Enter 换行）"></textarea>
            <div class="so-iconbtn" id="so-send" title="发送"><i class="fa-solid fa-paper-plane"></i></div>
        </div>

        <div id="so-debug">
            <div id="so-debug-head">
                <span><i class="fa-solid fa-bug"></i> 上一次发送的提示词 <span id="so-debug-meta"></span></span>
                <div style="display:flex;gap:2px;">
                    <div class="so-iconbtn" id="so-debug-copy" title="复制完整提示词"><i class="fa-solid fa-copy"></i></div>
                    <div class="so-iconbtn" id="so-debug-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
            </div>
            <pre id="so-debug-body"></pre>
        </div>
    `;
    document.body.appendChild(win);

    messagesEl = win.querySelector('#so-messages');
    inputEl = win.querySelector('#so-input');
    sendBtn = win.querySelector('#so-send');
    modeBadge = win.querySelector('#so-mode-badge');

    bindControls();
    loadSettingsIntoForm();
    makeDraggable(win, win.querySelector('#so-header'));
    observeResize();
    renderEmptyState();
}

function bindControls() {
    const s = getSettings();

    win.querySelector('#so-close-btn').addEventListener('click', () => toggleWindow(false));
    win.querySelector('#so-clear-btn').addEventListener('click', clearConversation);
    win.querySelector('#so-diagnose-btn').addEventListener('click', toggleDiagnose);
    win.querySelector('#so-debug-btn').addEventListener('click', openDebug);
    win.querySelector('#so-debug-close').addEventListener('click', () => win.querySelector('#so-debug').classList.remove('open'));
    win.querySelector('#so-debug-copy').addEventListener('click', async () => {
        const btn = win.querySelector('#so-debug-copy');
        try {
            await navigator.clipboard.writeText(win.querySelector('#so-debug-body').textContent || '');
            btn.innerHTML = '<i class="fa-solid fa-check"></i>';
            setTimeout(() => { btn.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1200);
        } catch (e) {
            btn.title = '复制失败 —— 请手动选择文本';
        }
    });
    win.querySelector('#so-settings-btn').addEventListener('click', () => {
        const panel = win.querySelector('#so-settings');
        const open = panel.classList.toggle('open');
        if (open) refreshProfiles();
    });
    win.querySelector('#so-profile-refresh').addEventListener('click', refreshProfiles);

    // settings inputs -> persist
    const bind = (id, key, parse = (v) => v) => {
        const el = win.querySelector(id);
        const evt = (el.type === 'checkbox') ? 'change' : 'input';
        el.addEventListener(evt, () => {
            s[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
            if (key === 'mode') {
                applyModeVisibility();
                if (s.mode === 'profile') refreshProfiles();
            }
            updateBadge();
            save();
        });
    };
    bind('#so-mode', 'mode');
    bind('#so-endpoint', 'endpoint', (v) => v.trim());
    bind('#so-apikey', 'apiKey', (v) => v.trim());
    bind('#so-model', 'model', (v) => v.trim());
    bind('#so-stream', 'stream');
    bind('#so-profile', 'profileId');
    bind('#so-temp', 'temperature', (v) => parseFloat(v));
    bind('#so-maxtok', 'maxTokens', (v) => parseInt(v, 10));
    bind('#so-depth', 'contextDepth', (v) => parseInt(v, 10));
    bind('#so-card', 'includeCard');
    bind('#so-regex', 'applyRegex');
    bind('#so-wi', 'worldInfoMode');
    bind('#so-sendtemp', 'sendTemperature');
    win.querySelector('#so-wi').addEventListener('change', updateWiHint);
    bind('#so-sysprompt', 'systemPrompt');

    // send
    sendBtn.addEventListener('click', onSend);
    win.querySelector('#so-model-fetch').addEventListener('click', onFetchModels);
    win.querySelector('#so-model-list').addEventListener('change', (e) => {
        const val = e.target.value;
        if (!val) return;
        const input = win.querySelector('#so-model');
        input.value = val;
        s.model = val;
        updateBadge();
        save();
    });
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
        }
    });
}

function loadSettingsIntoForm() {
    const s = getSettings();
    win.querySelector('#so-mode').value = s.mode;
    win.querySelector('#so-endpoint').value = s.endpoint;
    win.querySelector('#so-apikey').value = s.apiKey;
    win.querySelector('#so-model').value = s.model;
    win.querySelector('#so-stream').checked = !!s.stream;
    win.querySelector('#so-temp').value = s.temperature;
    win.querySelector('#so-maxtok').value = s.maxTokens;
    win.querySelector('#so-depth').value = s.contextDepth;
    win.querySelector('#so-card').checked = !!s.includeCard;
    win.querySelector('#so-regex').checked = !!s.applyRegex;
    win.querySelector('#so-wi').value = s.worldInfoMode;
    win.querySelector('#so-sendtemp').checked = !!s.sendTemperature;
    updateWiHint();
    win.querySelector('#so-sysprompt').value = s.systemPrompt;
    applyModeVisibility();
    updateBadge();
}

function applyModeVisibility() {
    const s = getSettings();
    win.querySelector('#so-direct-fields').style.display = s.mode === 'direct' ? '' : 'none';
    win.querySelector('#so-profile-fields').style.display = s.mode === 'profile' ? '' : 'none';
}

function updateWiHint() {
    const hint = win.querySelector('#so-wi-hint');
    if (!hint) return;
    const mode = win.querySelector('#so-wi').value;
    if (mode === 'st') {
        hint.textContent = '像主提示词一样扫描聊天：蓝色（常驻）条目始终注入，绿色（关键词）条目在其关键词匹配时注入。';
    } else if (mode === 'all') {
        hint.textContent = '无视关键词，发送所有已启用的世界书条目。适合做规划，但可能会消耗大量 token。';
    } else {
        hint.textContent = '';
    }
}

function updateBadge() {
    const s = getSettings();
    let label = '';
    if (s.mode === 'direct') {
        label = s.model || '未设置模型';
    } else {
        const p = getProfiles().find((x) => x.id === s.profileId);
        label = p ? p.name : '未选择配置文件';
    }
    modeBadge.textContent = label ? `· ${label}` : '';
}

function getProfiles() {
    const ctx = getCtx();
    // Preferred: the service-filtered list (only types we can actually send to).
    try {
        const supported = ctx.ConnectionManagerRequestService?.getSupportedProfiles?.();
        if (Array.isArray(supported) && supported.length) return supported;
    } catch (e) {
        console.warn('[Story Oracle] getSupportedProfiles failed, falling back to raw profiles:', e);
    }
    // Fallback: raw saved profiles. Covers version differences and over-strict filtering.
    const raw = ctx.extensionSettings?.connectionManager?.profiles;
    return Array.isArray(raw) ? raw.filter((p) => p && p.id) : [];
}

function profilesStatus() {
    const ctx = getCtx();
    if (!ctx.ConnectionManagerRequestService) {
        return '当前 ST 版本未找到连接管理器 —— 请改用直连模式。';
    }
    const raw = ctx.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(raw) || raw.length === 0) {
        return '未找到已保存的配置文件。请先在 ST 的“连接配置文件”面板中创建一个（API 设置里的书签图标）。';
    }
    return '存在配置文件，但似乎没有兼容的。请尝试刷新按钮，或改用直连模式。';
}

function refreshProfiles() {
    const s = getSettings();
    const sel = win.querySelector('#so-profile');
    const hint = win.querySelector('#so-profile-hint');
    const profiles = getProfiles();
    sel.innerHTML = '';
    if (!profiles.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '— 无 —';
        sel.appendChild(opt);
        if (hint) hint.textContent = profilesStatus();
        return;
    }
    if (hint) hint.textContent = '通过 ST 服务器转发（无 CORS）。新增配置文件后请点击刷新。';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        sel.appendChild(opt);
    }
    if (s.profileId && profiles.some((p) => p.id === s.profileId)) {
        sel.value = s.profileId;
    } else {
        s.profileId = sel.value;
        save();
    }
    updateBadge();
}

/* ------------------------------------------------------------------ *
 * Show / hide
 * ------------------------------------------------------------------ */
function toggleWindow(show) {
    if (!win) return;
    const visible = win.style.display !== 'none';
    const next = (show === undefined) ? !visible : show;
    win.style.display = next ? 'flex' : 'none';
    if (next) {
        // Re-trigger the open animation each time the window is shown.
        win.classList.remove('so-opening');
        void win.offsetWidth; // force reflow so the animation restarts
        win.classList.add('so-opening');
        inputEl.focus();
    }
}

function toggleDiagnose() {
    diagnoseMode = !diagnoseMode;
    win.classList.toggle('so-diag-on', diagnoseMode);
    win.querySelector('#so-diagnose-btn').classList.toggle('so-diag-active', diagnoseMode);
    inputEl.placeholder = diagnoseMode
        ? '描述哪里看起来不对，或让我检查最新一次更新 / 审计当前状态…'
        : '就当前剧情提问…（Enter 发送，Shift+Enter 换行）';
    if (diagnoseMode) {
        addSystemNote('诊断模式已开启。我会把最新一条 AI 回复中的变量更新，对照本角色卡的 MVU 规则与当前状态进行检查，然后给出一份你可以一键应用的纠正补丁。可以让我检查它、指出哪里看起来不对，或者直接说“审计整个状态”。');
    } else {
        addSystemNote('已返回普通聊天模式。');
    }
    inputEl.focus();
}

function formatPrompt(msgs) {
    return msgs.map((m) => {
        const role = (m.role || '?').toUpperCase();
        return `┌─────────── ${role} ───────────\n${m.content || ''}`;
    }).join('\n\n');
}

function openDebug() {
    const panel = win.querySelector('#so-debug');
    const body = win.querySelector('#so-debug-body');
    const meta = win.querySelector('#so-debug-meta');
    if (!lastPrompt || !lastPrompt.length) {
        meta.textContent = '';
        body.textContent = '还没有发送过任何提示词。请先向故事神谕提问，然后再打开此面板。';
    } else {
        meta.textContent = lastPromptMeta
            ? `· ${lastPromptMeta.mode} · ${lastPromptMeta.target} · ${lastPromptMeta.chars.toLocaleString()} chars · ${lastPromptMeta.time}`
            : '';
        body.textContent = formatPrompt(lastPrompt);
    }
    panel.classList.add('open');
    body.scrollTop = 0;
}

/* ------------------------------------------------------------------ *
 * Context assembly
 * ------------------------------------------------------------------ */
function buildSystemPrompt() {
    const ctx = getCtx();
    const s = getSettings();

    if (diagnoseMode) return buildDiagnosePrompt(ctx, s);

    const parts = [s.systemPrompt];

    if (s.includeCard) {
        parts.push(buildCardSection(ctx));
    }

    if (worldInfoBlock) {
        parts.push('=== 世界书 / 设定 ===\n' + worldInfoBlock);
    }

    const transcript = buildTranscript(ctx, s);
    if (transcript) {
        parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);
    }

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

function buildDiagnosePrompt(ctx, s) {
    const parts = [DIAGNOSE_SYSTEM_PROMPT];

    // World info carries the card's MVU rules (blue/constant entries always fire).
    parts.push('=== 角色卡 MVU 规则（来自世界书）===\n' +
        (worldInfoBlock || '（未找到世界书规则 —— 诊断结果可能不完整）'));

    parts.push('=== 当前变量状态（stat_data）===\n' +
        (diagStatData || '（不可用 —— 未检测到 MVU 框架）'));

    parts.push('=== 最新更新区块（待检查的更新）===\n' +
        (diagLatestUpdate || '（在最新一条 AI 回复中未找到 <UpdateVariable> 区块）'));

    if (s.includeCard) parts.push(buildCardSection(ctx));

    const transcript = buildTranscript(ctx, s);
    if (transcript) parts.push('=== 故事对话记录（最新的在最后）===\n' + transcript);

    const full = parts.filter(Boolean).join('\n\n');
    try { return ctx.substituteParams(full); } catch (e) { return full; }
}

function buildCardSection(ctx) {
    const cardLines = [];
    try {
        const f = ctx.getCharacterCardFields();
        if (ctx.name2) cardLines.push(`角色：${ctx.name2}`);
        if (ctx.name1) cardLines.push(`用户 / Persona：${ctx.name1}`);
        if (f.description) cardLines.push(`描述：\n${f.description}`);
        if (f.personality) cardLines.push(`性格：\n${f.personality}`);
        if (f.scenario) cardLines.push(`场景：\n${f.scenario}`);
        if (f.persona) cardLines.push(`Persona：\n${f.persona}`);
    } catch (e) { /* group chat or no char selected */ }
    return cardLines.length ? '=== 角色 / 设定 ===\n' + cardLines.join('\n\n') : '';
}

function buildTranscript(ctx, s) {
    if (s.contextDepth === 0) return '';
    // Mirror ST's prompt builder: filter system messages, then run each through
    // the regex engine with isPrompt:true and a depth relative to the FULL chat
    // (so depth-gated scripts like summary substitution fire as they would in chat).
    const coreChat = (ctx.chat || []).filter((m) => m && !m.is_system && typeof m.mes === 'string');
    const useRegex = s.applyRegex && regexEngine && regexEngine.getRegexedString;

    let processed = coreChat.map((m, index) => {
        let text = m.mes;
        if (useRegex) {
            const placement = m.is_user
                ? regexEngine.regex_placement.USER_INPUT
                : regexEngine.regex_placement.AI_OUTPUT;
            const depth = coreChat.length - index - 1; // last message = depth 0
            try {
                text = regexEngine.getRegexedString(text, placement, { isPrompt: true, depth });
            } catch (e) {
                console.warn('[Story Oracle] regex failed on a message; using raw.', e);
            }
        }
        return { name: m.name || (m.is_user ? ctx.name1 : ctx.name2), text };
    });

    processed = processed.filter((l) => l.text && l.text.trim() !== '');
    if (s.contextDepth > 0) processed = processed.slice(-s.contextDepth);
    return processed.map((l) => `${l.name}: ${l.text}`).join('\n\n');
}

function buildMessages() {
    return [{ role: 'system', content: buildSystemPrompt() }, ...convo];
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */
async function onSend() {
    if (isGenerating) { stopGeneration(); return; }
    const s = getSettings();
    const text = inputEl.value.trim();
    if (!text) return;

    // validate config
    if (s.mode === 'direct' && (!s.endpoint || !s.model)) {
        addSystemNote('请先在设置（齿轮图标）中填写端点 URL 和模型。');
        return;
    }
    if (s.mode === 'profile' && !s.profileId) {
        addSystemNote('请先在设置（齿轮图标）中选择一个连接配置文件。');
        return;
    }

    inputEl.value = '';
    convo.push({ role: 'user', content: text });
    addMessage('user', text);

    if (s.applyRegex) await loadRegexEngine(); // ensure engine is ready before building context

    if (diagnoseMode) {
        // Force a WI scan so the card's blue rule entries are always present
        // (keep 'all' if the user chose it). Also pull live state + the raw
        // latest <UpdateVariable> block (un-stripped from the stored message).
        worldInfoBlock = await buildWorldInfo(s.worldInfoMode === 'all' ? 'all' : 'st');
        // MVU may strip [mvu_update] rule entries from the scan (extra-model-
        // parsing mode). Recover them from the raw books so Diagnose has the
        // authoritative path/type/check rules it's told to rely on.
        const mvuRules = await collectMvuUpdateRules(worldInfoBlock);
        if (mvuRules.length) {
            worldInfoBlock = [worldInfoBlock, ...mvuRules].filter(Boolean).join('\n\n');
        }
        const stat = await getMvuStatData();
        diagStatData = stat ? JSON.stringify(stat, null, 2) : '';
        diagLatestUpdate = extractUpdateBlock(getLatestAiMessageText());
    } else {
        worldInfoBlock = await buildWorldInfo(); // empty string when mode is 'off'
    }

    const messages = buildMessages();
    // Snapshot the exact prompt for the debug viewer (both modes).
    lastPrompt = messages.map((m) => ({ role: m.role, content: m.content }));
    lastPromptMeta = {
        mode: diagnoseMode ? '诊断' : '聊天',
        target: s.mode === 'direct' ? (s.model || '直连') : '配置文件',
        chars: lastPrompt.reduce((n, m) => n + (m.content ? m.content.length : 0), 0),
        time: new Date().toLocaleTimeString(),
    };
    const assistantEl = addMessage('assistant', '');
    const contentEl = assistantEl.querySelector('.so-content');
    const clearTyping = showTyping(contentEl);
    setGenerating(true);
    abortCtl = new AbortController();

    try {
        let finalText = '';
        if (s.mode === 'direct') {
            const url = normalizeUrl(s.endpoint);
            const body = {
                model: s.model,
                messages,
                max_tokens: s.maxTokens,
            };
            if (s.sendTemperature) body.temperature = s.temperature;
            if (s.stream) {
                contentEl.classList.add('so-streaming');
                finalText = await streamDirect(url, s.apiKey, body, abortCtl.signal, (delta) => {
                    clearTyping();
                    contentEl.textContent += delta;
                    scrollToBottom();
                });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callDirect(url, s.apiKey, body, abortCtl.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        } else {
            const override = s.sendTemperature ? { temperature: s.temperature } : {};
            if (s.stream) {
                contentEl.classList.add('so-streaming');
                finalText = await callProfileStream(s.profileId, messages, s.maxTokens, override, abortCtl.signal, (full) => {
                    clearTyping();
                    contentEl.textContent = full;
                    scrollToBottom();
                });
                contentEl.classList.remove('so-streaming');
            } else {
                finalText = await callProfile(s.profileId, messages, s.maxTokens, override, abortCtl.signal);
                clearTyping();
                contentEl.textContent = finalText;
            }
        }

        clearTyping();
        if (!finalText) {
            contentEl.textContent = '(空回复)';
            contentEl.classList.add('so-error');
        } else {
            convo.push({ role: 'assistant', content: finalText });
            if (diagnoseMode) {
                const block = extractUpdateBlock(finalText);
                if (block) addApplyControls(assistantEl, block);
            }
        }
    } catch (err) {
        clearTyping();
        const aborted = err?.name === 'AbortError';
        contentEl.textContent = aborted ? '(已停止)' : `错误：${err?.message || err}`;
        if (!aborted) contentEl.classList.add('so-error');
        console.error('[Story Oracle]', err);
    } finally {
        setGenerating(false);
        abortCtl = null;
        scrollToBottom();
    }
}

function stopGeneration() {
    try { abortCtl?.abort(); } catch (e) { /* ignore */ }
}

function setGenerating(on) {
    isGenerating = on;
    sendBtn.innerHTML = on ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-paper-plane"></i>';
    sendBtn.title = on ? '停止' : '发送';
    sendBtn.classList.toggle('so-generating', on);
}

/* ---- transports (all OpenAI Chat Completions shaped) ---- */
function normalizeUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u;          // full path given
    if (/\/v\d+$/.test(u)) return u + '/chat/completions';  // ends in /v1, /v2 ...
    return u + '/v1/chat/completions';                      // bare host or base
}

function directHeaders(apiKey) {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
    return h;
}

// Derive the OpenAI-compatible models endpoint from whatever the user typed.
function modelsUrl(u) {
    u = (u || '').trim().replace(/\/+$/, '');
    if (!u) return u;
    if (/\/chat\/completions$/.test(u)) return u.replace(/\/chat\/completions$/, '/models');
    if (/\/models$/.test(u)) return u;
    if (/\/v\d+$/.test(u)) return u + '/models';
    return u + '/v1/models';
}

async function onFetchModels() {
    const s = getSettings();
    const hint = win.querySelector('#so-model-hint');
    const sel = win.querySelector('#so-model-list');
    const btn = win.querySelector('#so-model-fetch');

    if (!s.endpoint) { hint.textContent = '请先填写端点 URL。'; hint.classList.add('so-hint-error'); return; }

    hint.classList.remove('so-hint-error');
    hint.textContent = '正在加载模型…';
    btn.classList.add('so-busy');

    try {
        const url = modelsUrl(s.endpoint);
        const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(20000) : undefined;
        const res = await fetch(url, { method: 'GET', headers: directHeaders(s.apiKey), signal });
        if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
        }
        const data = await res.json();
        // OpenAI: { data: [{id}] }. Tolerate top-level arrays and { models: [...] }.
        let list = Array.isArray(data?.data) ? data.data
            : Array.isArray(data) ? data
            : Array.isArray(data?.models) ? data.models
            : [];
        const ids = [...new Set(
            list.map((m) => (typeof m === 'string' ? m : (m?.id || m?.name))).filter(Boolean)
        )].sort((a, b) => a.localeCompare(b));

        if (!ids.length) { hint.textContent = '服务商未返回任何模型。'; sel.style.display = 'none'; return; }

        sel.innerHTML = '';
        const ph = document.createElement('option');
        ph.value = '';
        ph.textContent = `— 选择一个模型（共 ${ids.length} 个）—`;
        sel.appendChild(ph);
        for (const id of ids) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            sel.appendChild(opt);
        }
        // pre-select the current model if it's in the list
        if (s.model && ids.includes(s.model)) sel.value = s.model;
        sel.style.display = '';
        hint.textContent = `共 ${ids.length} 个模型 —— 选择其一，或继续输入自定义名称。`;
    } catch (err) {
        const aborted = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        hint.textContent = aborted ? '请求超时。' : `获取模型失败：${err?.message || err}`;
        hint.classList.add('so-hint-error');
        sel.style.display = 'none';
        console.error('[Story Oracle] model fetch failed:', err);
    } finally {
        btn.classList.remove('so-busy');
    }
}

async function callDirect(url, apiKey, body, signal) {
    const res = await fetch(url, {
        method: 'POST',
        headers: directHeaders(apiKey),
        body: JSON.stringify({ ...body, stream: false }),
        signal,
    });
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
}

async function streamDirect(url, apiKey, body, signal, onDelta) {
    const res = await fetch(url, {
        method: 'POST',
        headers: directHeaders(apiKey),
        body: JSON.stringify({ ...body, stream: true }),
        signal,
    });
    if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} ${t.slice(0, 300)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep the (possibly partial) last line
        for (let line of lines) {
            line = line.trim();
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') return full;
            try {
                const json = JSON.parse(payload);
                const delta = json?.choices?.[0]?.delta?.content || '';
                if (delta) { full += delta; onDelta(delta); }
            } catch (e) { /* keepalive / non-JSON line */ }
        }
    }
    return full;
}

async function callProfile(profileId, messages, maxTokens, overridePayload, signal) {
    const ctx = getCtx();
    const result = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: false, extractData: true, signal },
        overridePayload || {},
    );
    return result?.content ?? '';
}

async function callProfileStream(profileId, messages, maxTokens, overridePayload, signal, onText) {
    const ctx = getCtx();
    // With stream:true, sendRequest resolves to a function that creates an
    // AsyncGenerator. Each chunk's `.text` is the CUMULATIVE text so far.
    const gen = await ctx.ConnectionManagerRequestService.sendRequest(
        profileId,
        messages,
        maxTokens,
        { stream: true, signal },
        overridePayload || {},
    );
    const iterator = (typeof gen === 'function') ? gen() : gen;
    let full = '';
    for await (const chunk of iterator) {
        if (chunk && typeof chunk.text === 'string') {
            full = chunk.text;
            onText(full);
        }
    }
    return full;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function addMessage(role, content) {
    const wrap = document.createElement('div');
    wrap.className = `so-msg so-${role}`;
    const icon = role === 'user' ? 'fa-user' : 'fa-moon';
    const label = role === 'user' ? '你' : '神谕';
    wrap.innerHTML =
        `<div class="so-avatar"><i class="fa-solid ${icon}"></i></div>` +
        `<div class="so-bubble"><div class="so-role">${label}</div><div class="so-content"></div></div>`;
    wrap.querySelector('.so-content').textContent = content;
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return wrap;
}

// Apply / Undo bar appended to a diagnose reply that contains a corrective patch.
function addApplyControls(assistantEl, patchBlock) {
    const bar = document.createElement('div');
    bar.className = 'so-apply-bar';
    const btn = document.createElement('button');
    btn.className = 'so-apply-btn';
    btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将修复应用到状态';
    const status = document.createElement('span');
    status.className = 'so-apply-status';
    bar.appendChild(btn);
    bar.appendChild(status);
    assistantEl.querySelector('.so-bubble').appendChild(bar);
    scrollToBottom();

    let snapshot = null;
    btn.addEventListener('click', async () => {
        status.classList.remove('so-hint-error');
        if (snapshot) {
            // currently applied -> undo
            btn.disabled = true;
            status.textContent = '正在还原…';
            try {
                await undoFix(snapshot);
                snapshot = null;
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 将修复应用到状态';
                status.textContent = '已还原到之前的状态。';
            } catch (e) {
                status.textContent = '还原失败：' + (e?.message || e);
                status.classList.add('so-hint-error');
            }
            btn.disabled = false;
            return;
        }
        btn.disabled = true;
        status.textContent = '正在应用…';
        try {
            snapshot = await applyFix(patchBlock, status);
            if (snapshot) {
                btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销';
                status.textContent = '已应用 —— 状态已更新。';
            }
        } catch (e) {
            status.textContent = '应用失败：' + (e?.message || e);
            status.classList.add('so-hint-error');
        }
        btn.disabled = false;
    });
}

// Typing-dots indicator placed inside an assistant bubble until the first token.
function showTyping(contentEl) {
    const dots = document.createElement('span');
    dots.className = 'so-typing';
    dots.innerHTML = '<i></i><i></i><i></i>';
    contentEl.appendChild(dots);
    let cleared = false;
    return () => {
        if (cleared) return;
        cleared = true;
        dots.remove();
    };
}

function addSystemNote(text) {
    const wrap = document.createElement('div');
    wrap.className = 'so-note';
    wrap.textContent = text;
    messagesEl.appendChild(wrap);
    scrollToBottom();
}

function renderEmptyState() {
    if (convo.length || messagesEl.children.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'so-empty';
    wrap.innerHTML =
        `<i class="fa-solid fa-moon so-empty-icon"></i>` +
        `<div>关于当前剧情，尽管问吧。</div>` +
        `<div class="so-empty-sub">此窗口与主聊天相互独立。</div>`;
    messagesEl.appendChild(wrap);
}

function clearConversation() {
    convo = [];
    messagesEl.innerHTML = '';
    renderEmptyState();
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Window dragging + resize persistence
 * ------------------------------------------------------------------ */
function makeDraggable(panel, handle) {
    let sx, sy, sl, st, dragging = false;
    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('.so-iconbtn')) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; sl = r.left; st = r.top;
        panel.style.right = 'auto';
        document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const nl = Math.max(0, Math.min(window.innerWidth - 60, sl + e.clientX - sx));
        const nt = Math.max(0, Math.min(window.innerHeight - 40, st + e.clientY - sy));
        panel.style.left = `${nl}px`;
        panel.style.top = `${nt}px`;
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        const s = getSettings();
        s.winLeft = parseInt(panel.style.left, 10);
        s.winTop = parseInt(panel.style.top, 10);
        save();
    });
}

function observeResize() {
    let t;
    const ro = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
            const s = getSettings();
            s.winWidth = win.offsetWidth;
            s.winHeight = win.offsetHeight;
            save();
        }, 400);
    });
    ro.observe(win);
}
