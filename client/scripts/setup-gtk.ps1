$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$cache = Join-Path $repo '.cache/gtk'
$sdk = Join-Path $cache 'sdk'
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$version = '2026.10.0'
$zip = Join-Path $cache 'gtk.zip'
if (!(Test-Path $zip)) {
    & curl.exe -L --fail --show-error "https://github.com/wingtk/gvsbuild/releases/download/$version/GTK4_Gvsbuild_${version}_x64.zip" -o $zip
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось скачать GTK SDK' }
}
if (!(Test-Path (Join-Path $sdk 'lib/pkgconfig/gtk4.pc'))) { Expand-Archive -LiteralPath $zip -DestinationPath $sdk -Force }
# gvsbuild ships .pc files with its CI prefix; relocate them to this SDK.
$prefix = $sdk.Replace('\','/')
Get-ChildItem -LiteralPath (Join-Path $sdk 'lib/pkgconfig') -Filter '*.pc' | ForEach-Object {
    $content = [IO.File]::ReadAllText($_.FullName)
    $content = $content -replace '(?m)^prefix=.*$', "prefix=$prefix"
    [IO.File]::WriteAllText($_.FullName,$content)
}
Write-Host "GTK SDK готов: $sdk"
