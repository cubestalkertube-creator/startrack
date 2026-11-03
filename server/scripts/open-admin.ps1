param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$server = 'root@185.218.0.111'
$key = Join-Path $env:USERPROFILE '.ssh\startrack_ed25519'
if (!(Test-Path -LiteralPath $key)) { throw 'Не найден SSH-ключ Startrack.' }

# VPN может перехватить маршрут: привязываемся к адресу физического сетевого адаптера.
$route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
  Where-Object { $_.NextHop -ne '0.0.0.0' } | Sort-Object RouteMetric, InterfaceMetric |
  Where-Object { (Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).HardwareInterface } |
  Select-Object -First 1
if (!$route) { throw 'Не найден работающий физический сетевой интерфейс.' }
$source = (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 |
  Where-Object { $_.AddressState -eq 'Preferred' } | Select-Object -First 1).IPAddress
if (!$source) { throw 'У сетевого интерфейса нет IPv4-адреса.' }
$sshArgs = @('-b', $source, '-i', $key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', $server)
$token = & ssh @sshArgs "sed -n 's/^ADMIN_TOKEN=//p' /opt/startrack/.env"
if ($LASTEXITCODE -ne 0 -or !$token -or $token.Length -lt 16) { throw 'Не удалось получить токен по SSH.' }
$token = $token.Trim().Trim('"').Trim("'")

$port = 18081
while ($port -le 18100) {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
  try { $listener.Start(); $listener.Stop(); break } catch { $port++ }
}
if ($port -gt 18100) { throw 'Нет свободного локального порта для туннеля.' }
$tunnelArgs = @('-b', $source, '-i', ('"' + $key + '"'), '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-N', '-L', "127.0.0.1:${port}:127.0.0.1:8081", $server)
$tunnel = Start-Process -FilePath 'ssh.exe' -ArgumentList $tunnelArgs -WindowStyle Hidden -PassThru
try {
  $url = "http://127.0.0.1:$port"
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    if ($tunnel.HasExited) { throw 'SSH-туннель завершился до подключения.' }
    try {
      $null = Invoke-RestMethod -Uri "$url/api/stats" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 2
      $ready = $true; break
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (!$ready) { throw 'Туннель открыт, но админка не приняла токен или не ответила.' }
  Set-Clipboard -Value $token
  if (!$NoOpen) { Start-Process $url }
  Write-Output "Рабочая админка: $url. Токен скопирован в буфер обмена; вставьте его в поле входа. SSH-туннель работает в фоне (PID $($tunnel.Id))."
} catch {
  if (!$tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
  throw
}
