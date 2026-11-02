param([switch]$Build, [switch]$Run, [switch]$Release)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sdk = if ($env:STARTRACK_GTK_DIR) { $env:STARTRACK_GTK_DIR } else { Join-Path $repo '.cache/gtk/sdk' }
if (!(Test-Path (Join-Path $sdk 'lib/pkgconfig/gtk4.pc'))) {
    throw 'GTK 4 SDK не найден. Выполните scripts/setup-gtk.ps1 или задайте STARTRACK_GTK_DIR.'
}
$env:PATH = (Join-Path $sdk 'bin') + ';' + $env:PATH
$env:PKG_CONFIG_PATH = Join-Path $sdk 'lib/pkgconfig'
$env:LIB = (Join-Path $sdk 'lib') + ';' + $env:LIB
$env:INCLUDE = (Join-Path $sdk 'include') + ';' + $env:INCLUDE
$env:XDG_DATA_DIRS = Join-Path $sdk 'share'
if ($Build -or $Run) {
    $cargoArgs = @($(if ($Run) { 'run' } else { 'build' }), '--manifest-path', (Join-Path $repo 'client/Cargo.toml'))
    if ($Release) { $cargoArgs += '--release' }
    Push-Location (Join-Path $repo 'client')
    try {
        & cargo @cargoArgs
        if ($LASTEXITCODE -ne 0) { throw "cargo завершился с кодом $LASTEXITCODE" }
    } finally { Pop-Location }
}
