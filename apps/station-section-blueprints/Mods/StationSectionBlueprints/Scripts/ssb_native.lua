local M = {}

function M.is_valid(object)
    if object == nil then
        return false
    end
    local ok, valid = pcall(function()
        return object:IsValid()
    end)
    return ok and valid == true
end

function M.full_name(object)
    if not M.is_valid(object) then
        return "<invalid>"
    end
    local ok, name = pcall(function()
        return object:GetFullName()
    end)
    return ok and name or "<unavailable>"
end

function M.class_name(object)
    if not M.is_valid(object) then
        return "<invalid>"
    end
    local ok, name = pcall(function()
        return object:GetClass():GetFName():ToString()
    end)
    return ok and name or "<unavailable>"
end

function M.short_name(object)
    if not M.is_valid(object) then
        return "<invalid>"
    end
    local ok, name = pcall(function()
        return object:GetFName():ToString()
    end)
    return ok and name or "<unavailable>"
end

function M.find_type(path)
    local ok, object = pcall(StaticFindObject, path)
    if ok and M.is_valid(object) then
        return object
    end
    return nil
end

function M.each_function(type_object, callback)
    if not M.is_valid(type_object) then
        return false
    end
    return pcall(function()
        type_object:ForEachFunction(function(fn)
            callback(M.full_name(fn), fn)
        end)
    end)
end

function M.each_property(type_object, callback)
    if not M.is_valid(type_object) then
        return false
    end
    return pcall(function()
        type_object:ForEachProperty(function(property)
            callback(M.full_name(property), property)
        end)
    end)
end

return M
