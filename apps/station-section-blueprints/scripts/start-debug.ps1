[CmdletBinding()]
param(
    [string]$GameExe = $env:MAIN_SEQUENCE_EXE,
    [string[]]$GameArgs = @(),
    [switch]$RebuildCodec,
    [switch]$BuildOnly,
    [switch]$Package,
    [string]$PackageVersion = '0.2.0',
    [switch]$SeedTestBlueprints,
    [switch]$IncludeMotherDesign,
    [switch]$EnableDebugSandbox,
    [switch]$SkipRunningCheck
)

$ErrorActionPreference = 'Stop'

$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $appRoot '..\..'))
$codecManifest = Join-Path $repoRoot 'packages\ms-blueprint-codec\Cargo.toml'
$codecTargetExe = Join-Path $appRoot 'Mods\StationSectionBlueprints\Binaries\ms-blueprint-codec.exe'
$localModsDir = Join-Path $appRoot 'Mods'
$modsTxtPath = Join-Path $localModsDir 'mods.txt'

function Ensure-CodecBinary {
    $needsBuild = $RebuildCodec -or (-not (Test-Path -LiteralPath $codecTargetExe -PathType Leaf))
    if (-not $needsBuild -and (Test-Path -LiteralPath $codecManifest -PathType Leaf)) {
        $binTime = (Get-Item -LiteralPath $codecTargetExe).LastWriteTimeUtc
        $srcDir = Join-Path (Split-Path -Parent $codecManifest) 'src'
        $latestSrc = Get-ChildItem -LiteralPath $srcDir -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($latestSrc -and $latestSrc.LastWriteTimeUtc -gt $binTime) {
            Write-Host '[SSB Debug] Detected newer ms-blueprint-codec source; rebuilding...'
            $needsBuild = $true
        }
    }
    if (-not $needsBuild) {
        Write-Host "[SSB Debug] Codec binary ready: $codecTargetExe"
        return
    }
    if (-not (Test-Path -LiteralPath $codecManifest -PathType Leaf)) {
        throw "ms-blueprint-codec Cargo.toml not found at $codecManifest. Cannot build ms-blueprint-codec.exe."
    }
    if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
        throw 'Rust toolchain (cargo) not found on PATH. Install Rust (https://rustup.rs) or place prebuilt ms-blueprint-codec.exe in Mods/StationSectionBlueprints/Binaries/.'
    }
    Write-Host "[SSB Debug] Building ms-blueprint-codec (release) from $codecManifest ..."
    & cargo build --release --manifest-path $codecManifest --bin ms-blueprint-cli
    if ($LASTEXITCODE -ne 0) {
        throw "cargo build failed with exit code $LASTEXITCODE."
    }
    $builtExe = Join-Path (Split-Path -Parent $codecManifest) 'target\release\ms-blueprint-cli.exe'
    if (-not (Test-Path -LiteralPath $builtExe -PathType Leaf)) {
        throw "Expected compiled binary not found: $builtExe"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $codecTargetExe) -Force | Out-Null
    Copy-Item -LiteralPath $builtExe -Destination $codecTargetExe -Force
    Write-Host "[SSB Debug] Installed codec binary -> $codecTargetExe"
}

function Ensure-ModsTxt {
    $expected = 'StationSectionBlueprints : 1'
    if (-not (Test-Path -LiteralPath $modsTxtPath -PathType Leaf)) {
        [IO.File]::WriteAllText($modsTxtPath, $expected + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
        Write-Host "[SSB Debug] Created $modsTxtPath"
        return
    }
    $lines = @(Get-Content -LiteralPath $modsTxtPath -Encoding UTF8)
    $matched = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*StationSectionBlueprints\s*:') {
            $lines[$i] = $expected
            $matched = $true
        }
    }
    if (-not $matched) { $lines += $expected }
    [IO.File]::WriteAllLines($modsTxtPath, $lines, [Text.UTF8Encoding]::new($false))
}

