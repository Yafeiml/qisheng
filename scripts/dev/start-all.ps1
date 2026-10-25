param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$devtoolsRoot = if ($env:DEVTOOLS_HOME) { $env:DEVTOOLS_HOME } else { 'D:\app\devtools' }
$nodePath = Join-Path $devtoolsRoot 'node/24.21.0/node.exe'
$envFile = Join-Path $projectRoot '.env'
$nestCli = Join-Path $projectRoot 'apps/api/node_modules/@nestjs/cli/bin/nest.js'
$nextCli = Join-Path $projectRoot 'apps/admin-web/node_modules/next/dist/bin/next'
$tsxCli = Join-Path $projectRoot 'node_modules/tsx/dist/cli.mjs'
$tscCli = Join-Path $projectRoot 'node_modules/typescript/bin/tsc'
$logDirectory = if ($env:XHS_DEV_LOG_DIR) { $env:XHS_DEV_LOG_DIR } else { Join-Path $projectRoot '.artifacts/dev' }
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()

foreach ($path in @($nodePath, $envFile, $nestCli, $nextCli, $tsxCli, $tscCli)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required development file is missing: $path" }
}
if ((& $nodePath --version) -ne 'v24.21.0') { throw "The project requires Node 24.21.0: $nodePath" }

$env:PATH = "$(Split-Path $nodePath);$env:PATH"
$env:NODE_ENV = 'development'
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:API_HOST = '127.0.0.1'
$env:API_PORT = '3100'
Set-Location -LiteralPath $projectRoot

$validateEnvironment = @'
try {
  const database = new URL(process.env.DATABASE_URL);
  const redis = new URL(process.env.REDIS_URL);
  const local = value => ["localhost", "127.0.0.1", "[::1]"].includes(value);
  if (!local(database.hostname) || !/^\/dev_/u.test(database.pathname))
    throw new Error("Development startup requires a local dev_ PostgreSQL database.");
  if (!local(redis.hostname) || redis.protocol !== "redis:")
    throw new Error("Development startup requires local Redis.");
  if (!process.env.REDIS_PREFIX) throw new Error("REDIS_PREFIX is required.");
  console.log("Local development environment validated.");
} catch (error) {
  const message = error instanceof Error && error.message.startsWith("Development startup")
    ? error.message : "Local development environment configuration is invalid.";
  console.error(message);
  process.exit(1);
}
'@
& $nodePath "--env-file=$envFile" -e $validateEnvironment
if ($LASTEXITCODE -ne 0) { throw 'Environment validation failed; no services were started.' }
if ($SelfTest) {
    Write-Host 'Windows development entrypoint self-check passed; no services were started.'
    exit 0
}

function Test-HttpReady([string]$Url) {
    try {
        return (Invoke-WebRequest -Uri $Url -NoProxy -TimeoutSec 2 -SkipHttpErrorCheck).StatusCode -eq 200
    } catch { return $false }
}

function Ensure-Container([string]$Name) {
    $running = & wsl.exe -d Ubuntu-26.04-LTS -u root -- docker inspect --format '{{.State.Running}}' $Name 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Required container does not exist in Ubuntu-26.04-LTS: $Name" }
    if ($running -ne 'true') {
        & wsl.exe -d Ubuntu-26.04-LTS -u root -- docker start $Name | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not start development container: $Name" }
    }
}

function Start-DevelopmentProcess([string]$Name, [string]$Directory, [string[]]$Arguments) {
    $argumentLine = ($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $process = Start-Process -FilePath $nodePath -ArgumentList $argumentLine -WorkingDirectory $Directory `
        -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory "$Name.log") `
        -RedirectStandardError (Join-Path $logDirectory "$Name.err.log")
    $ownedProcesses.Add($process)
    Write-Host "$Name started (PID $($process.Id))."
    return $process
}

function Wait-HttpReady([string]$Name, [string]$Url, [Diagnostics.Process]$Process) {
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        if ($Process.HasExited) { throw "$Name exited before becoming ready. See $logDirectory/$Name.err.log" }
        if (Test-HttpReady $Url) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "$Name did not become ready. See $logDirectory/$Name.log and $Name.err.log"
}

$postgresContainer = if ($env:XHS_DEV_POSTGRES_CONTAINER) { $env:XHS_DEV_POSTGRES_CONTAINER } else { 'dev-postgresql' }
$redisContainer = if ($env:XHS_DEV_REDIS_CONTAINER) { $env:XHS_DEV_REDIS_CONTAINER } else { 'dev-redis' }
Ensure-Container $postgresContainer
Ensure-Container $redisContainer
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

# Build local shared code without invoking package-manager installation or shell-only npm scripts.
foreach ($package in @('observability', 'database', 'network-security', 'ai-gateway', 'content-safety', 'object-storage', 'wechat-miniapp', 'sms', 'captcha-client')) {
    & $nodePath $tscCli -p (Join-Path $projectRoot "packages/$package/tsconfig.build.json")
    if ($LASTEXITCODE -ne 0) { throw "Development dependency build failed: $package" }
}

try {
    $apiUrl = 'http://127.0.0.1:3100/health/ready'
    if (Test-HttpReady $apiUrl) { Write-Host 'API is already ready.' } else {
        $api = Start-DevelopmentProcess 'api' (Join-Path $projectRoot 'apps/api') @("--env-file=$envFile", $nestCli, 'start', '--watch')
        Wait-HttpReady 'api' $apiUrl $api
    }
    $adminUrl = 'http://127.0.0.1:3101/console'
    if (Test-HttpReady $adminUrl) { Write-Host 'Admin web is already ready.' } else {
        $web = Start-DevelopmentProcess 'admin-web' (Join-Path $projectRoot 'apps/admin-web') @($nextCli, 'dev', '--hostname', '127.0.0.1', '--port', '3101')
        Wait-HttpReady 'admin-web' $adminUrl $web
    }
    $worker = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($projectRoot) -and $_.CommandLine -match 'lifecycle\.(ts|js)'
    } | Select-Object -First 1
    if ($worker) { Write-Host "Worker is already running (PID $($worker.ProcessId))." } else {
        $workerProcess = Start-DevelopmentProcess 'worker' (Join-Path $projectRoot 'apps/worker') @("--env-file=$envFile", $tsxCli, 'watch', (Join-Path $projectRoot 'apps/worker/src/lifecycle.ts'))
        Start-Sleep -Seconds 2
        if ($workerProcess.HasExited) { throw "Worker exited before becoming ready. See $logDirectory/worker.err.log" }
    }
    Write-Host 'All local development services are ready.'
    Write-Host 'Platform administration: http://localhost:3101/platform'
    Write-Host 'User / enterprise administration: http://localhost:3101/console'
    Write-Host 'API health: http://localhost:3100/health/ready'
    Write-Host "Logs: $logDirectory"
    if ($ownedProcesses.Count -gt 0) {
        Write-Host 'Keep this process running; Ctrl+C stops only the services started here.'
        while ($true) {
            foreach ($process in $ownedProcesses) {
                if ($process.HasExited) { throw "Development process $($process.Id) exited. See $logDirectory" }
            }
            Start-Sleep -Seconds 2
        }
    }
} finally {
    foreach ($process in $ownedProcesses) {
        if (-not $process.HasExited) { $process.Kill($true) }
        $process.Dispose()
    }
}
