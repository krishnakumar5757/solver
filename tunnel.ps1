# Start Cloudflare Tunnel for NeoSolver with clear URL display
$cloudflared = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
if (-not (Test-Path $cloudflared)) {
    $cloudflared = "cloudflared"
}

$logFile = Join-Path $PSScriptRoot "tunnel.log"
$urlFile = Join-Path $PSScriptRoot "tunnel_url.txt"
Remove-Item $logFile -ErrorAction SilentlyContinue
Remove-Item $urlFile -ErrorAction SilentlyContinue

Write-Host "Connecting to Cloudflare to create your public URL..." -ForegroundColor Cyan

# Launch cloudflared with logfile output to capture clean logs
$proc = Start-Process -FilePath $cloudflared -ArgumentList "tunnel", "--url", "http://127.0.0.1:8787", "--logfile", "`"$logFile`"" -PassThru -NoNewWindow

$foundUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $logFile) {
        $content = Get-Content $logFile -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-zA-Z0-9-]+\.trycloudflare\.com') {
            $foundUrl = $matches[0]
            break
        }
    }
}

if ($foundUrl) {
    Set-Content -Path $urlFile -Value $foundUrl
    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "  NEOSOLVER PUBLIC URL IS READY:" -ForegroundColor Green
    Write-Host "  $foundUrl" -ForegroundColor Yellow
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Test endpoint:  $foundUrl/healthz" -ForegroundColor White
    Write-Host "Challenge curl: curl -s $foundUrl/s/cyber -H 'X-Targets: App.jsx' -T tests.js | sh" -ForegroundColor Cyan
    Write-Host "Saved to:       tunnel_url.txt" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Press Ctrl+C to stop the tunnel." -ForegroundColor DarkGray
} else {
    Write-Host "Could not find tunnel URL yet. Check tunnel.log for details." -ForegroundColor Red
}

try {
    $proc.WaitForExit()
} finally {
    if (-not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
}
