local M = {}

local ARRAY_MT = { __ssb_json_array = true }
M.ARRAY_MT = ARRAY_MT

local function utf8_validate(text)
    local index = 1
    local length = #text
    while index <= length do
        local first = text:byte(index)
        if first < 0x80 then
            index = index + 1
        else
            local count, minimum, codepoint
            if first >= 0xC2 and first <= 0xDF then
                count, minimum, codepoint = 2, 0x80, first - 0xC0
            elseif first >= 0xE0 and first <= 0xEF then
                count, minimum, codepoint = 3, 0x800, first - 0xE0
            elseif first >= 0xF0 and first <= 0xF4 then
                count, minimum, codepoint = 4, 0x10000, first - 0xF0
            else
                return nil, "invalid UTF-8 leading byte at " .. tostring(index)
            end
            if index + count - 1 > length then
                return nil, "truncated UTF-8 sequence at " .. tostring(index)
            end
            for offset = 1, count - 1 do
                local byte = text:byte(index + offset)
                if not byte or byte < 0x80 or byte > 0xBF then
                    return nil, "invalid UTF-8 continuation byte at " .. tostring(index + offset)
                end
                codepoint = codepoint * 0x40 + (byte - 0x80)
            end
            if codepoint < minimum or codepoint > 0x10FFFF
                or (codepoint >= 0xD800 and codepoint <= 0xDFFF) then
                return nil, "invalid UTF-8 codepoint at " .. tostring(index)
            end
            index = index + count
        end
    end
    return true
end

local function utf8_encode(codepoint)
    if codepoint < 0x80 then
        return string.char(codepoint)
    elseif codepoint < 0x800 then
        return string.char(
            0xC0 + math.floor(codepoint / 0x40),
            0x80 + codepoint % 0x40
        )
    elseif codepoint < 0x10000 then
        return string.char(
            0xE0 + math.floor(codepoint / 0x1000),
            0x80 + math.floor(codepoint / 0x40) % 0x40,
            0x80 + codepoint % 0x40
        )
    end
    return string.char(
        0xF0 + math.floor(codepoint / 0x40000),
        0x80 + math.floor(codepoint / 0x1000) % 0x40,
        0x80 + math.floor(codepoint / 0x40) % 0x40,
        0x80 + codepoint % 0x40
    )
end

local Decoder = {}
Decoder.__index = Decoder

