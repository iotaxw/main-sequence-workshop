[CmdletBinding()]
param(
    [switch]$IncludeMotherDesign,
    [switch]$DevelopmentLibrary,
    [string]$OutputPreviewDir
)

$ErrorActionPreference = 'Stop'

$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$codec = Join-Path $appRoot 'Mods\StationSectionBlueprints\Binaries\ms-blueprint-codec.exe'
if (-not (Test-Path -LiteralPath $codec -PathType Leaf)) {
    throw "ms-blueprint-codec.exe not found at $codec. Run scripts/start-debug.ps1 -BuildOnly first."
}

$saveGames = Join-Path $env:LOCALAPPDATA 'MainSequence\Saved\SaveGames'
$libRootName = if ($DevelopmentLibrary) { 'StationSectionBlueprints-dev' } else { 'StationSectionBlueprints' }
$libDir = Join-Path $saveGames $libRootName
$itemsDir = Join-Path $libDir 'items'
$designsDir = Join-Path $saveGames 'Designs'

New-Item -ItemType Directory -Path $itemsDir -Force | Out-Null
if ($IncludeMotherDesign) { New-Item -ItemType Directory -Path $designsDir -Force | Out-Null }
if ($OutputPreviewDir) { New-Item -ItemType Directory -Path $OutputPreviewDir -Force | Out-Null }

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Encode-SsbField([string]$Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $sb = [Text.StringBuilder]::new()
    foreach ($b in $bytes) {
        if (($b -ge 48 -and $b -le 57) -or ($b -ge 65 -and $b -le 90) -or ($b -ge 97 -and $b -le 122) -or $b -eq 45 -or $b -eq 46 -or $b -eq 95 -or $b -eq 126) {
            [void]$sb.Append([char]$b)
        } else {
            [void]$sb.Append(('%{0:X2}' -f $b))
        }
    }
    return $sb.ToString()
}

function New-BlueprintDoc([string]$Id, [string]$Name, [string]$Description, [array]$Modules, [array]$Buildings) {
    return [ordered]@{
        format        = 'station-blueprint-designer'
        formatVersion = 2
        id            = $Id
        name          = $Name
        description   = $Description
        gameData      = [ordered]@{ buildId = '26639889'; catalogVersion = 1 }
        modules       = $Modules
        buildings     = $Buildings
    }
}

