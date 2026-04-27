import { getContext } from '../../../extensions.js';
import { generateQuietPrompt, eventSource, event_types, substituteParams } from '../../../../script.js';

const PLUGIN_ID  = 'schedule-planner';
const MODAL_ID   = 'sp-modal-root';
const FAB_ID     = 'sp-fab';
const THEME_KEY  = 'sp-theme';
const API_KEY    = 'sp-api-cfg';
const POS_KEY    = 'sp-pos';
const SIZE_KEY   = 'sp-size';
const FAB_KEY    = 'sp-fab-show';

// view: 'user' | 'char'   charName: confirmed char name
function getCacheKey(view, charName) {
    const chatId = getContext().chatId;
    if (!chatId) return null;
    const v = view ?? currentView;
    const c = charName ?? charViewName;
    if (v === 'char' && c) return `sp-cache-${chatId}-char-${c}`;
    return `sp-cache-${chatId}-user`;
}

function loadCachedForCurrentChat(view, charName) {
    const key = getCacheKey(view, charName);
    if (!key) return null;
    try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.raw) return renderSchedule(saved.raw, saved.userName || 'Người dùng');
    } catch { /* ignore corrupt cache */ }
    return null;
}

let currentTheme   = localStorage.getItem(THEME_KEY) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night');
let cachedSchedule = null;
let isGenerating   = false;
let settingsOpen   = false;
let dragState      = null;
let resizeState    = null;
let resizeRAF      = null;
let fabDragged     = false;
let fabDragState   = null;
let currentView    = 'user';  // 'user' | 'char'
let charViewName   = null;    // confirmed char name; preserved when switching to user view

const isMobile = () => window.innerWidth <= 640;

// ─── Init ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    injectExtButton();
    injectModal();
    injectFab();
    injectToastContainer();
    // Reset view state and reload cache on chat switch
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentView  = 'user';
        charViewName = null;
        $('.sp-view-btn').removeClass('sp-view-active');
        $(`.sp-view-btn[data-view="user"]`).addClass('sp-view-active');
        cachedSchedule = loadCachedForCurrentChat();
        if ($(`#${MODAL_ID}`).is(':visible') && !isGenerating) {
            if (cachedSchedule) setBody(cachedSchedule);
            else setBody(`<div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Chưa có lịch trình, nhấp vào góc dưới bên phải để tạo</p></div>`);
        }
    });
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', e => {
        if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'day' : 'night');
    });
});

// ─── Config helpers ───────────────────────────────────────────────────────────

function loadCfg() { try { return JSON.parse(localStorage.getItem(API_KEY)) || {}; } catch { return {}; } }
function saveCfg(c) { localStorage.setItem(API_KEY, JSON.stringify(c)); }
function maskKey(k) { return k.length <= 8 ? '•'.repeat(k.length) : '•'.repeat(k.length - 4) + k.slice(-4); }
function fabEnabled() { return localStorage.getItem(FAB_KEY) !== 'false'; }

// ─── Extensions panel ─────────────────────────────────────────────────────────

function injectExtButton() {
    const html = `
        <div id="${PLUGIN_ID}-settings" class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Kế hoạch lịch trình 7 ngày</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="sp-ext-row">
                    <button id="sp-open-btn" class="menu_button menu_button_icon">
                        <i class="fa-solid fa-calendar-days"></i>
                        <span>Mở lịch trình</span>
                    </button>
                    <label class="sp-toggle-label">
                        <input type="checkbox" id="sp-fab-check" ${fabEnabled() ? 'checked' : ''}>
                        Nút nổi
                    </label>
                </div>
            </div>
        </div>`;
    $('#extensions_settings').append(html);
    $('#sp-open-btn').on('click', openSchedule);
    $('#sp-fab-check').on('change', function () {
        localStorage.setItem(FAB_KEY, this.checked ? 'true' : 'false');
        $(`#${FAB_ID}`).toggle(this.checked);
    });
}

function setExtBtnState(state) {
    const $btn = $('#sp-open-btn');
    $btn.removeClass('sp-btn-generating sp-btn-done');
    if (state) $btn.addClass(`sp-btn-${state}`);
    const $fab = $(`#${FAB_ID} .sp-fab-btn`);
    $fab.removeClass('sp-btn-generating sp-btn-done');
    if (state) $fab.addClass(`sp-btn-${state}`);
    // Lock view toggle while generating to prevent mid-flight view switches
    $('.sp-view-toggle').toggleClass('sp-locked', state === 'generating');
}

// ─── FAB ─────────────────────────────────────────────────────────────────────

