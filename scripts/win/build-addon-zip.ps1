# Package the Blender addon on Windows.
#
# ⚑ WHY THIS EXISTS. `build/build_addon.sh` in the addon repo cannot run here:
# it needs `rsync` and `zip`, and Git for Windows ships neither, and it calls
# `python3`, which on Windows is the Microsoft Store alias stub. So the addon
# cannot be packaged on Windows with the tooling it ships with — recorded as a
# finding, not worked around silently.
#
# This reproduces build_addon.sh's staging EXACTLY — the same include list, the
# same excludes, the same compileall step — so the archive is the same artifact,
# not a Windows-flavoured approximation. Where it differs it says so.
#
#   powershell -File scripts/win/build-addon-zip.ps1 -AddonRoot C:\SCRUPLEWORK\scruple-blender

param(
    [Parameter(Mandatory = $true)][string]$AddonRoot,
    [string]$Python = "C:\Users\user\AppData\Local\Programs\Python\Python311\python.exe"
)

$ErrorActionPreference = "Stop"
# Both: ZipFile lives in .FileSystem, ZipArchive/ZipArchiveMode in the base one.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$version   = (Get-Content (Join-Path $AddonRoot "VERSION") -Raw).Trim()
$stageRoot = Join-Path $AddonRoot "build\artifacts"
$stageDir  = Join-Path $stageRoot "scruple_blender"   # must match manifest `id`
$outDir    = Join-Path $AddonRoot "dist"
$zipPath   = Join-Path $outDir "scruple-blender-$version.zip"

if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
New-Item -ItemType Directory -Force -Path $stageDir, $outDir | Out-Null

# build_addon.sh's include list, verbatim.
$files = @("__init__.py", "blender_manifest.toml", "README.md", "LICENSE", "VERSION")
$dirs  = @("adapter", "panels", "operators", "vendor")

foreach ($f in $files) {
    Copy-Item (Join-Path $AddonRoot $f) -Destination $stageDir
}

# build_addon.sh's rsync excludes, verbatim.
$excludeDirs  = @("__pycache__", "tests", "build", "dist", "docs", ".git", ".pytest_cache")
foreach ($d in $dirs) {
    $src = Join-Path $AddonRoot $d
    Copy-Item $src -Destination $stageDir -Recurse
    $dst = Join-Path $stageDir $d
    Get-ChildItem $dst -Recurse -Directory -Force |
        Where-Object { $excludeDirs -contains $_.Name } |
        ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
    Get-ChildItem $dst -Recurse -File -Force |
        Where-Object { $_.Extension -eq ".pyc" -or $_.Name -like "SESSION_REPORT_*.md" } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

# "Compile-check every .py so a syntax error trips the packager, not the user."
& $Python -m compileall -q $stageDir | Out-Null
if ($LASTEXITCODE -ne 0) { throw "compileall found errors; aborting" }

# Sweep the __pycache__ compileall just created back out.
Get-ChildItem $stageDir -Recurse -Directory -Force |
    Where-Object { $_.Name -eq "__pycache__" } |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

if (Test-Path $zipPath) { Remove-Item -Force $zipPath }

# ⚑ ENTRIES WRITTEN BY HAND, because both of the obvious ways are wrong here.
# Windows PowerShell 5.1's Compress-Archive and .NET Framework's
# ZipFile.CreateFromDirectory BOTH write entry names with BACKSLASH separators
# on Windows — measured: all 75 entries came out as `scruple_blender\adapter\...`.
# The ZIP spec (APPNOTE 4.4.17.1) requires '/', and Blender's extension
# installer reads such an archive as a pile of oddly-named flat files rather
# than as an addon, which presents as the addon's fault.
#
# So each entry is created with a name this script controls.
$fs = [System.IO.File]::Create($zipPath)
try {
    $archive = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem $stageRoot -Recurse -File -Force | Sort-Object FullName) {
            $rel = $file.FullName.Substring($stageRoot.Length).TrimStart('\', '/').Replace('\', '/')
            $entry = $archive.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
            $in = $file.OpenRead()
            try {
                $out = $entry.Open()
                try { $in.CopyTo($out) } finally { $out.Dispose() }
            } finally { $in.Dispose() }
        }
    } finally { $archive.Dispose() }
} finally { $fs.Dispose() }

$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $entries   = $zip.Entries
    $backslash = @($entries | Where-Object { $_.FullName -like "*\*" })
    $topLevel  = @($entries | ForEach-Object { ($_.FullName -split '/')[0] } | Sort-Object -Unique)
    $manifest  = @($entries | Where-Object { $_.FullName -eq "scruple_blender/blender_manifest.toml" })

    Write-Output "entries        : $($entries.Count)"
    Write-Output "top-level      : $($topLevel -join ', ')"
    Write-Output "backslash names: $($backslash.Count)"
    Write-Output "manifest at scruple_blender/blender_manifest.toml : $($manifest.Count -eq 1)"

    if ($backslash.Count -gt 0) { throw "ZIP contains backslash entry names; Blender will not read this" }
    if ($topLevel.Count -ne 1 -or $topLevel[0] -ne "scruple_blender") { throw "ZIP top level is '$($topLevel -join ',')', expected exactly 'scruple_blender'" }
    if ($manifest.Count -ne 1) { throw "blender_manifest.toml is not at the top of the addon folder" }
} finally {
    $zip.Dispose()
}

Write-Output "Built: $zipPath"
Write-Output "sha256: $((Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower())"
