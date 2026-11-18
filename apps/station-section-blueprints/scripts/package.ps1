[CmdletBinding()]
param(
    [string]$Version = '0.1.0-dev',
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../dist')
)

$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "Invalid version: $Version"
}

$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $project 'Mods/StationSectionBlueprints/Scripts'
if (-not (Test-Path -LiteralPath (Join-Path $source 'main.lua') -PathType Leaf)) {
    throw "Mod entrypoint not found: $source"
}

$staging = Join-Path $project '.runtime/package'
if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
$modTarget = Join-Path $staging 'Mods/StationSectionBlueprints'
$scriptsTarget = Join-Path $modTarget 'Scripts'
New-Item -ItemType Directory -Path $scriptsTarget -Force | Out-Null

Get-ChildItem -LiteralPath $source -Recurse -File -Filter '*.lua' | Where-Object {
    $_.Name -notin @('ssb_dev_runner.lua', 'ssb_designer_probe.lua', 'ssb_probe.lua')
} | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($source, $_.FullName)
    $destination = Join-Path $scriptsTarget $relative
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination
}

Copy-Item -LiteralPath (Join-Path $project 'INSTALL.md') -Destination (Join-Path $staging 'INSTALL.md')
$toolsTarget = Join-Path $staging 'tools'
New-Item -ItemType Directory -Path $toolsTarget -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $project 'scripts/mod-manager.ps1') -Destination $toolsTarget

foreach ($license in Get-ChildItem -LiteralPath $project -File | Where-Object { $_.Name -match '^LICENSE(\..*)?$' }) {
    Copy-Item -LiteralPath $license.FullName -Destination $staging
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $output -Force | Out-Null
$archive = Join-Path $output "StationSectionBlueprints-$Version.zip"
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $archive -Force
Write-Output $archive