function injectFab() {
    const savedPos = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
    const mobile = isMobile();
    const posStyle = (!mobile && savedPos)
        ? `left:${savedPos.left}px;top:${savedPos.top}px;right:auto;bottom:auto;`
        : '';
    const html = `<div id="${FAB_ID}" style="position:fixed;z-index:2000000;${posStyle}${fabEnabled() ? '' : 'display:none'}">
        <button class="sp-fab-btn sp-${currentTheme}" title="Lịch trình 7 ngày"
            style="width:44px;height:44px;border-radius:50%;background:#3a3648;color:#d0bcff;border:1.5px solid rgba(208,188,255,0.35);display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,0.5);transform:translateZ(0);clip:auto;">
            <i class="fa-solid fa-calendar-days"></i>
        </button>
    </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    let wasMobile = isMobile();
    window.addEventListener('resize', () => {
        const nowMobile = isMobile();
        if (nowMobile && !wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) { fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = ''; }
            const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
            if (sheet) { sheet.style.left = ''; sheet.style.top = ''; sheet.style.right = '';
                         sheet.style.transform = ''; sheet.style.width = ''; sheet.style.height = ''; sheet.style.maxHeight = ''; }
        } else if (!nowMobile && wasMobile) {
            const fab = document.getElementById(FAB_ID);
            if (fab) {
                const sp = JSON.parse(localStorage.getItem('sp-fab-pos') || 'null');
                if (sp) {
                    fab.style.left   = Math.min(sp.left, window.innerWidth  - 60) + 'px';
                    fab.style.top    = Math.min(sp.top,  window.innerHeight - 60) + 'px';
                    fab.style.right  = 'auto';
                    fab.style.bottom = 'auto';
                }
            }
        }
        wasMobile = nowMobile;
    });

    $(`#${FAB_ID}`).on('mousedown', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top };
        $(document)
            .on('mousemove.fabdrag', function (ev) {
                if (!fabDragState) return;
                if (Math.abs(ev.clientX - fabDragState.startX) > 5 || Math.abs(ev.clientY - fabDragState.startY) > 5) fabDragged = true;
                if (!fabDragged) return;
                const f = document.getElementById(FAB_ID);
                f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ev.clientX - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
                f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ev.clientY - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
                f.style.right  = 'auto';
                f.style.bottom = 'auto';
            })
            .on('mouseup.fabdrag', onFabDragEnd);
    });
    document.getElementById(FAB_ID).addEventListener('touchstart', function (e) {
        fabDragged = false;
        const el   = document.getElementById(FAB_ID);
        const rect = el.getBoundingClientRect();
        fabDragState = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, origLeft: rect.left, origTop: rect.top };
        document.addEventListener('touchmove', onFabTouchMove, { passive: false });
        document.addEventListener('touchend', onFabDragEnd);
    }, { passive: true });

    $(`#${FAB_ID} .sp-fab-btn`).on('click', function () {
        if (!fabDragged) {
            $(`#${MODAL_ID}`).is(':visible') ? closePanel() : openSchedule();
        }
    });
}

function onFabTouchMove(ev) {
    if (!fabDragState) return;
    const ex = ev.touches[0].clientX;
    const ey = ev.touches[0].clientY;
    if (Math.abs(ex - fabDragState.startX) > 5 || Math.abs(ey - fabDragState.startY) > 5) fabDragged = true;
    if (!fabDragged) return;
    ev.preventDefault();
    const f = document.getElementById(FAB_ID);
    f.style.left   = Math.max(0, Math.min(fabDragState.origLeft + ex - fabDragState.startX, window.innerWidth  - f.offsetWidth))  + 'px';
    f.style.top    = Math.max(0, Math.min(fabDragState.origTop  + ey - fabDragState.startY, window.innerHeight - f.offsetHeight)) + 'px';
    f.style.right  = 'auto';
    f.style.bottom = 'auto';
}
function onFabDragEnd() {
    if (fabDragged) {
        const f = document.getElementById(FAB_ID);
        const r = f.getBoundingClientRect();
        localStorage.setItem('sp-fab-pos', JSON.stringify({ left: r.left, top: r.top }));
    }
    fabDragState = null;
    $(document).off('mousemove.fabdrag mouseup.fabdrag');
    document.removeEventListener('touchmove', onFabTouchMove);
    document.removeEventListener('touchend', onFabDragEnd);
}