function Decoder.new(text)
    return setmetatable({ text = text, position = 1, length = #text }, Decoder)
end

function Decoder:fail(message)
    error({ json_error = message .. " at byte " .. tostring(self.position) }, 0)
end

function Decoder:skip_space()
    local _, last = self.text:find("^[ \t\r\n]*", self.position)
    self.position = last + 1
end

function Decoder:peek()
    return self.text:sub(self.position, self.position)
end

function Decoder:expect(character)
    if self:peek() ~= character then
        self:fail("expected '" .. character .. "'")
    end
    self.position = self.position + 1
end

function Decoder:hex4()
    local hex = self.text:sub(self.position, self.position + 3)
    if #hex ~= 4 or not hex:match("^%x%x%x%x$") then
        self:fail("invalid Unicode escape")
    end
    self.position = self.position + 4
    return tonumber(hex, 16)
end

function Decoder:string()
    self:expect('"')
    local chunks = {}
    local start = self.position
    while self.position <= self.length do
        local byte = self.text:byte(self.position)
        if byte == 0x22 then
            chunks[#chunks + 1] = self.text:sub(start, self.position - 1)
            self.position = self.position + 1
            local result = table.concat(chunks)
            local valid, err = utf8_validate(result)
            if not valid then
                self:fail(err)
            end
            return result
        elseif byte == 0x5C then
            chunks[#chunks + 1] = self.text:sub(start, self.position - 1)
            self.position = self.position + 1
            local escape = self.text:sub(self.position, self.position)
            self.position = self.position + 1
            local simple = {
                ['"'] = '"', ["\\"] = "\\", ["/"] = "/",
                b = "\b", f = "\f", n = "\n", r = "\r", t = "\t",
            }
            if simple[escape] then
                chunks[#chunks + 1] = simple[escape]
            elseif escape == "u" then
                local codepoint = self:hex4()
                if codepoint >= 0xD800 and codepoint <= 0xDBFF then
                    if self.text:sub(self.position, self.position + 1) ~= "\\u" then
                        self:fail("missing low surrogate")
                    end
                    self.position = self.position + 2
                    local low = self:hex4()
                    if low < 0xDC00 or low > 0xDFFF then
                        self:fail("invalid low surrogate")
                    end
                    codepoint = 0x10000 + (codepoint - 0xD800) * 0x400 + low - 0xDC00
                elseif codepoint >= 0xDC00 and codepoint <= 0xDFFF then
                    self:fail("unexpected low surrogate")
                end
                chunks[#chunks + 1] = utf8_encode(codepoint)
            else
                self:fail("invalid string escape")
            end
            start = self.position
        elseif byte < 0x20 then
            self:fail("unescaped control character in string")
        else
            self.position = self.position + 1
        end
    end
    self:fail("unterminated string")
end

function Decoder:number()
    local start = self.position
    if self:peek() == "-" then
        self.position = self.position + 1
    end
    local first = self:peek()
    if first == "0" then
        self.position = self.position + 1
        if self:peek():match("%d") then
            self:fail("leading zero in number")
        end
    elseif first:match("[1-9]") then
        self.position = self.position + 1
        while self:peek():match("%d") do
            self.position = self.position + 1
        end
    else
        self:fail("invalid number")
    end
    if self:peek() == "." then
        self.position = self.position + 1
        if not self:peek():match("%d") then
            self:fail("missing fraction digits")
        end
        while self:peek():match("%d") do
            self.position = self.position + 1
        end
    end
    local exponent = self:peek()
    if exponent == "e" or exponent == "E" then
        self.position = self.position + 1
        local sign = self:peek()
        if sign == "+" or sign == "-" then
            self.position = self.position + 1
        end
        if not self:peek():match("%d") then
            self:fail("missing exponent digits")
        end
        while self:peek():match("%d") do
            self.position = self.position + 1
        end
    end
    local value = tonumber(self.text:sub(start, self.position - 1))
    if not value or value == math.huge or value == -math.huge or value ~= value then
        self:fail("number is outside the finite range")
    end
    return value
end

function Decoder:array(depth)
    self:expect("[")
    local result = setmetatable({}, ARRAY_MT)
    local length = 0
    self:skip_space()
    if self:peek() == "]" then
        self.position = self.position + 1
        result.__ssb_json_length = 0
        return result
    end
    while true do
        length = length + 1
        result[length] = self:value(depth + 1)
        self:skip_space()
        local character = self:peek()
        if character == "]" then
            self.position = self.position + 1
            result.__ssb_json_length = length
            return result
        elseif character == "," then
            self.position = self.position + 1
            self:skip_space()
            if self:peek() == "]" then
                self:fail("trailing comma in array")
            end
        else
            self:fail("expected ',' or ']' in array")
        end
    end
end

function Decoder:object(depth)
    self:expect("{")
    local result = {}
    self:skip_space()
    if self:peek() == "}" then
        self.position = self.position + 1
        return result
    end
    local keys = {}
    while true do
        if self:peek() ~= '"' then
            self:fail("object key must be a string")
        end
        local key = self:string()
        if keys[key] then
            self:fail("duplicate object key '" .. key .. "'")
        end
        keys[key] = true
        self:skip_space()
        self:expect(":")
        self:skip_space()
        result[key] = self:value(depth + 1)
        self:skip_space()
        local character = self:peek()
        if character == "}" then
            self.position = self.position + 1
            return result
        elseif character == "," then
            self.position = self.position + 1
            self:skip_space()
            if self:peek() == "}" then
                self:fail("trailing comma in object")
            end
        else
            self:fail("expected ',' or '}' in object")
        end
    end
end

function Decoder:value(depth)
    if depth > 256 then
        self:fail("nesting limit exceeded")
    end
    self:skip_space()
    local character = self:peek()
    if character == '"' then
        return self:string()
    elseif character == "{" then
        return self:object(depth)
    elseif character == "[" then
        return self:array(depth)
    elseif character == "-" or character:match("%d") then
        return self:number()
    elseif self.text:sub(self.position, self.position + 3) == "true" then
        self.position = self.position + 4
        return true
    elseif self.text:sub(self.position, self.position + 4) == "false" then
        self.position = self.position + 5
        return false
    elseif self.text:sub(self.position, self.position + 3) == "null" then
        self.position = self.position + 4
        return nil
    end
    self:fail("unexpected JSON value")
end

function M.decode(text)
    if type(text) ~= "string" then
        return nil, "JSON input must be a string"
    end
    local decoder = Decoder.new(text)
    local results = { pcall(function()
        local value = decoder:value(0)
        decoder:skip_space()
        if decoder.position <= decoder.length then
            decoder:fail("trailing characters")
        end
        return value
    end) }
    if not results[1] then
        local err = results[2]
        if type(err) == "table" and err.json_error then
            return nil, err.json_error
        end
        return nil, tostring(err)
    end
    return results[2]
end

local ESCAPES = {
    ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b",
    ["\f"] = "\\f", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t",
}

local function encode_string(value)
    local valid, err = utf8_validate(value)
    if not valid then
        return nil, err
    end
    local escaped = value:gsub('[%z\1-\31\\"]', function(character)
        return ESCAPES[character] or string.format("\\u%04x", character:byte())
    end)
    return '"' .. escaped .. '"'
end

local function array_length(value)
    local length = 0
    for key in pairs(value) do
        if type(key) ~= "number" or key < 1 or key % 1 ~= 0 then
            return nil, "JSON arrays must have positive integer keys"
        end
        length = math.max(length, key)
    end
    for index = 1, length do
        if value[index] == nil then
            return nil, "sparse Lua arrays are ambiguous; use a decoded JSON array for null elements"
        end
    end
    return length
end

local function encode_value(value, stack, depth)
    if depth > 256 then
        return nil, "nesting limit exceeded"
    end
    local kind = type(value)
    if value == nil then
        return "null"
    elseif kind == "boolean" then
        return tostring(value)
    elseif kind == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return nil, "cannot encode a non-finite number"
        end
        if value % 1 == 0 then
            return string.format("%.0f", value)
        end
        return string.format("%.17g", value)
    elseif kind == "string" then
        return encode_string(value)
    elseif kind ~= "table" then
        return nil, "unsupported JSON value type: " .. kind
    end
    if stack[value] then
        return nil, "cannot encode a cyclic table"
    end
    stack[value] = true
    local chunks = {}
    if getmetatable(value) == ARRAY_MT then
        local length = value.__ssb_json_length or #value
        for index = 1, length do
            local encoded, err = encode_value(value[index], stack, depth + 1)
            if not encoded then
                stack[value] = nil
                return nil, err
            end
            chunks[index] = encoded
        end
        stack[value] = nil
        return "[" .. table.concat(chunks, ",") .. "]"
    end
    local regular_length = array_length(value)
    if regular_length and regular_length > 0 then
        for index = 1, regular_length do
            local encoded, err = encode_value(value[index], stack, depth + 1)
            if not encoded then
                stack[value] = nil
                return nil, err
            end
            chunks[index] = encoded
        end
        stack[value] = nil
        return "[" .. table.concat(chunks, ",") .. "]"
    end
    local keys = {}
    for key in pairs(value) do
        if type(key) ~= "string" then
            stack[value] = nil
            return nil, "JSON object keys must be strings"
        end
        keys[#keys + 1] = key
    end
    table.sort(keys)
    for _, key in ipairs(keys) do
        local encoded_key, key_error = encode_string(key)
        local encoded_value, value_error = encode_value(value[key], stack, depth + 1)
        if not encoded_key or not encoded_value then
            stack[value] = nil
            return nil, key_error or value_error
        end
        chunks[#chunks + 1] = encoded_key .. ":" .. encoded_value
    end
    stack[value] = nil
    return "{" .. table.concat(chunks, ",") .. "}"
end

function M.encode(value)
    if type(value) == "table" and getmetatable(value) ~= ARRAY_MT then
        local length, array_error = array_length(value)
        if length and length > 0 then
            local array = setmetatable({}, ARRAY_MT)
            for index = 1, length do
                array[index] = value[index]
            end
            return encode_value(array, {}, 0)
        elseif not length and array_error and next(value) ~= nil then
            local keys = {}
            for key in pairs(value) do
                if type(key) == "number" then
                    return nil, array_error
                end
                keys[#keys + 1] = key
            end
        end
    end
    return encode_value(value, {}, 0)
end

return M
