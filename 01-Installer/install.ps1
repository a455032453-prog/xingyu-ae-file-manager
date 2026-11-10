[CmdletBinding()]
param([switch]$VerifyOnly, [string]$SandboxRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$package = $PSScriptRoot

function Assert-NoLinks([string]$Path) {
    $itemPath = [IO.Path]::GetFullPath($Path)
    while ($itemPath) {
        if (Test-Path -LiteralPath $itemPath) {
            if ((Get-Item -LiteralPath $itemPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Linked paths are not supported: $itemPath"
            }
        }
        $itemPath = Split-Path -Parent $itemPath
    }
}
function Resolve-PackageFile([string]$Relative) {
    if ($Relative -notmatch '^[A-Za-z0-9_./-]+$' -or $Relative -match '(^|/)\.\.?(/|$)' -or $Relative.StartsWith('/')) {
        throw 'Invalid manifest path.'
    }
    $full = [IO.Path]::GetFullPath((Join-Path $package $Relative))
    if (-not $full.StartsWith($package.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped package.' }
    Assert-NoLinks $full
    return $full
}
function Node-Compatible([string]$Executable) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    try {
        $version = & $Executable --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.') { return $false }
        $major = [int]$Matches[1]
        $arch = & $Executable -p process.arch 2>$null
        return ($LASTEXITCODE -eq 0 -and $major -ge 18 -and $arch -eq 'x64')
    } catch { return $false }
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This package supports Windows x64 only.'
}
Assert-NoLinks $package
$manifest = Get-Content -LiteralPath (Join-Path $package 'package-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.format -ne 1 -or @($manifest.files).Count -lt 25) { throw 'Invalid package manifest.' }
$seen = @{}
foreach ($entry in $manifest.files) {
    $full = Resolve-PackageFile $entry.path
    if ($seen.ContainsKey($entry.path) -or $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid or duplicate manifest entry.' }
    $seen[$entry.path] = $true
    if (-not (Test-Path -LiteralPath $full -PathType Leaf) -or (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw "Missing or changed package file: $($entry.path). Extract a fresh copy."
    }
}
foreach ($required in @('plugin/index.html','plugin/CSXS/manifest.xml','plugin/ai-settings.js','plugin/ai-service/config-store.js','plugin/ai-service/protect-ai-keys.ps1','plugin/ai-expression.html','plugin/ai-image.html','runtime/node/node.exe','runtime/node/LICENSE','install.ps1')) {
    if (-not $seen.ContainsKey($required)) { throw "Missing manifest entry: $required" }
}
$actualFiles = @(Get-ChildItem -LiteralPath $package -Recurse -File -Force | Where-Object { $_.FullName -ne (Join-Path $package 'package-manifest.json') })
if ($actualFiles.Count -ne $seen.Count) { throw 'Package contains unexpected files. Extract a fresh copy.' }
Write-Host "Package verified: $($manifest.release), $($seen.Count) files."
if ($VerifyOnly) { return }

if ($SandboxRoot) {
    $sandbox = [IO.Path]::GetFullPath($SandboxRoot).TrimEnd('\')
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if ((Split-Path -Parent $sandbox) -ne $tempRoot -or (Split-Path -Leaf $sandbox) -notmatch '^AEFileManager-install-test-[a-f0-9-]+$') {
        throw 'Sandbox must be a dedicated AEFileManager-install-test-GUID directory directly inside TEMP.'
    }
    $appDataRoot = Join-Path $sandbox 'Roaming'
} else {
    if (-not $env:APPDATA) { throw 'APPDATA is unavailable.' }
    $appDataRoot = [IO.Path]::GetFullPath($env:APPDATA)
    if (Get-Process -Name AfterFX -ErrorAction SilentlyContinue) {
        throw 'Save your projects and close After Effects, then rerun install.ps1. The installer never force-closes AE.'
    }
}
$target = Join-Path $appDataRoot 'Adobe\CEP\extensions\AEFileManagerAnime'
$nodeDir = Join-Path $appDataRoot 'AFMAnimeRuntime\node'
$nodeExe = Join-Path $nodeDir 'node.exe'
$backupParent = Join-Path $appDataRoot 'AEFileManagerAnime-Backups'
foreach ($p in @($target,$nodeDir,$backupParent)) { Assert-NoLinks $p }
if ($package.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase) -or $package -eq $target) { throw 'Extract the installer outside the installed extension directory.' }
foreach ($entry in $manifest.files) {
    if ($entry.path.StartsWith('plugin/')) { Assert-NoLinks (Join-Path $target $entry.path.Substring(7)) }
}
if (Test-Path -LiteralPath $target) {
    $links = @(Get-ChildItem -LiteralPath $target -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($links.Count) { throw 'Existing plugin contains linked paths. Resolve them before installing.' }
}
$replaceNode = -not (Node-Compatible $nodeExe)
$backup = Join-Path $backupParent ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$hasBackup = $false
if (Test-Path -LiteralPath $target) {
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'plugin') -Recurse
    foreach ($old in (Get-ChildItem -LiteralPath $target -Recurse -File -Force)) {
        $saved = Join-Path (Join-Path $backup 'plugin') $old.FullName.Substring($target.Length + 1)
        if ((Get-FileHash -LiteralPath $old.FullName).Hash -ne (Get-FileHash -LiteralPath $saved).Hash) { throw 'Backup verification failed. Installation stopped.' }
    }
    $hasBackup = $true
}
if ($replaceNode -and (Test-Path -LiteralPath $nodeDir)) {
    foreach ($name in @('node.exe','LICENSE')) {
        $oldRuntime = Join-Path $nodeDir $name
        Assert-NoLinks $oldRuntime
        if (Test-Path -LiteralPath $oldRuntime) {
            New-Item -ItemType Directory -Path (Join-Path $backup 'node') -Force | Out-Null
            $savedRuntime = Join-Path (Join-Path $backup 'node') $name
            Copy-Item -LiteralPath $oldRuntime -Destination $savedRuntime
            if ((Get-FileHash -LiteralPath $oldRuntime).Hash -ne (Get-FileHash -LiteralPath $savedRuntime).Hash) { throw 'Node backup verification failed.' }
            $hasBackup = $true
        }
    }
}
if ($hasBackup) { Write-Host "Backup: $backup" }

try {
    if ($replaceNode) {
        New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
        foreach ($name in @('node.exe','LICENSE')) {
            Copy-Item -LiteralPath (Join-Path $package "runtime/node/$name") -Destination (Join-Path $nodeDir $name) -Force
            if ((Get-FileHash -LiteralPath (Join-Path $nodeDir $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $package "runtime/node/$name")).Hash) { throw 'Node copy verification failed.' }
        }
    }
    if (-not (Node-Compatible $nodeExe)) { throw 'Node runtime check failed.' }
    foreach ($obsolete in @('material-library.html','material-library.js','material-library.css','script-manager.html','script-manager.js','script-manager.css','ai-tools.html','ai-tools.js','ai-tools.css','quick-scripts.js','release-notes.js','release-notes.css')) {
        $obsoletePath = Join-Path $target $obsolete
        if (Test-Path -LiteralPath $obsoletePath -PathType Leaf) { Remove-Item -LiteralPath $obsoletePath -Force }
    }
    foreach ($entry in $manifest.files) {
        if (-not $entry.path.StartsWith('plugin/')) { continue }
        $relative = $entry.path.Substring(7)
        $destination = Join-Path $target $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $package $entry.path) -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $destination).Hash -ne $entry.sha256) { throw "Installed file mismatch: $relative" }
    }
    if (-not $SandboxRoot) {
        foreach ($version in 7..12) {
            $key = "HKCU:\Software\Adobe\CSXS.$version"
            New-Item -Path $key -Force | Out-Null
            New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
        }
    }
} catch {
    if ($hasBackup) { Write-Warning "Installation incomplete. Your previous files are backed up at: $backup. See INSTALL.md for rollback." }
    throw
}
Write-Host "Installed and verified: $target"
Write-Host 'Anime edition installed separately. Original plugin and credentials are unchanged.'
if ($SandboxRoot) { Write-Host 'SANDBOX: no registry changes, no real user configuration changes.' }
Write-Host 'Open AE > Window > Extensions > Star Isle File Manager. First opening without saved keys shows AI Settings.'
Write-Host 'If an old AI service is still running after an upgrade, close and reopen this panel.'