function injectModal() {
    const cfg = loadCfg();
    const hasCustomApi = !!(cfg.url && cfg.key);
    const html = `
        <div id="${MODAL_ID}" class="sp-root sp-${currentTheme}" style="display:none;position:fixed;z-index:2000001">
            <div class="sp-backdrop"></div>
            <div class="sp-sheet">
                <div class="sp-topbar" id="sp-drag-handle">
                    <span class="sp-topbar-title">Lịch trình 7 ngày</span>
                    <div class="sp-view-toggle">
                        <button class="sp-view-btn sp-view-active" data-view="user">Tôi</button>
                        <button class="sp-view-btn" data-view="char">TA</button>
                    </div>
                    <div class="sp-topbar-actions">
                        <button class="sp-icon-btn sp-settings-btn" title="Cài đặt"><i class="fa-solid fa-gear"></i></button>
                        <button class="sp-icon-btn sp-theme-btn"    title="Chuyển đổi giao diện"><i class="fa-solid fa-circle-half-stroke"></i></button>
                        <button class="sp-icon-btn sp-regen-btn"    title="Tạo lại"><i class="fa-solid fa-rotate-right"></i></button>
                        <button class="sp-icon-btn sp-close-btn"    title="Đóng"><i class="fa-solid fa-xmark"></i></button>
                    </div>
                </div>

                <div id="sp-settings-panel" class="sp-settings-panel" style="display:none">
                    <div class="sp-api-notice ${hasCustomApi ? 'sp-notice-ok' : 'sp-notice-warn'}">
                        <i class="fa-solid ${hasCustomApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
                        ${hasCustomApi
                            ? 'Đã cấu hình API độc lập, tạo dưới nền không ảnh hưởng đến trò chuyện'
                            : 'Chưa cấu hình API độc lập: Trong quá trình tạo sẽ <b>chiếm dụng kênh trò chuyện</b>, không thể trò chuyện đồng thời'}
                    </div>
                    <p class="sp-cfg-hint">API tùy chỉnh (Để trống sẽ sử dụng mô hình hiện tại của SillyTavern)</p>
                    <input id="sp-cfg-url"   class="sp-input" type="url"
                           placeholder="Base URL, ví dụ: https://api.openai.com/v1"
                           value="${escapeAttr(cfg.url || '')}">
                    <div class="sp-key-row">
                        <input id="sp-cfg-key" class="sp-input sp-key-input" type="password"
                               placeholder="API Key" value="${escapeAttr(cfg.key || '')}">
                        <button id="sp-key-toggle" class="sp-eye-btn"><i class="fa-solid fa-eye"></i></button>
                    </div>
                    <div class="sp-model-row">
                        <input id="sp-cfg-model" class="sp-input sp-model-input" type="text"
                               placeholder="Tên mô hình, ví dụ: gpt-4o-mini"
                               value="${escapeAttr(cfg.model || '')}">
                        <button id="sp-fetch-models" class="sp-fetch-btn" title="Tải danh sách mô hình">
                            <i class="fa-solid fa-list"></i>
                        </button>
                    </div>
                    <button id="sp-cfg-save" class="sp-save-btn"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                    <span id="sp-cfg-msg" class="sp-cfg-msg"></span>
                </div>

                <div class="sp-body" id="sp-body">
                    <div class="sp-empty"><i class="fa-regular fa-calendar"></i><p>Nhấp vào nút làm mới ở góc trên bên phải để tạo lịch trình</p></div>
                </div>

                <div class="sp-resize-handle" id="sp-resize-handle">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </div>
            </div>
        </div>`;
    document.documentElement.insertAdjacentHTML('beforeend', html);

    if (cfg.key) $('#sp-cfg-key').val(maskKey(cfg.key)).data('real', cfg.key);

    $(`#${MODAL_ID} .sp-close-btn`).on('click',    closePanel);
    $(`#${MODAL_ID} .sp-theme-btn`).on('click',    toggleTheme);
    $(`#${MODAL_ID} .sp-regen-btn`).on('click',    onRegenClick);
    $(`#${MODAL_ID} .sp-settings-btn`).on('click', toggleSettings);
    $(`#${MODAL_ID} .sp-backdrop`).on('click',     closePanel);

    // View toggle: Tôi / TA
    $(`#${MODAL_ID} .sp-view-toggle`).on('click', '.sp-view-btn', function () {
        if (isGenerating) return;
        const view = $(this).data('view');
        if (view === currentView) return;
        if (view === 'char') {
            if (charViewName) {
                // Already confirmed a char — load directly without picker
                setView('char', charViewName);
                if (cachedSchedule) setBody(cachedSchedule);
                else showEmptyGenerate();
            } else {
                switchToCharView();
            }
        } else {
            setView('user');
            if (cachedSchedule) setBody(cachedSchedule);
            else showEmptyGenerate();
        }
    });

    $('#sp-cfg-save').on('click',      saveSettings);
    $('#sp-key-toggle').on('click',    toggleKeyVisibility);
    $('#sp-fetch-models').on('click',  fetchModels);
    $('#sp-cfg-key')
        .on('focus', () => { const r = $('#sp-cfg-key').data('real'); if (r) $('#sp-cfg-key').val(r); })
        .on('blur',  () => { const r = $('#sp-cfg-key').data('real') || $('#sp-cfg-key').val(); if (r) $('#sp-cfg-key').data('real', r).val(maskKey(r)); });

    $('#sp-body').on('click', '.sp-tab', function () {
        const idx = parseInt($(this).data('day'));
        $('.sp-tab').removeClass('sp-tab-active');
        $(this).addClass('sp-tab-active');
        $('.sp-days-track').css('transform', `translateX(-${idx * 100 / 7}%)`);
    });

    $('#sp-drag-handle').on('mousedown', onDragStart);
    document.getElementById('sp-drag-handle').addEventListener('touchstart', onDragStart, { passive: false });
    $('#sp-resize-handle').on('mousedown', onResizeStart);
    document.getElementById('sp-resize-handle').addEventListener('touchstart', onResizeStart, { passive: false });

    restorePositionAndSize();
}