function Resolve-GameExecutable([string]$ExplicitPath) {
    $relExe = 'steamapps\common\Main Sequence\Windows\MainSequence\Binaries\Win64\MainSequence-Win64-Shipping.exe'
    if ($ExplicitPath) {
        if (-not (Test-Path -LiteralPath $ExplicitPath -PathType Leaf)) {
            throw "Game executable not found at: $ExplicitPath"
        }
        return (Get-Item -LiteralPath $ExplicitPath).FullName
    }

    $steamRoots = [Collections.Generic.List[string]]::new()
    try {
        $regPath = (Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction Stop).SteamPath
        if ($regPath) { $steamRoots.Add(($regPath -replace '/', '\')) }
    } catch { }
    foreach ($candidate in @(
        'C:\Program Files (x86)\Steam',
        'C:\Program Files\Steam',
        'D:\Program Files (x86)\Steam',
        'D:\Program Files\Steam',
        'E:\SteamLibrary',
        'D:\SteamLibrary'
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Container) { $steamRoots.Add($candidate) }
    }

    $libraryRoots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($root in $steamRoots) {
        [void]$libraryRoots.Add($root)
        $vdf = Join-Path $root 'steamapps\libraryfolders.vdf'
        if (Test-Path -LiteralPath $vdf -PathType Leaf) {
            foreach ($line in (Get-Content -LiteralPath $vdf -Encoding UTF8)) {
                if ($line -match '"path"\s+"([^"]+)"') {
                    $libPath = $Matches[1] -replace '\\\\', '\'
                    [void]$libraryRoots.Add($libPath)
                }
            }
        }
    }

    foreach ($lib in $libraryRoots) {
        $exe = Join-Path $lib $relExe
        if (Test-Path -LiteralPath $exe -PathType Leaf) {
            return (Get-Item -LiteralPath $exe).FullName
        }
    }
    throw "Could not auto-detect MainSequence-Win64-Shipping.exe. Pass -GameExe '<full path>' or set `$env:MAIN_SEQUENCE_EXE."
}

Ensure-CodecBinary
Ensure-ModsTxt

if ($SeedTestBlueprints -or $IncludeMotherDesign) {
    $seedScript = Join-Path $PSScriptRoot 'seed-test-blueprints.ps1'
    if (-not (Test-Path -LiteralPath $seedScript -PathType Leaf)) {
        throw "Seed script not found: $seedScript"
    }
    $seedArgs = @{}
    if ($IncludeMotherDesign -or $SeedTestBlueprints) { $seedArgs['IncludeMotherDesign'] = $true }
    & $seedScript @seedArgs
}

if ($Package) {
    $packageScript = Join-Path $PSScriptRoot 'package.ps1'
    $zipPath = & $packageScript -Version $PackageVersion
    Write-Host "[SSB Debug] Packaged release zip -> $zipPath"
}

if ($BuildOnly) {
    Write-Host '[SSB Debug] BuildOnly complete. Ready to launch.'
    exit 0
}

$resolvedExe = Resolve-GameExecutable $GameExe
$gameItem = Get-Item -LiteralPath $resolvedExe
if ($gameItem.Name -ne 'MainSequence-Win64-Shipping.exe') {
    throw "Unexpected executable name: $($gameItem.FullName)"
}

if (-not $SkipRunningCheck -and (Get-Process -Name 'MainSequence-Win64-Shipping' -ErrorAction SilentlyContinue)) {
    throw 'MainSequence-Win64-Shipping is already running. Close it first (or pass -SkipRunningCheck).'
}

$gameWin64 = $gameItem.Directory.FullName
$gameUe4ssMods = Join-Path $gameWin64 'ue4ss\Mods'
if (-not (Test-Path -LiteralPath (Join-Path $gameWin64 'ue4ss') -PathType Container)) {
    Write-Warning "UE4SS directory not found at $gameUe4ssMods. Install UE4SS first (see INSTALL.md) or the Mod will not load."
}

$env:UE4SS_MODS_PATHS = "$localModsDir;$gameUe4ssMods"
Remove-Item Env:SSB_DISABLE_UI -ErrorAction SilentlyContinue
Remove-Item Env:SSB_DEV_COMMAND_FILE -ErrorAction SilentlyContinue
if ($EnableDebugSandbox) {
    $env:SSB_DEBUG_SANDBOX = '1'
} else {
    Remove-Item Env:SSB_DEBUG_SANDBOX -ErrorAction SilentlyContinue
}

$saveLibrary = Join-Path $env:LOCALAPPDATA 'MainSequence\Saved\SaveGames\StationSectionBlueprints'
Write-Host "[SSB Debug] Game Exe          : $($gameItem.FullName)"
Write-Host "[SSB Debug] UE4SS_MODS_PATHS  : $env:UE4SS_MODS_PATHS"
Write-Host "[SSB Debug] Blueprint Library : $saveLibrary"
Write-Host "[SSB Debug] UE4SS Log         : $(Join-Path $gameWin64 'ue4ss\UE4SS.log')"
if ($EnableDebugSandbox) {
    Write-Host '[SSB Debug] Debug Sandbox     : ENABLED (F9 = toggle Creative Mode, Shift+F9 = unlock all research)'
}
Write-Host '[SSB Debug] Tip: Edit Lua scripts directly in Mods/StationSectionBlueprints/Scripts/ and press Ctrl+R in UE4SS to hot-reload.'

if ($GameArgs.Count -gt 0) {
    Start-Process -FilePath $gameItem.FullName -WorkingDirectory $gameWin64 -ArgumentList $GameArgs
} else {
    Start-Process -FilePath $gameItem.FullName -WorkingDirectory $gameWin64
}
