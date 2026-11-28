-- Top-right sci-fi toast notifications with smoothly animated TTL countdown bar.
-- Reuses ssb_ui_theme (native WBP_Text_C + Border + ProgressBar) and FindAllOf only (UE4SS 4.0.0 safe).

local native = require("ssb_native")
local theme = require("ssb_ui_theme")

local M = {}

local DEFAULT_TTL = 3.5
local MAX_VISIBLE = 4
local TICK_MS = 50
local TOAST_WIDTH = 360
local HOST_RETRY_INTERVAL = 0.50

-- Pure testable TTL queue state machine
function M.new_manager(options)
    options = options or {}
    local manager = {
        max_visible = options.max_visible or MAX_VISIBLE,
        default_ttl = options.default_ttl or DEFAULT_TTL,
        sequence = 0,
        items = {},
    }

    function manager:push(title, detail, tone, ttl, tag)
        local duration = tonumber(ttl) or self.default_ttl
        if duration <= 0 then duration = self.default_ttl end
        local normalized_tone = tone or "info"
        if tag ~= nil and tag ~= "" then
            for _, item in ipairs(self.items) do
                if item.tag == tag then
                    item.title = tostring(title or "")
                    item.detail = tostring(detail or "")
                    item.tone = normalized_tone
                    item.duration = duration
                    item.remaining = duration
                    item.progress = 1.0
                    item.dirty = true
                    return item, "updated"
                end
            end
        end
        self.sequence = self.sequence + 1
        local item = {
            id = self.sequence,
            tag = tag,
            title = tostring(title or ""),
            detail = tostring(detail or ""),
            tone = normalized_tone,
            duration = duration,
            remaining = duration,
            progress = 1.0,
            dirty = true,
        }
        table.insert(self.items, 1, item)
        local evicted = {}
        while #self.items > self.max_visible do
            evicted[#evicted + 1] = table.remove(self.items)
        end
        return item, "created", evicted
    end

    function manager:tick(dt)
        local delta = tonumber(dt) or 0
        if delta < 0 then delta = 0 end
        local expired = {}
        local kept = {}
        for _, item in ipairs(self.items) do
            item.remaining = item.remaining - delta
            if item.remaining <= 0 then
                item.remaining = 0
                item.progress = 0
                expired[#expired + 1] = item
            else
                item.progress = math.max(0, math.min(1, item.remaining / item.duration))
                kept[#kept + 1] = item
            end
        end
        self.items = kept
        return expired
    end

    function manager:clear()
        local removed = self.items
        self.items = {}
        return removed
    end

    return manager
end

-- Live UE5 top-right HUD toast renderer
local runtime = _G.__StationSectionBlueprintsToastRuntime
if not runtime then
    runtime = {
        manager = M.new_manager(),
        host = nil,
        views = {},
        ticking = false,
        last_host_probe = 0,
        logged_no_host = false,
    }
    _G.__StationSectionBlueprintsToastRuntime = runtime
end

local function teardown_host()
    if runtime.host and native.is_valid(runtime.host.canvas) and native.is_valid(runtime.host.stack) then
        pcall(function() runtime.host.canvas:RemoveChild(runtime.host.stack) end)
    end
    runtime.host = nil
    runtime.views = {}
end

local function ensure_host(force_probe)
    -- Fast path: reuse live visible host with ZERO FindAllOf calls during 50ms TTL bar animation.
    if runtime.host
        and theme.is_widget_visible(runtime.host.hud)
        and native.is_valid(runtime.host.canvas)
        and native.is_valid(runtime.host.stack) then
        return runtime.host
    end
    local now = os.clock()
    if not force_probe and (now - (runtime.last_host_probe or 0)) < HOST_RETRY_INTERVAL then
        return nil
    end
    runtime.last_host_probe = now

    local target = theme.find_active_hud_host()
    if not target then
        teardown_host()
        if not runtime.logged_no_host then
            runtime.logged_no_host = true
            print("[StationSectionBlueprints Toast] no visible HUD CanvasPanel found; toast queued silently\n")
        end
        return nil
    end
    runtime.logged_no_host = false
    teardown_host()
    local stack = theme.construct(target.widget_tree, theme.CLASSES.VERTICAL_BOX)
    if not stack then return nil end
    local slot = theme.place_on_canvas(target.canvas, stack, {
        anchors = { Minimum = { X = 1.0, Y = 0.0 }, Maximum = { X = 1.0, Y = 0.0 } },
        alignment = { X = 1.0, Y = 0.0 },
        position = { X = -24.0, Y = 24.0 },
        size = { X = TOAST_WIDTH, Y = 0.0 },
        auto_size = true,
        z_order = 950,
    })
    if not slot then return nil end
    theme.set_visibility(stack, true, theme.VISIBILITY.HitTestInvisible)
    target.stack = stack
    runtime.host = target
    print("[StationSectionBlueprints Toast] mounted overlay on " .. tostring(target.class_name) .. "\n")
    for _, item in ipairs(runtime.manager.items) do
        item.dirty = true
    end
    return target
end

local function build_toast_view(host, item)
    local accent = theme.tone_color(item.tone)
    local width_box = theme.construct(host.widget_tree, theme.CLASSES.SIZE_BOX)
    if not width_box then return nil end
    pcall(function() width_box:SetWidthOverride(TOAST_WIDTH) end)
    local card = theme.create_framed_panel(host.widget_tree, {
        border_color = accent,
        border_width = 1.5,
        surface_color = theme.PALETTE.surface,
        padding = { 12, 8, 12, 8 },
    })
    if not card then return nil end
    if not theme.add_child(width_box, card.outer) then return nil end

    local title_widget = theme.create_text(host.hud, host.owner, host.widget_tree, item.title, {
        size = 15,
        color = accent,
        wrap = TOAST_WIDTH - 28,
    })
    if title_widget then
        theme.add_child(card.body, title_widget, { 0, 0, 0, 2 })
    end

    local detail_widget = theme.create_text(host.hud, host.owner, host.widget_tree, item.detail, {
        size = 12,
        color = theme.PALETTE.text_primary,
        wrap = TOAST_WIDTH - 28,
    })
    if detail_widget then
        theme.add_child(card.body, detail_widget, { 0, 0, 0, 6 })
        theme.set_visibility(detail_widget, item.detail ~= "")
    end

    -- Smooth TTL countdown bar
    local bar_box = theme.construct(host.widget_tree, theme.CLASSES.SIZE_BOX)
    local bar = theme.construct(host.widget_tree, theme.CLASSES.PROGRESS_BAR)
    if bar_box and bar then
        pcall(function() bar_box:SetHeightOverride(4.0) end)
        pcall(function() bar:SetFillColorAndOpacity(accent) end)
        pcall(function() bar:SetPercent(item.progress) end)
        theme.add_child(bar_box, bar)
        theme.add_child(card.body, bar_box, { 0, 2, 0, 0 })
    end

    theme.set_visibility(width_box, true, theme.VISIBILITY.HitTestInvisible)
    if not theme.add_child(host.stack, width_box, { 0, 0, 0, 8 }) then
        return nil
    end
    return {
        root = width_box,
        outer = card.outer,
        title = title_widget,
        detail = detail_widget,
        bar = bar,
    }
end

local function remove_view(host, view)
    if host and native.is_valid(host.stack) and view and native.is_valid(view.root) then
        pcall(function() host.stack:RemoveChild(view.root) end)
    end
end

local function sync_views(force_probe)
    if #runtime.manager.items == 0 then
        teardown_host()
        return
    end
    local host = ensure_host(force_probe)
    if not host then return end

    local alive = {}
    for _, item in ipairs(runtime.manager.items) do
        alive[item.id] = true
        local view = runtime.views[item.id]
        if not view or not native.is_valid(view.root) then
            view = build_toast_view(host, item)
            runtime.views[item.id] = view
            item.dirty = false
        elseif item.dirty then
            local accent = theme.tone_color(item.tone)
            pcall(function() view.outer:SetBrushColor(accent) end)
            if view.title then
                theme.set_text(view.title, item.title)
                theme.set_text_color(view.title, accent)
            end
            if view.detail then
                theme.set_text(view.detail, item.detail)
                theme.set_visibility(view.detail, item.detail ~= "")
            end
            if view.bar then
                pcall(function() view.bar:SetFillColorAndOpacity(accent) end)
            end
            item.dirty = false
        end
        if view and view.bar and native.is_valid(view.bar) then
            pcall(function() view.bar:SetPercent(item.progress) end)
        end
    end

    for id, view in pairs(runtime.views) do
        if not alive[id] then
            remove_view(host, view)
            runtime.views[id] = nil
        end
    end
end

local function start_loop()
    if runtime.ticking then return end
    if type(ExecuteWithDelay) ~= "function" or type(ExecuteInGameThread) ~= "function" then
        return
    end
    runtime.ticking = true
    local function step()
        ExecuteInGameThread(function()
            local ok, err = pcall(function()
                runtime.manager:tick(TICK_MS / 1000.0)
                sync_views()
            end)
            if not ok then
                print("[StationSectionBlueprints Toast] tick failed: " .. tostring(err) .. "\n")
            end
            if #runtime.manager.items > 0 then
                ExecuteWithDelay(TICK_MS, step)
            else
                runtime.ticking = false
            end
        end)
    end
    ExecuteWithDelay(TICK_MS, step)
end

function M.show(title, detail, tone, ttl_seconds, tag)
    local item, _, evicted = runtime.manager:push(title, detail, tone, ttl_seconds, tag)
    if runtime.host and evicted then
        for _, dead in ipairs(evicted) do
            remove_view(runtime.host, runtime.views[dead.id])
            runtime.views[dead.id] = nil
        end
    end
    if type(ExecuteInGameThread) == "function" then
        ExecuteInGameThread(function()
            local ok, err = pcall(sync_views, true)
            if not ok then
                print("[StationSectionBlueprints Toast] sync failed: " .. tostring(err) .. "\n")
            end
            start_loop()
        end)
    end
    return item
end

function M.clear()
    runtime.manager:clear()
    teardown_host()
    runtime.ticking = false
end

return M
