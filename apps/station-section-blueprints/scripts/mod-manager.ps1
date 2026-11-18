[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('list', 'enable', 'disable')]
    [string]$Action,

    [Parameter(Position = 1)]
    [string]$Name,

    [string]$ModsRoot = (Join-Path $PSScriptRoot '../Mods')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($ModsRoot)
$modsTxt = Join-Path $root 'mods.txt'

function Test-ModName {
    param([string]$Value)
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*$') {
        throw "Invalid mod name: $Value"
    }
}

function Read-ModsTxt {
    if (-not (Test-Path -LiteralPath $modsTxt -PathType Leaf)) {
        return @()
    }
    return @(Get-Content -LiteralPath $modsTxt -Encoding UTF8)
}

function Get-Entries {
    $lines = Read-ModsTxt
    $entries = @{}
    foreach ($line in $lines) {
        if ($line -match '^\s*([^#;][^:]*?)\s*:\s*([01])\s*$') {
            $modName = $Matches[1].Trim()
            $entries[$modName] = [int]$Matches[2]
        }
    }
    if (Test-Path -LiteralPath $root -PathType Container) {
        foreach ($directory in Get-ChildItem -LiteralPath $root -Directory) {
            if (-not $entries.ContainsKey($directory.Name)) {
                $entries[$directory.Name] = 0
            }
        }
    }
    return $entries
}

function Set-Entry {
    param([bool]$Enabled)
    Test-ModName $Name
    $modDirectory = Join-Path $root $Name
    $entrypoint = Join-Path $modDirectory 'Scripts/main.lua'
    if ($Enabled -and -not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
        throw "Mod entrypoint not found: $entrypoint"
    }

    $lines = [Collections.Generic.List[string]]::new()
    foreach ($line in Read-ModsTxt) {
        $lines.Add($line)
    }
    $pattern = '^\s*' + [regex]::Escape($Name) + '\s*:\s*[01]\s*$'
    $replacement = "${Name} : $([int]$Enabled)"
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match $pattern) {
            $lines[$index] = $replacement
            $found = $true
        }
    }
    if (-not $found) {
        $lines.Add($replacement)
    }

    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }
    $temporary = "$modsTxt.tmp"
    [IO.File]::WriteAllLines($temporary, $lines, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $modsTxt -Force
}

switch ($Action) {
    'list' {
        $entries = Get-Entries
        foreach ($modName in ($entries.Keys | Sort-Object)) {
            $entrypoint = Join-Path (Join-Path $root $modName) 'Scripts/main.lua'
            [PSCustomObject]@{
                Name = $modName
                Enabled = [bool]$entries[$modName]
                Installed = Test-Path -LiteralPath $entrypoint -PathType Leaf
                ModsRoot = $root
            }
        }
    }
    'enable' {
        if (-not $Name) { throw 'enable requires -Name' }
        Set-Entry $true
    }
    'disable' {
        if (-not $Name) { throw 'disable requires -Name' }
        Set-Entry $false
    }
}
