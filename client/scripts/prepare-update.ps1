# Prepare signed native update assets locally. Does not publish or change a release.
param([string]$WindowsArchive, [string]$LinuxBinary, [string]$NotesFile)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'gtk-env.ps1')
$client=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$meta = & cargo metadata --manifest-path (Join-Path $client 'Cargo.toml') --no-deps --format-version 1
if($LASTEXITCODE -ne 0){throw 'Не удалось прочитать версию'}
$version=($meta | ConvertFrom-Json).packages[0].version
if(!$WindowsArchive -and !$LinuxBinary){$WindowsArchive=Join-Path $client "dist/Startrack_${version}_native_windows_x64.zip"}
$out=Join-Path $client 'dist/native-update'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$oldKey=$env:TAURI_SIGNING_PRIVATE_KEY
$oldPassword=$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
try {
    if(!$env:TAURI_SIGNING_PRIVATE_KEY){$env:TAURI_SIGNING_PRIVATE_KEY=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.tauri/startrack-updater.key'}
    # A raw key is not a filesystem path; avoid errors that could echo secret contents.
    if($env:TAURI_SIGNING_PRIVATE_KEY.Length -lt 260 -and !$env:TAURI_SIGNING_PRIVATE_KEY.Contains("`n") -and (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue)){
        $env:TAURI_SIGNING_PRIVATE_KEY=[IO.File]::ReadAllText($env:TAURI_SIGNING_PRIVATE_KEY)
    }
    if($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD){$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=''}
    $platforms=@{}
    foreach($entry in @(@('windows-x86_64',$WindowsArchive,"Startrack_${version}_native_windows_x64.zip"),@('linux-x86_64',$LinuxBinary,"Startrack_${version}_native_linux_x64"))){
        if(!$entry[1]){continue}
        $source=(Resolve-Path -LiteralPath $entry[1]).Path
        $dest=Join-Path $out $entry[2]
        Copy-Item -LiteralPath $source -Destination $dest -Force
        & cargo run --manifest-path (Join-Path $client 'Cargo.toml') --locked --features release-tools --bin startrack-sign-update -- $dest
        if($LASTEXITCODE -ne 0){throw 'Не удалось подписать обновление. Проверьте прежний ключ подписи и пароль в TAURI_SIGNING_PRIVATE_KEY_PASSWORD.'}
        $signature=[IO.File]::ReadAllText("$dest.sig").Trim()
        $platforms[$entry[0]]=@{url="https://github.com/cubestalkertube-creator/startrack/releases/download/v$version/$($entry[2])";signature=$signature}
    }
    $notes=if($NotesFile){[IO.File]::ReadAllText((Resolve-Path -LiteralPath $NotesFile).Path)}else{"Startrack $version"}
    $manifest=@{version=$version;notes=$notes;platforms=$platforms} | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText((Join-Path $out 'native-latest.json'),$manifest,[Text.UTF8Encoding]::new($false))
    Write-Host "Подписанные файлы подготовлены в $out. Публикация не выполнялась."
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY=$oldKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$oldPassword
}