// ─── View (Tôi / TA) ───────────────────────────────────────────────────────────

function onRegenClick() {
    if (isGenerating) return;
    if (currentView === 'char') {
        // Clear char cache and re-show picker so user can pick a different char.
        // Stash the name first — switchToCharView reads charViewName for pre-fill.
        const key = getCacheKey();
        if (key) localStorage.removeItem(key);
        cachedSchedule = null;
        switchToCharView();   // pre-fills with current charViewName (or guesses)
        charViewName   = null; // clear after picker is rendered
    } else {
        triggerGenerate();
    }
}

function guessCharName(ctx) {
    const msgs = (ctx.chat || []).filter(m => !m.is_user).slice(-20);
    const counts = {};
    for (const m of msgs) {
        const matches = [...(m.mes || '').matchAll(/^([^\s：:「」【\[\n*#]{1,12})[：:]/gm)];
        for (const match of matches) {
            const name = match[1].trim();
            if (name && !/[*#<>{}\[\]|\\]/.test(name)) counts[name] = (counts[name] || 0) + 1;
        }
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || ctx.name2 || '';
}

function setView(view, charName) {
    currentView = view;
    // Only update charViewName when entering char view — preserve it on user view
    // so switching back to TA reloads the same character without showing the picker
    if (view === 'char') charViewName = charName || null;
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="${view}"]`).addClass('sp-view-active');
    cachedSchedule = loadCachedForCurrentChat();
}

function switchToCharView() {
    currentView = 'char';
    const ctx     = getContext();
    // Prefer previously confirmed name; fall back to guessing from chat messages
    const guessed = charViewName || guessCharName(ctx);
    setBody(`<div class="sp-char-picker">
        <p class="sp-char-picker-hint"><i class="fa-solid fa-user-pen"></i> Nhập tên nhân vật muốn xem lịch trình</p>
        <div class="sp-char-picker-row">
            <input id="sp-char-name-input" class="sp-input" type="text"
                   placeholder="Tên nhân vật" value="${escapeAttr(guessed)}">
            <button id="sp-char-name-confirm" class="sp-save-btn">Xác nhận</button>
        </div>
        ${guessed ? `<p class="sp-char-picker-sub">Tự động điền dựa trên đoạn hội thoại gần đây, có thể sửa trực tiếp</p>` : ''}
    </div>`);
    $('.sp-view-btn').removeClass('sp-view-active');
    $(`.sp-view-btn[data-view="char"]`).addClass('sp-view-active');
    // .off().on() prevents duplicate bindings on repeated calls
    $('#sp-char-name-input').off('keydown.charview').on('keydown.charview', e => { if (e.key === 'Enter') confirmCharView(); });
    $('#sp-char-name-confirm').off('click.charview').on('click.charview', confirmCharView);
    setTimeout(() => { $('#sp-char-name-input').focus().select(); }, 50);
}

function confirmCharView() {
    const name = $('#sp-char-name-input').val().trim();
    if (!name) { $('#sp-char-name-input').focus(); return; }
    setView('char', name);
    if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p></div>`);
        if (!isGenerating) {
            isGenerating = true;
            setExtBtnState('generating');
            runGenerate();
        }
    }
}

// ─── Open / close ─────────────────────────────────────────────────────────────

function openSchedule() {
    showPanel();
    if (isGenerating) {
        setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p></div>`);
    } else if (cachedSchedule) {
        setBody(cachedSchedule);
    } else {
        showEmptyGenerate();
    }
}

function showEmptyGenerate() {
    setBody(`<div class="sp-empty">
        <i class="fa-regular fa-calendar"></i>
        <button class="sp-gen-btn" id="sp-gen-now">Tạo lịch trình</button>
    </div>`);
    $('#sp-gen-now').on('click', triggerGenerate);
}

function showPanel() {
    const $root = $(`#${MODAL_ID}`);
    $root.stop(true).css({ display: 'block', opacity: 0 })
         .animate({ opacity: 1 }, 180);
    setTimeout(positionPanel, 0);
}

function closePanel() {
    $(`#${MODAL_ID}`).stop(true).animate({ opacity: 0 }, 150, function () {
        $(this).css('display', 'none');
    });
}

function setBody(html) { $('#sp-body').html(html); }

// ─── Generation ───────────────────────────────────────────────────────────────

function triggerGenerate() {
    if (isGenerating) return;
    const key = getCacheKey();
    if (key) localStorage.removeItem(key);
    cachedSchedule = null;
    isGenerating = true;
    setExtBtnState('generating');
    if (!$(`#${MODAL_ID}`).is(':visible')) showPanel();
    setBody(`<div class="sp-loading"><div class="sp-spinner"></div><p class="sp-loading-text">Đang lập kế hoạch…</p></div>`);
    runGenerate();
}

async function runGenerate() {
    // Snapshot view state — user may switch views while the request is in flight
    const viewSnap = currentView;
    const charSnap = charViewName;
    try {
        const ctx      = getContext();
        // ctx.name1 is the user's display name set in ST persona; no template processing needed
        const userName = ctx.name1 || 'Người dùng';
        const charName = viewSnap === 'char' ? (charSnap || ctx.name2 || 'Nhân vật') : (ctx.name2 || 'Nhân vật');
        const subject  = viewSnap === 'char' ? charName : userName;
        const raw      = await generate(ctx, userName, charName, viewSnap);
        const html     = renderSchedule(raw, subject);

        const cacheKey = getCacheKey(viewSnap, charSnap);
        if (cacheKey) localStorage.setItem(cacheKey, JSON.stringify({ raw, userName: subject, ts: Date.now() }));
        isGenerating = false;
        setExtBtnState('done');

        // Restore snapshot so cache key stays consistent
        if (viewSnap === 'char') charViewName = charSnap;

        const stillOnView = currentView === viewSnap &&
            (viewSnap !== 'char' || charViewName === charSnap);
        if (stillOnView) {
            cachedSchedule = html;
            if ($(`#${MODAL_ID}`).is(':visible')) setBody(html);
            else showToast('Lịch trình đã được tạo, nhấp để xem', () => { showPanel(); setBody(html); });
        } else {
            showToast('Lịch trình đã được tạo, nhấp để xem', () => {
                setView(viewSnap, charSnap);
                cachedSchedule = html;
                showPanel();
                setBody(html);
            });
        }
        setTimeout(() => setExtBtnState(null), 6000);
    } catch (err) {
        isGenerating = false;
        setExtBtnState(null);
        const errHtml = `<div class="sp-error"><i class="fa-solid fa-circle-exclamation"></i><p>Tạo thất bại: ${escapeHtml(err.message || 'Lỗi không xác định')}</p></div>`;
        if ($(`#${MODAL_ID}`).is(':visible') && currentView === viewSnap) setBody(errHtml);
        else showToast('Tạo lịch trình thất bại, vui lòng thử lại', null, true);
    }
}

async function generate(ctx, userName, charName, perspective = 'user') {
    const cfg = loadCfg();
    if (!cfg.url || !cfg.key) {
        if (!settingsOpen) toggleSettings();
        throw new Error('Vui lòng điền URL và Key của API tùy chỉnh trong Cài đặt trước');
    }
    const prompt = buildPrompt(userName, charName, perspective);
    return callCustomApi(ctx, prompt, cfg, userName, charName);
}

async function callCustomApi(ctx, prompt, cfg, userName, charName) {
    const messages = buildMessages(ctx, prompt, userName, charName);
    const res = await fetch(`${cfg.url}/chat/completions`, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
        body   : JSON.stringify({ model: cfg.model || 'gpt-4o-mini', messages, max_tokens: 4096 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}`);
    return (await res.json()).choices?.[0]?.message?.content ?? '';
}

function buildMessages(ctx, prompt, userName, charName) {
    const char = ctx.characters?.[ctx.characterId] ?? {};
    const sys  = [`Bạn đang đóng vai ${charName}.`, char.description,
        char.personality ? `【Tính cách】${char.personality}` : '',
        char.scenario    ? `【Bối cảnh】${char.scenario}`    : '',
    ].filter(Boolean).join('\n\n');
    // substituteParams resolves {{user}}/{{char}} templates in chat messages
    const history = (ctx.chat ?? []).slice(-40).map(m => ({
        role   : m.is_user ? 'user' : 'assistant',
        content: substituteParams(m.mes ?? ''),
    }));
    return [{ role: 'system', content: sys }, ...history, { role: 'user', content: prompt }];
}

function buildPrompt(userName, charName, perspective = 'user') {
    const subject   = perspective === 'char' ? charName : userName;
    const companion = perspective === 'char' ? userName : charName;
    return `Vui lòng tạm dừng nhập vai, hãy hoàn thành nhiệm vụ sau với tư cách là trợ lý viết (nội dung chỉ mang tính tham khảo, không xuất hiện trong văn bản chính):
【Quan trọng】Bất kể cốt truyện sử dụng ngôn ngữ nào, tất cả nội dung đầu ra phải sử dụng tiếng Việt (tên người, địa danh có thể giữ nguyên bản gốc).

Dựa trên bối cảnh cốt truyện và thiết lập thế giới ở trên, hãy lập kế hoạch lịch trình 7 ngày tới cho ${subject}.

【Quy tắc cụ thể】
1. Khoảng thời gian: Phải tạo lịch trình bao gồm 7 ngày liên tiếp kể từ hôm nay, cấm bỏ sót bất kỳ ngày nào.
2. Số lượng sự kiện: Sắp xếp 2 đến 5 sự kiện mỗi ngày, tổng cộng 15-30 sự kiện.
3. Nguồn nội dung: Suy luận hợp lý dựa trên cốt truyện đối thoại hiện tại, thiết lập thế giới quan và mối quan hệ giữa các nhân vật.
4. Quy chuẩn trường dữ liệu (mỗi dòng một Event):
   Định dạng: Event: type|title|description|time|location|npc_action
   - type：world / major / user / character
   - description: Góc nhìn của ${subject}, giọng điệu đời thường, trên 30 từ
   - npc_action: Hành động đồng thời của ${companion}, trên 30 từ

【Định dạng đầu ra (tuân thủ nghiêm ngặt, chỉ xuất ra cấu trúc sau)】
<calendar_widget>
StartDate: YYYY-MM-DD (Nếu cốt truyện có thể xác định hoặc suy luận hợp lý ngày tháng hiện tại của câu chuyện thì điền vào, định dạng ví dụ 2024-03-15; nếu hoàn toàn không thể xác định thì bỏ qua dòng này)
Day: 1
Event: type|title|description|time|location|npc_action
Event: type|title|description|time|location|npc_action
Day: 2
Event: type|title|description|time|location|npc_action
Day: 3
Event: type|title|description|time|location|npc_action
Day: 4
Event: type|title|description|time|location|npc_action
Day: 5
Event: type|title|description|time|location|npc_action
Day: 6
Event: type|title|description|time|location|npc_action
Day: 7
Event: type|title|description|time|location|npc_action
</calendar_widget>`;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

async function fetchModels() {
    const url = $('#sp-cfg-url').val().trim().replace(/\/$/, '');
    const key = ($('#sp-cfg-key').data('real') || $('#sp-cfg-key').val()).trim();
    if (!url || !key) { showToast('Vui lòng điền URL và Key trước', null, true); return; }

    const $btn = $('#sp-fetch-models');
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const res = await fetch(`${url}/models`, {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || data.models || [])
            .map(m => (typeof m === 'string' ? m : m.id))
            .filter(Boolean).sort();
        if (!models.length) throw new Error('Giao diện không trả về bất kỳ mô hình nào');

        const current = loadCfg().model || '';
        const opts = models.map(m =>
            `<option value="${escapeAttr(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`
        ).join('');
        $('#sp-cfg-model').replaceWith(
            `<select id="sp-cfg-model" class="sp-input sp-model-input">${opts}</select>`
        );
        if (!current) $('#sp-cfg-model').val(models[0]);
        showToast(`Đã tải ${models.length} mô hình`);
    } catch (err) {
        showToast(`Tải mô hình thất bại: ${err.message}`, null, true);
    } finally {
        $btn.prop('disabled', false).html('<i class="fa-solid fa-list"></i>');
    }
}

function toggleSettings() {
    settingsOpen = !settingsOpen;
    $('#sp-settings-panel').slideToggle(200);
    $(`#${MODAL_ID} .sp-settings-btn`).toggleClass('sp-btn-active', settingsOpen);
}

function toggleKeyVisibility() {
    const $el = $('#sp-cfg-key'), $icon = $('#sp-key-toggle i');
    if ($el.attr('type') === 'password') {
        $el.attr('type', 'text').val($el.data('real') || $el.val());
        $icon.removeClass('fa-eye').addClass('fa-eye-slash');
    } else {
        const r = $el.val(); $el.data('real', r).attr('type', 'password').val(maskKey(r));
        $icon.removeClass('fa-eye-slash').addClass('fa-eye');
    }
}

function saveSettings() {
    const $k = $('#sp-cfg-key'), key = ($k.data('real') || $k.val()).trim();
    saveCfg({ url: $('#sp-cfg-url').val().trim().replace(/\/$/, ''), key, model: $('#sp-cfg-model').val().trim() });
    $k.data('real', key).val(maskKey(key)).attr('type', 'password');
    const $m = $('#sp-cfg-msg'); $m.text('Đã lưu ✓'); setTimeout(() => $m.text(''), 2000);
    const hasApi = !!(loadCfg().url && loadCfg().key);
    $('.sp-api-notice')
        .removeClass('sp-notice-ok sp-notice-warn')
        .addClass(hasApi ? 'sp-notice-ok' : 'sp-notice-warn')
        .html(`<i class="fa-solid ${hasApi ? 'fa-circle-check' : 'fa-triangle-exclamation'}"></i>
            ${hasApi ? 'Đã cấu hình API độc lập, tạo dưới nền không ảnh hưởng đến trò chuyện'
                     : 'Chưa cấu hình API độc lập: Trong quá trình tạo sẽ <b>chiếm dụng kênh trò chuyện</b>'}`);
    setTimeout(() => { if (settingsOpen) toggleSettings(); }, 400);
}

function applyTheme(theme) {
    currentTheme = theme;
    $(`#${MODAL_ID}`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
    $(`#${FAB_ID} .sp-fab-btn`).removeClass('sp-night sp-day').addClass(`sp-${theme}`);
}

function toggleTheme() {
    applyTheme(currentTheme === 'night' ? 'day' : 'night');
    localStorage.setItem(THEME_KEY, currentTheme);
}

// ─── Drag ─────────────────────────────────────────────────────────────────────

function onDragStart(e) {
    if ($(e.target).closest('.sp-icon-btn, .sp-view-btn').length) return;
    e.preventDefault();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (sheet.style.transform !== 'none' && (sheet.style.left === '' || sheet.style.left === '50%')) {
        sheet.style.transform = 'none';
        sheet.style.left = rect.left + 'px';
        sheet.style.top  = rect.top  + 'px';
    }
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    dragState = { startX: cx, startY: cy, origLeft: rect.left, origTop: rect.top };
    $(document).on('mousemove.spdrag', onDragMove).on('mouseup.spdrag', onDragEnd);
    document.addEventListener('touchmove', onDragMove, { passive: false });
    document.addEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grabbing');
}

function onDragMove(e) {
    if (!dragState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const left = Math.max(0, Math.min(dragState.origLeft + cx - dragState.startX, window.innerWidth  - sheet.offsetWidth));
    const top  = Math.max(0, Math.min(dragState.origTop  + cy - dragState.startY, window.innerHeight - 60));
    sheet.style.left  = left + 'px';
    sheet.style.top   = top  + 'px';
    sheet.style.right = 'auto';
}

function onDragEnd() {
    if (!dragState) return;
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    const rect  = sheet.getBoundingClientRect();
    if (!isMobile()) {
        localStorage.setItem(POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
    }
    dragState = null;
    $(document).off('mousemove.spdrag mouseup.spdrag');
    document.removeEventListener('touchmove', onDragMove);
    document.removeEventListener('touchend',  onDragEnd);
    $('#sp-drag-handle').css('cursor', 'grab');
}

// ─── Resize ───────────────────────────────────────────────────────────────────

function onResizeStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = 'width, height';
    document.body.style.userSelect = 'none';
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    resizeState = {
        startX: cx, startY: cy,
        origW : sheet.offsetWidth, origH : sheet.offsetHeight,
    };
    $(document).on('mousemove.spresize', onResizeMove).on('mouseup.spresize', onResizeEnd);
    document.addEventListener('touchmove', onResizeMove, { passive: false });
    document.addEventListener('touchend',  onResizeEnd);
}

function onResizeMove(e) {
    if (!resizeState) return;
    e.preventDefault();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    if (resizeRAF) return;
    resizeRAF = requestAnimationFrame(() => {
        resizeRAF = null;
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        const w = Math.max(280, Math.min(700, resizeState.origW + cx - resizeState.startX));
        const h = Math.max(300, Math.min(window.innerHeight * 0.92, resizeState.origH + cy - resizeState.startY));
        sheet.style.width     = w + 'px';
        sheet.style.height    = h + 'px';
        sheet.style.maxHeight = h + 'px';
    });
}

function onResizeEnd() {
    if (!resizeState) return;
    if (resizeRAF) { cancelAnimationFrame(resizeRAF); resizeRAF = null; }
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    sheet.style.willChange = '';
    document.body.style.userSelect = '';
    localStorage.setItem(SIZE_KEY, JSON.stringify({ width: sheet.offsetWidth, height: sheet.offsetHeight }));
    resizeState = null;
    $(document).off('mousemove.spresize mouseup.spresize');
    document.removeEventListener('touchmove', onResizeMove);
    document.removeEventListener('touchend',  onResizeEnd);
}

function restorePositionAndSize() {
    setTimeout(() => {
        const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
        if (!sheet) return;
        const pos  = JSON.parse(localStorage.getItem(POS_KEY)  || 'null');
        const size = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
        if (pos) {
            sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
            sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
            sheet.style.right = 'auto';
        }
        if (size) {
            sheet.style.width     = size.width  + 'px';
            sheet.style.height    = size.height + 'px';
            sheet.style.maxHeight = size.height + 'px';
        }
    }, 0);
}

function positionPanel() {
    const sheet = document.querySelector(`#${MODAL_ID} .sp-sheet`);
    if (!sheet) return;
    if (isMobile()) {
        sheet.style.left      = '';
        sheet.style.top       = '';
        sheet.style.right     = '';
        sheet.style.transform = '';
        return;
    }
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (pos) {
        sheet.style.left  = Math.min(pos.left, window.innerWidth  - sheet.offsetWidth)  + 'px';
        sheet.style.top   = Math.min(pos.top,  window.innerHeight - 60) + 'px';
        sheet.style.right = 'auto';
    }
}

// ─── Toast (top) ──────────────────────────────────────────────────────────────

function injectToastContainer() {
    if (!$('#sp-toast-wrap').length) document.documentElement.insertAdjacentHTML('beforeend', '<div id="sp-toast-wrap"></div>');
}

function showToast(msg, onClick, isError = false) {
    const $t = $(`<div class="sp-toast${isError ? ' sp-toast-error' : ''}">
        <i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-calendar-check'}"></i>
        <span>${escapeHtml(msg)}</span>
    </div>`);
    $('#sp-toast-wrap').append($t);
    requestAnimationFrame(() => $t.addClass('sp-toast-show'));
    if (onClick) $t.css('cursor', 'pointer').on('click', () => { onClick(); $t.remove(); });
    setTimeout(() => { $t.removeClass('sp-toast-show'); setTimeout(() => $t.remove(), 350); }, 4000);
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const TYPE_META = {
    world    : { icon: 'fa-earth-asia', label: 'Thế giới',  cls: 'sp-type-world'     },
    major    : { icon: 'fa-star',       label: 'Sự kiện lớn',  cls: 'sp-type-major'     },
    user     : { icon: 'fa-user',       label: 'Cá nhân',  cls: 'sp-type-user'       },
    character: { icon: 'fa-heart',      label: 'NPC',   cls: 'sp-type-character' },
};

function renderSchedule(raw, userName) {
    const { days, startDate } = parseCalendar(raw);
    if (days.length === 0) return `<div class="sp-raw">${escapeHtml(raw).replace(/\n/g, '<br>')}</div>`;

    const WEEKDAYS = ['CN','T2','T3','T4','T5','T6','T7'];

    const header = `<div class="sp-schedule-header">
        <span class="sp-user-chip">${escapeHtml(userName)}</span>
        <span class="sp-schedule-label"> - Lịch trình 7 ngày</span>
    </div>`;

    const tabs = days.map((_, i) => {
        let numLabel = String(i + 1);
        let wdLabel = '';
        if (startDate) {
            const d = new Date(startDate);
            d.setDate(d.getDate() + i);
            wdLabel  = WEEKDAYS[d.getDay()];
            numLabel = `${d.getMonth() + 1}/${d.getDate()}`;
        }
        return `<button class="sp-tab${i === 0 ? ' sp-tab-active' : ''}" data-day="${i}">
            <span class="sp-tab-num">${numLabel}</span>
            ${wdLabel ? `<span class="sp-tab-wd">${wdLabel}</span>` : ''}
        </button>`;
    }).join('');

    const panels = days.map(day =>
        `<div class="sp-day-panel">${day.events.map(renderEvent).join('')}</div>`
    ).join('');

    const debug = days.length < 7 ? `
        <details class="sp-debug"><summary>⚠ Chỉ phân tích được ${days.length} ngày</summary>
        <pre class="sp-debug-raw">${escapeHtml(raw)}</pre></details>` : '';

    return `${header}<div class="sp-tab-bar">${tabs}</div>
        <div class="sp-days-wrap"><div class="sp-days-track">${panels}</div></div>${debug}`;
}

function parseCalendar(raw) {
    const m = raw.match(/<calendar_widget[^>]*>([\s\S]*?)<\/calendar_widget>/i);
    const content = m ? m[1] : raw;

    const dateMatch = content.match(/^StartDate:\s*(\d{4}-\d{2}-\d{2})/m);
    let startDate = null;
    if (dateMatch) {
        const d = new Date(dateMatch[1]);
        if (!isNaN(d)) startDate = d;
    }

    const days = []; let cur = null;
    for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('