if ($IncludeMotherDesign) {
    $motherDoc = New-BlueprintDoc `
        -Id 'ssb-manual-test-mother-station' `
        -Name '局部蓝图测试母站' `
        -Description '5模块手工测试母站：含跨门传送带、跨模块地下带对、骑跨门洞工作台与2x2双层阳台，用于测试Shift+左键多选、跨边缘自动剔除与全套拼接微调。' `
        -Modules @(
            [ordered]@{ id = 'm_cmd';     type = 'BPO_CommandModule'; gx = -1; gy = 0; floor = 0; rotation = 2; nativeMeta = [ordered]@{ block_id = 1001 } }
            [ordered]@{ id = 'm_a';       type = 'BPO_Station_01';    gx = 0;  gy = 0; floor = 0; rotation = 0; nativeMeta = [ordered]@{ block_id = 1002 } }
            [ordered]@{ id = 'm_b';       type = 'BPO_Station_01';    gx = 1;  gy = 0; floor = 0; rotation = 0; nativeMeta = [ordered]@{ block_id = 1003 } }
            [ordered]@{ id = 'm_c';       type = 'BPO_Station_01';    gx = 0;  gy = 1; floor = 0; rotation = 0; nativeMeta = [ordered]@{ block_id = 1004 } }
            [ordered]@{ id = 'm_balcony'; type = 'BPO_Station_02';    gx = 1;  gy = 1; floor = 0; rotation = 0; nativeMeta = [ordered]@{ block_id = 1005 } }
        ) `
        -Buildings @(
            [ordered]@{ id = 'a_ref_1';     type = 'DAT_Refinery';          x = 3;  y = 3;  floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
            [ordered]@{ id = 'a_ref_2';     type = 'DAT_Refinery';          x = 7;  y = 3;  floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
            [ordered]@{ id = 'a_split';     type = 'DAT_Splitter_2';        x = 5;  y = 7;  floor = 0; rotation = 0; priorityOut = 2; portFilters = [ordered]@{ '0' = 'ITEM_HydrogenFuel' } }
            [ordered]@{ id = 'a_belt1';     type = 'DAT_ConveyorBelt2';     x = 6;  y = 7;  floor = 0; rotation = 0 }
            [ordered]@{ id = 'a_belt2';     type = 'DAT_ConveyorBelt2';     x = 7;  y = 7;  floor = 0; rotation = 0 }
            [ordered]@{ id = 'cb_door_a';   type = 'DAT_ConveyorBelt2';     x = 15; y = 7;  floor = 0; rotation = 0 }
            [ordered]@{ id = 'cb_door_b';   type = 'DAT_ConveyorBelt2';     x = 16; y = 7;  floor = 0; rotation = 0 }
            [ordered]@{ id = 'cb_ug_in';    type = 'DAT_UndergroundBelt_2'; x = 12; y = 10; floor = 0; rotation = 0; undergroundMode = 'in';  undergroundPartnerId = 'cb_ug_out' }
            [ordered]@{ id = 'cb_ug_out';   type = 'DAT_UndergroundBelt_2'; x = 18; y = 10; floor = 0; rotation = 0; undergroundMode = 'out'; undergroundPartnerId = 'cb_ug_in' }
            [ordered]@{ id = 'cb_wb_ac';    type = 'DAT_WorkbenchMachine';  x = 6;  y = 14; floor = 0; rotation = 0 }
            [ordered]@{ id = 'b_ref_1';     type = 'DAT_Refinery';          x = 20; y = 3;  floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
            [ordered]@{ id = 'b_ug_in';     type = 'DAT_UndergroundBelt_2'; x = 20; y = 12; floor = 0; rotation = 0; undergroundMode = 'in';  undergroundPartnerId = 'b_ug_out' }
            [ordered]@{ id = 'b_ug_out';    type = 'DAT_UndergroundBelt_2'; x = 25; y = 12; floor = 0; rotation = 0; undergroundMode = 'out'; undergroundPartnerId = 'b_ug_in' }
            [ordered]@{ id = 'bal_f0_ref1'; type = 'DAT_Refinery';          x = 22; y = 22; floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
            [ordered]@{ id = 'bal_f0_ref2'; type = 'DAT_Refinery';          x = 27; y = 22; floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
            [ordered]@{ id = 'bal_f1_ref1'; type = 'DAT_Refinery';          x = 17; y = 22; floor = 1; rotation = 0; recipeId = 'REC_HydrogenFuel' }
            [ordered]@{ id = 'bal_f1_belt'; type = 'DAT_ConveyorBelt2';     x = 18; y = 26; floor = 1; rotation = 1 }
        )

    $tmpJson = Join-Path ([IO.Path]::GetTempPath()) "ssb-mother-$([Guid]::NewGuid().ToString('N')).json"
    try {
        Write-Utf8NoBom $tmpJson ($motherDoc | ConvertTo-Json -Depth 10)
        $motherSav = Join-Path $designsDir '局部蓝图测试母站.sav'
        & $codec to-sav --input $tmpJson --output $motherSav --mode station | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Failed to encode 局部蓝图测试母站.sav' }
        if ($OutputPreviewDir) {
            Copy-Item -LiteralPath $tmpJson -Destination (Join-Path $OutputPreviewDir '局部蓝图测试母站.json') -Force
            Copy-Item -LiteralPath $motherSav -Destination (Join-Path $OutputPreviewDir '局部蓝图测试母站.sav') -Force
        }
        Write-Host "[SSB Seed] Installed mother design -> $motherSav"
    } finally {
        Remove-Item -LiteralPath $tmpJson -Force -ErrorAction SilentlyContinue
    }
}

$sections = @(
    [ordered]@{
        id = '6b080001-000001'; name = '01-单块精炼产线'; folder = '基础对接'; includes_machines = $true
        doc = New-BlueprintDoc -Id 'sec-01-single-refinery' -Name '01-单块精炼产线' `
            -Description '1x1常规快贴测试：含2台氢燃料精炼厂、分流器(优先口2+过滤氢燃料)与传送带。' `
            -Modules @([ordered]@{ id = 'm1'; type = 'BPO_Station_01'; gx = 0; gy = 0; floor = 0; rotation = 0 }) `
            -Buildings @(
                [ordered]@{ id = 's1_ref1';  type = 'DAT_Refinery';      x = 3; y = 3; floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
                [ordered]@{ id = 's1_ref2';  type = 'DAT_Refinery';      x = 8; y = 3; floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
                [ordered]@{ id = 's1_split'; type = 'DAT_Splitter_2';    x = 6; y = 8; floor = 0; rotation = 0; priorityOut = 2; portFilters = [ordered]@{ '0' = 'ITEM_HydrogenFuel' } }
                [ordered]@{ id = 's1_belt1'; type = 'DAT_ConveyorBelt2'; x = 7; y = 8; floor = 0; rotation = 0 }
                [ordered]@{ id = 's1_belt2'; type = 'DAT_ConveyorBelt2'; x = 8; y = 8; floor = 0; rotation = 0 }
            )
    },
    [ordered]@{
        id = '6b080001-000002'; name = '02-双块地下带枢纽'; folder = '基础对接'; includes_machines = $true
        doc = New-BlueprintDoc -Id 'sec-02-dual-underground' -Name '02-双块地下带枢纽' `
            -Description '2x1多接口对齐测试：测试双接口优先排序、Tab轮换、Alt自由网格与地下带(Length=7)。' `
            -Modules @(
                [ordered]@{ id = 'm1'; type = 'BPO_Station_01'; gx = 0; gy = 0; floor = 0; rotation = 0 }
                [ordered]@{ id = 'm2'; type = 'BPO_Station_01'; gx = 1; gy = 0; floor = 0; rotation = 0 }
            ) `
            -Buildings @(
                [ordered]@{ id = 's2_ref1';   type = 'DAT_Refinery';          x = 4;  y = 3;  floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
                [ordered]@{ id = 's2_split';  type = 'DAT_Splitter_2';        x = 12; y = 7;  floor = 0; rotation = 0; priorityOut = 1; portFilters = [ordered]@{ '0' = 'ITEM_HydrogenFuel' } }
                [ordered]@{ id = 's2_belt1';  type = 'DAT_ConveyorBelt2';     x = 15; y = 7;  floor = 0; rotation = 0 }
                [ordered]@{ id = 's2_belt2';  type = 'DAT_ConveyorBelt2';     x = 16; y = 7;  floor = 0; rotation = 0 }
                [ordered]@{ id = 's2_ug_in';  type = 'DAT_UndergroundBelt_2'; x = 12; y = 11; floor = 0; rotation = 0; undergroundMode = 'in';  undergroundPartnerId = 's2_ug_out' }
                [ordered]@{ id = 's2_ug_out'; type = 'DAT_UndergroundBelt_2'; x = 18; y = 11; floor = 0; rotation = 0; undergroundMode = 'out'; undergroundPartnerId = 's2_ug_in' }
            )
    },
    [ordered]@{
        id = '6b080001-000003'; name = '03-双层阳台工厂'; folder = '异形与多层'; includes_machines = $true
        doc = New-BlueprintDoc -Id 'sec-03-balcony-2floor' -Name '03-双层阳台工厂' `
            -Description '2x2x2双层阳台测试：重点测试H锁定预览、自由旋转3D视角、方向键与PageUp/Down微调及R原地旋转。' `
            -Modules @([ordered]@{ id = 'm1'; type = 'BPO_Station_02'; gx = 0; gy = 0; floor = 0; rotation = 0 }) `
            -Buildings @(
                [ordered]@{ id = 's3_f0_ref1'; type = 'DAT_Refinery';      x = 6;  y = 6;  floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
                [ordered]@{ id = 's3_f0_ref2'; type = 'DAT_Refinery';      x = 12; y = 6;  floor = 0; rotation = 0; recipeId = 'REC_HydrogenFuel' }
                [ordered]@{ id = 's3_f1_ref1'; type = 'DAT_Refinery';      x = 1;  y = 6;  floor = 1; rotation = 0; recipeId = 'REC_HydrogenFuel' }
                [ordered]@{ id = 's3_f1_belt'; type = 'DAT_ConveyorBelt2'; x = 2;  y = 10; floor = 1; rotation = 1 }
            )
    },
    [ordered]@{
        id = '6b080001-000004'; name = '04-L形三块纯壳体'; folder = '异形与多层'; includes_machines = $false
        doc = New-BlueprintDoc -Id 'sec-04-l-shell' -Name '04-L形三块纯壳体' `
            -Description '3块L形纯壳体测试：验证允许F镜像、Tab多朝向轮换且退出后不弹机台确认条。' `
            -Modules @(
                [ordered]@{ id = 'm1'; type = 'BPO_Station_01'; gx = 0; gy = 0; floor = 0; rotation = 0 }
                [ordered]@{ id = 'm2'; type = 'BPO_Station_01'; gx = 1; gy = 0; floor = 0; rotation = 0 }
                [ordered]@{ id = 'm3'; type = 'BPO_Station_01'; gx = 0; gy = 1; floor = 0; rotation = 0 }
            ) `
            -Buildings @()
    }
)

$indexPath = Join-Path $libDir 'index.ssb'
$folders = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
$existingLines = [Collections.Generic.List[string]]::new()
$seedIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($s in $sections) { [void]$seedIds.Add($s.id) }

if (Test-Path -LiteralPath $indexPath -PathType Leaf) {
    foreach ($line in (Get-Content -LiteralPath $indexPath -Encoding UTF8)) {
        if ($line -match '^F\t(.+)$') {
            [void]$folders.Add($Matches[1])
        } elseif ($line -match '^B\t([^\t]+)\t') {
            if (-not $seedIds.Contains($Matches[1])) {
                $existingLines.Add($line)
            }
        }
    }
}

$createdAt = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
$newEntries = [Collections.Generic.List[string]]::new()
foreach ($sec in $sections) {
    $jsonOut = Join-Path $itemsDir ($sec.id + '.json')
    $savOut = Join-Path $itemsDir ($sec.id + '.sav')
    Write-Utf8NoBom $jsonOut ($sec.doc | ConvertTo-Json -Depth 10)
    $conv = & $codec to-sav --input $jsonOut --output $savOut --mode preset | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw "Failed to encode section $($sec.name)" }
    if ($OutputPreviewDir) {
        Copy-Item -LiteralPath $jsonOut -Destination (Join-Path $OutputPreviewDir ($sec.name + '.json')) -Force
        Copy-Item -LiteralPath $savOut -Destination (Join-Path $OutputPreviewDir ($sec.name + '.sav')) -Force
    }
    if ($sec.folder) { [void]$folders.Add((Encode-SsbField $sec.folder)) }
    $incFlag = if ($sec.includes_machines) { '1' } else { '0' }
    $newEntries.Add((@(
        'B', $sec.id, (Encode-SsbField $sec.name), (Encode-SsbField $sec.folder),
        $incFlag, ([int]$conv.module_count), ([int]$conv.native_machine_count),
        (Encode-SsbField '26639889'), (Encode-SsbField $createdAt)
    ) -join "`t"))
}

$allLines = [Collections.Generic.List[string]]::new()
$allLines.Add("SSB_LIBRARY`t1")
foreach ($f in $folders) { $allLines.Add("F`t$f") }
$combinedEntries = @($existingLines) + @($newEntries) | Sort-Object { ($_ -split "`t")[1] }
foreach ($entryLine in $combinedEntries) { $allLines.Add($entryLine) }
Write-Utf8NoBom $indexPath (($allLines -join "`n") + "`n")

Write-Host "[SSB Seed] Installed $($sections.Count) test section blueprints into $libDir"
