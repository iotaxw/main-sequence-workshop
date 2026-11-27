[CmdletBinding()]
param(
    [switch]$IncludeMotherDesign,
    [switch]$DevelopmentLibrary,
    [string]$OutputPreviewDir
)

$ErrorActionPreference = 'Stop'

$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$codec = Join-Path $appRoot 'Mods\StationSectionBlueprints\Binaries\ms-blueprint-codec.exe'
$fixturesDir = Join-Path $appRoot 'test-blueprints'
if (-not (Test-Path -LiteralPath $codec -PathType Leaf)) {
    throw "ms-blueprint-codec.exe not found at $codec. Run scripts/start-debug.ps1 -BuildOnly first."
}
if (-not (Test-Path -LiteralPath $fixturesDir -PathType Container)) {
    throw "test-blueprints directory not found at $fixturesDir."
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

if ($IncludeMotherDesign) {
    $motherJson = Join-Path $fixturesDir '局部蓝图测试母站.json'
    if (-not (Test-Path -LiteralPath $motherJson -PathType Leaf)) {
        throw "Missing mother design fixture: $motherJson"
    }
    $motherSav = Join-Path $designsDir '局部蓝图测试母站.sav'
    & $codec to-sav --input $motherJson --output $motherSav --mode station | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to encode 局部蓝图测试母站.sav' }
    if ($OutputPreviewDir) {
        Copy-Item -LiteralPath $motherJson -Destination (Join-Path $OutputPreviewDir '局部蓝图测试母站.json') -Force
        Copy-Item -LiteralPath $motherSav -Destination (Join-Path $OutputPreviewDir '局部蓝图测试母站.sav') -Force
    }
    Write-Host "[SSB Seed] Installed mother design -> $motherSav"
}

$sections = @(
    [ordered]@{ id = '6b080001-000001'; file = '01-单块精炼产线.json';   name = '01-单块精炼产线';   folder = '基础对接';   includes_machines = $true }
    [ordered]@{ id = '6b080001-000002'; file = '02-双块地下带枢纽.json'; name = '02-双块地下带枢纽'; folder = '基础对接';   includes_machines = $true }
    [ordered]@{ id = '6b080001-000003'; file = '03-双层阳台工厂.json';   name = '03-双层阳台工厂';   folder = '异形与多层'; includes_machines = $true }
    [ordered]@{ id = '6b080001-000004'; file = '04-L形三块纯壳体.json';  name = '04-L形三块纯壳体';  folder = '异形与多层'; includes_machines = $false }
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
    $srcJson = Join-Path $fixturesDir $sec.file
    if (-not (Test-Path -LiteralPath $srcJson -PathType Leaf)) {
        throw "Missing section fixture: $srcJson"
    }
    $jsonOut = Join-Path $itemsDir ($sec.id + '.json')
    $savOut = Join-Path $itemsDir ($sec.id + '.sav')
    Copy-Item -LiteralPath $srcJson -Destination $jsonOut -Force
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

Write-Host "[SSB Seed] Installed $($sections.Count) test section blueprints from $fixturesDir into $libDir"
