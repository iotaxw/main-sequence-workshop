[CmdletBinding()]
param(
    [string]$CatalogPath = (Join-Path $PSScriptRoot '../../../packages/ms-blueprint-codec/data/catalog-26639889.json'),
    [string]$OutputPath = (Join-Path $PSScriptRoot '../Mods/StationSectionBlueprints/Scripts/ssb_catalog_data.lua')
)

$ErrorActionPreference = 'Stop'
$catalogFullPath = [IO.Path]::GetFullPath($CatalogPath)
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$catalog = Get-Content -LiteralPath $catalogFullPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$catalog.game.buildId -ne '26639889') {
    throw "Unexpected game build: $($catalog.game.buildId)"
}

function Lua-String([object]$Value) {
    $text = [string]$Value
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append('"')
    foreach ($character in $text.ToCharArray()) {
        $code = [int]$character
        switch ($code) {
            34 { [void]$builder.Append('\"') }
            92 { [void]$builder.Append('\\') }
            8 { [void]$builder.Append('\b') }
            9 { [void]$builder.Append('\t') }
            10 { [void]$builder.Append('\n') }
            12 { [void]$builder.Append('\f') }
            13 { [void]$builder.Append('\r') }
            default {
                if ($code -lt 32 -or $code -eq 127) {
                    [void]$builder.Append(('\u{0:x4}' -f $code))
                } else {
                    [void]$builder.Append($character)
                }
            }
        }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Round-Away([double]$Value) {
    return [Math]::Round($Value, 0, [MidpointRounding]::AwayFromZero)
}

function Pivot-Offset($Module) {
    if ($null -eq $Module.blockBoundsM) {
        return @(0, 0, 0)
    }
    $bounds = $Module.blockBoundsM
    $rawX = [double]$bounds.minX + [int]$Module.sizeUnits[0] * 8.0
    $rawY = [double]$bounds.minY + [int]$Module.sizeUnits[1] * 8.0
    $originX = if ([Math]::Abs($rawX) -lt 0.5) { 0.0 } else { (Round-Away ($rawX * 2.0)) / 2.0 }
    $originY = if ([Math]::Abs($rawY) -lt 0.5) { 0.0 } else { (Round-Away ($rawY * 2.0)) / 2.0 }
    $dux = [int](Round-Away (-$originX / 4.0))
    $duy = [int](Round-Away (-$originY / 4.0))
    $zShift = if ([double]$bounds.maxZ -le 0.05 -and [double]$bounds.minZ -lt -0.5) { 2 } else { 0 }
    return @($dux, $duy, $zShift)
}

function Class-Base([string]$Name) {
    return $Name -replace '_C$', ''
}

$modules = @($catalog.stationModules | Sort-Object -Property id -CaseSensitive)
$buildables = @($catalog.buildables | Sort-Object -Property id -CaseSensitive)
if ($modules.Count -ne 27 -or $buildables.Count -ne 36) {
    throw "Unexpected catalog counts: modules=$($modules.Count), buildables=$($buildables.Count)"
}

$lines = [Collections.Generic.List[string]]::new()
$lines.Add('local M = {}')
$lines.Add('')
$lines.Add('M.game_build = "26639889"')
$lines.Add('')
$lines.Add('M.modules = {')
foreach ($module in $modules) {
    $id = [string]$module.id
    $pivot = @(Pivot-Offset $module)
    $lines.Add("    [$((Lua-String $id))] = {")
    $lines.Add("        id = $((Lua-String $id)),")
    $lines.Add("        size_units = {$([int]$module.sizeUnits[0]), $([int]$module.sizeUnits[1]), $([int]$module.sizeUnits[2])},")
    $lines.Add("        pivot_offset = {$($pivot[0]), $($pivot[1]), $($pivot[2])},")
    $lines.Add('        connectors = {')
    foreach ($connector in $module.connectors) {
        $lines.Add("            { type = $((Lua-String $connector.type)), gx = $([int]$connector.gx), gy = $([int]$connector.gy), floor_offset = $([int]$connector.floorOffset), rotation = $([int]$connector.rotation) },")
    }
    $lines.Add('        },')
    $lines.Add('    },')
}
$lines.Add('}')
$lines.Add('')
$lines.Add('M.module_by_class = {')
$moduleClasses = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
foreach ($module in $modules) {
    $id = [string]$module.id
    $sourceName = ([string]$module.sourceAsset -split '/')[-1]
    foreach ($name in @($id, $sourceName)) {
        $base = Class-Base $name
        $moduleClasses[$base] = $id
        $moduleClasses[$base + '_C'] = $id
    }
}
foreach ($pair in $moduleClasses.GetEnumerator()) {
    $lines.Add("    [$((Lua-String $pair.Key))] = $((Lua-String $pair.Value)),")
}
$lines.Add('}')
$lines.Add('')
$lines.Add('M.buildables = {')
foreach ($buildable in $buildables) {
    $id = [string]$buildable.id
    $lines.Add("    [$((Lua-String $id))] = {")
    $lines.Add("        id = $((Lua-String $id)),")
    $lines.Add("        object_class = $((Lua-String $buildable.objectClass)),")
    $lines.Add("        kind = $((Lua-String $buildable.kind)),")
    $lines.Add("        size = {$([int]$buildable.size[0]), $([int]$buildable.size[1])},")
    if ($null -ne $buildable.maxLength) {
        $lines.Add("        max_length = $([int]$buildable.maxLength),")
    } else {
        $lines.Add('        max_length = nil,')
    }
    $lines.Add('    },')
}
$lines.Add('}')
$lines.Add('')
$lines.Add('M.buildable_by_class = {')
$buildableClasses = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
foreach ($buildable in $buildables) {
    $base = Class-Base ([string]$buildable.objectClass)
    $buildableClasses[$base] = [string]$buildable.id
    $buildableClasses[$base + '_C'] = [string]$buildable.id
}
foreach ($pair in $buildableClasses.GetEnumerator()) {
    $lines.Add("    [$((Lua-String $pair.Key))] = $((Lua-String $pair.Value)),")
}
$lines.Add('}')
$lines.Add('')

$recipeOverrides = @{
    'REC_MageticCoils' = 'magneticcoils'
    'REC_MagneticCoilsAlt1' = 'magneticcoils2'
    'REC_ReinforcedPlates' = 'reinforcedplate'
    'REC_ReinforcedPlatesAlt' = 'reinforcedplatealt'
    'REC_Enzyme' = 'Enzyme'
    'REC_BackpackMk1' = 'backpack1'
    'REC_BackpackMk2' = 'backpack2'
    'REC_BackpackMk3' = 'backpack3'
    'REC_ExoskeletonMk1' = 'exoskeleton1'
    'REC_ExoskeletonMk2' = 'exoskeleton2'
    'REC_ExoskeletonMk3' = 'exoskeleton3'
    'REC_JetpackMk1' = 'jetpack1'
    'REC_JetpackMk2' = 'jetpack2'
    'REC_JetpackMk3' = 'jetpack3'
    'REC_SpacesuitMk1' = 'spacesuit1'
    'REC_SpacesuitMk2' = 'spacesuit2'
    'REC_SpacesuitMk3' = 'spacesuit3'
    'REC_Battery_01' = 'battery1'
    'REC_Battery_02' = 'battery2'
    'REC_FuelCell_01' = 'fuelcell1'
}
$itemOverrides = @{
    'ITEM_ReinforcedPlates' = 'reinforcedplate'
    'ITEM_AdvancedPlates' = 'Advancedplates'
    'ITEM_AlphaProtein' = 'AlphaProtein'
    'ITEM_BetaProtein' = 'BetaProtein'
    'ITEM_Biolattice' = 'Biolattice'
    'ITEM_ChitinComposite' = 'ChitinComposite'
    'ITEM_EmptySimulationMatrix' = 'EmptySimulationMatrix'
    'ITEM_EncodedSimulationMatrix' = 'EncodedSimulationMatrix'
    'ITEM_Enzyme' = 'Enzyme'
    'ITEM_StellarSurveyData' = 'StellarSurveyData'
    'ITEM_Xenoarchaea' = 'Xenoarchaea'
    'ITEM_BackpackMk1' = 'backpack1'
    'ITEM_BackpackMk2' = 'backpack2'
    'ITEM_BackpackMk3' = 'backpack3'
    'ITEM_ExoskeletonMk1' = 'exoskeleton1'
    'ITEM_ExoskeletonMk2' = 'exoskeleton2'
    'ITEM_ExoskeletonMk3' = 'exoskeleton3'
    'ITEM_Battery_01' = 'battery1'
    'ITEM_Battery_02' = 'battery2'
    'ITEM_FuelCell_01' = 'fuelcell1'
    'ITEM_Relic_01' = 'relic1'
    'ITEM_Relic_02' = 'relic2'
    'ITEM_Relic_03' = 'relic3'
    'ITEM_Relic_04' = 'relic4'
    'ITEM_Relic_05' = 'relic5'
    'DAT_ConveyorBelt' = 'conveyor1'
    'DAT_Splitter' = 'splitter1'
    'DAT_Container' = 'container1'
    'DAT_Refinery' = 'Refinery'
    'DAT_Assembler' = 'Assembler'
    'DAT_EnrichmentChamber' = 'EnrichmentChamber'
    'DAT_MatSciLab' = 'matscilab'
    'DAT_CompSciLab' = 'compscilab'
}

$recipeAliases = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
$itemAliases = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
foreach ($recipe in $catalog.recipes) {
    $rid = [string]$recipe.id
    $recipeAliases[$rid] = $rid
    $recipeAliases[$rid.ToLowerInvariant()] = $rid
    $defaultShort = ($rid -replace '^REC_', '').ToLowerInvariant()
    $recipeAliases[$defaultShort] = $rid
    if ($recipeOverrides.ContainsKey($rid)) {
        $ov = $recipeOverrides[$rid]
        $recipeAliases[$ov] = $rid
        $recipeAliases[$ov.ToLowerInvariant()] = $rid
    }
    foreach ($io in @($recipe.inputs) + @($recipe.outputs)) {
        $iid = [string]$io.itemId
        if (-not $iid) { continue }
        $itemAliases[$iid] = $iid
        $itemAliases[$iid.ToLowerInvariant()] = $iid
        $shortItem = ($iid -replace '^(ITEM_|DAT_)', '').ToLowerInvariant()
        if (-not $itemAliases.ContainsKey($shortItem)) {
            $itemAliases[$shortItem] = $iid
        }
    }
}
foreach ($kv in $itemOverrides.GetEnumerator()) {
    $itemAliases[$kv.Key] = $kv.Key
    $itemAliases[$kv.Value] = $kv.Key
    $itemAliases[$kv.Value.ToLowerInvariant()] = $kv.Key
}

$lines.Add('M.recipe_by_alias = {')
foreach ($pair in $recipeAliases.GetEnumerator()) {
    $lines.Add("    [$((Lua-String $pair.Key))] = $((Lua-String $pair.Value)),")
}
$lines.Add('}')
$lines.Add('')
$lines.Add('M.item_by_alias = {')
foreach ($pair in $itemAliases.GetEnumerator()) {
    $lines.Add("    [$((Lua-String $pair.Key))] = $((Lua-String $pair.Value)),")
}
$lines.Add('}')
$lines.Add('')
$lines.Add('return M')

$parent = Split-Path -Parent $outputFullPath
[IO.Directory]::CreateDirectory($parent) | Out-Null
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllLines($outputFullPath, $lines, $utf8)
Write-Output $outputFullPath
