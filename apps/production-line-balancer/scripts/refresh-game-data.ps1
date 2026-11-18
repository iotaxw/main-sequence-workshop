param(
    [string]$GameRoot = 'D:\Program Files\Steam\steamapps\common\Main Sequence',
    [int]$ProcessId = 0
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path (Split-Path (Split-Path $GameRoot -Parent) -Parent) 'appmanifest_2487190.acf'
$paks = Join-Path $GameRoot 'Windows\MainSequence\Content\Paks'
$dotnet = Join-Path $projectRoot '.tools\dotnet\dotnet.exe'
$dumper = Join-Path $projectRoot '.tools\jmap\jmap_dumper.exe'

if (-not (Test-Path -LiteralPath $manifest)) { throw "Steam manifest not found: $manifest" }
if (-not (Test-Path -LiteralPath $paks)) { throw "Game content directory not found: $paks" }
if (-not (Test-Path -LiteralPath $dotnet)) { throw 'Local .NET SDK is missing. See README.md for setup.' }

$buildMatch = [regex]::Match((Get-Content -Raw -LiteralPath $manifest), '"buildid"\s+"(\d+)"')
if (-not $buildMatch.Success) { throw 'Steam Build ID was not found in the app manifest.' }
$buildId = $buildMatch.Groups[1].Value
$mappings = Join-Path $projectRoot ".tools\MainSequence-$buildId.usmap"

if (-not (Test-Path -LiteralPath $mappings)) {
    if ($ProcessId -le 0) {
        throw "Mappings are missing for Build $buildId. Start the game and rerun with -ProcessId <PID>."
    }
    if (-not (Test-Path -LiteralPath $dumper)) { throw 'jmap_dumper is missing. See README.md for setup.' }
    & $dumper --pid $ProcessId $mappings
    if ($LASTEXITCODE -ne 0) { throw "Mapping generation failed with exit code $LASTEXITCODE." }
}

$output = Join-Path $projectRoot "data\main-sequence-$buildId.dataset.json"
$repeat = Join-Path $projectRoot ".tools\repeat-$buildId.dataset.json"
try {
    & $dotnet run --project (Join-Path $projectRoot 'importer\importer.csproj') -- import $paks $mappings $buildId $output
    if ($LASTEXITCODE -ne 0) { throw "Dataset import failed with exit code $LASTEXITCODE." }
    & $dotnet run --project (Join-Path $projectRoot 'importer\importer.csproj') -- import $paks $mappings $buildId $repeat
    if ($LASTEXITCODE -ne 0) { throw "Dataset verification import failed with exit code $LASTEXITCODE." }

    $first = [System.IO.File]::ReadAllBytes($output)
    $second = [System.IO.File]::ReadAllBytes($repeat)
    if (-not [System.Linq.Enumerable]::SequenceEqual($first, $second)) {
        throw 'Determinism check failed: repeated imports produced different datasets.'
    }
    Write-Output "Build $buildId imported and verified: $output"
}
finally {
    if (Test-Path -LiteralPath $repeat) { Remove-Item -LiteralPath $repeat }
}
