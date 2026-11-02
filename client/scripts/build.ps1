param([switch]$Release, [switch]$Package)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'gtk-env.ps1') -Release:$Release
$client=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location $client
try {
    $arguments=@('build','--locked')
    if($Release){$arguments+='--release'}
    & cargo @arguments
    if($LASTEXITCODE -ne 0){throw 'Сборка Rust завершилась с ошибкой'}
    $profile=if($Release){'release'}else{'debug'}
    $exe=Join-Path $client "target/$profile/startrack.exe"
    if($Package){
        $version=(& cargo metadata --no-deps --format-version 1 | ConvertFrom-Json).packages[0].version
        $bundle=Join-Path $client "dist/Startrack_${version}_native_windows_x64"
        New-Item -ItemType Directory -Force -Path $bundle | Out-Null
        Copy-Item -LiteralPath $exe -Destination (Join-Path $bundle 'startrack.exe') -Force
        Get-ChildItem -LiteralPath (Join-Path $sdk 'bin') -Filter '*.dll' | Copy-Item -Destination $bundle -Force
        $vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
        if(Test-Path $vswhere){
            $installation=& $vswhere -latest -products '*' -property installationPath
            $redist=Get-ChildItem -Path (Join-Path $installation 'VC/Redist/MSVC/*/x64/Microsoft.VC143.CRT') -Directory -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
            if($redist){Get-ChildItem -LiteralPath $redist.FullName -Filter '*.dll' | Copy-Item -Destination $bundle -Force}
        }
        foreach($directory in @('share','etc','lib/gtk-4.0','lib/gdk-pixbuf-2.0')){
            $source=Join-Path $sdk $directory
            if(Test-Path $source){
                $dest=Join-Path $bundle $directory
                New-Item -ItemType Directory -Force -Path $dest | Out-Null
                & robocopy $source $dest /E /NFL /NDL /NJH /NJS /NP | Out-Null
                if($LASTEXITCODE -ge 8){throw "Не удалось упаковать GTK: $directory"}
            }
        }
        Copy-Item -LiteralPath (Join-Path $client 'README.md') -Destination (Join-Path $bundle 'README.md') -Force
        Set-Content -LiteralPath (Join-Path $bundle '.native-bundle') -Value $version -Encoding ascii
        $archive="$bundle.zip"
        # ZipFile includes the .native-bundle marker required by the updater.
        if(Test-Path -LiteralPath $archive){Remove-Item -LiteralPath $archive -Force}
        [IO.Compression.ZipFile]::CreateFromDirectory($bundle,$archive)
        Write-Host "Готово: $archive"
    } else {Write-Host "Готово: $exe"}
    # robocopy returns 1 for a successful copy; callers should see build success.
    $global:LASTEXITCODE=0
} finally {Pop-Location}
