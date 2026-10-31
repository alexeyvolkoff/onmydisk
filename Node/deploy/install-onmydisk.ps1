<#
.SYNOPSIS
Per-user installer for the On My Disk P2P node client (embedded.pro build).

.DESCRIPTION
Installs a static onmydisk.exe (plus omd-tunnel.exe) into %LOCALAPPDATA%\OnMyDisk
and registers autostart for the current user. No admin rights required.

With -WithAi it additionally installs the local OnMyChat assistant (Python
FastAPI + Ollama) listening on http://localhost:4000, which is the default
AiServer base URL of the node - no client settings change needed.

Run from PowerShell:

    irm https://forge.bineon.team/repo/Windows/install-onmydisk.ps1 | iex

or for install/uninstall options:

    curl.exe -fsSL https://forge.bineon.team/repo/Windows/install-onmydisk.ps1 -o install-onmydisk.ps1
    powershell -ExecutionPolicy Bypass -File .\install-onmydisk.ps1                # node only
    powershell -ExecutionPolicy Bypass -File .\install-onmydisk.ps1 -WithAi        # node + OnMyChat
    powershell -ExecutionPolicy Bypass -File .\install-onmydisk.ps1 -Uninstall     # uninstall
#>
param(
    [switch]$Uninstall,
    [switch]$WithAi,
    [switch]$AiCpu,   # install CPU-only torch (much smaller) instead of the default CUDA build
    [switch]$NoOllama,
    [string]$RepoBase = "https://forge.bineon.team/repo/Windows"
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$InstallDir = Join-Path $env:LOCALAPPDATA "OnMyDisk"
$BinDir     = Join-Path $InstallDir "bin"
$EtcDir     = Join-Path $InstallDir "etc"
$NodeExe    = Join-Path $BinDir "onmydisk.exe"
$TunnelExe  = Join-Path $BinDir "omd-tunnel.exe"
$Conf       = Join-Path $EtcDir "onmydisk.conf"
$RunKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RunValue   = "OnMyDiskNode"

function Stop-Node {
    if (Get-Process onmydisk -ErrorAction SilentlyContinue) {
        # ask the running instance to quit via its IPC interface (-q).
        # NB: PS 5.1 turns native stderr into ErrorRecords under `*>`, and with
        # $ErrorActionPreference=Stop that kills the script - use Start-Process
        # which swallows banners, and guard everything.
        try {
            Start-Process -FilePath $NodeExe -ArgumentList "-q" -WindowStyle Hidden -Wait -ErrorAction Stop | Out-Null
        } catch { }
        Start-Sleep -Seconds 2
        Get-Process onmydisk -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

if ($Uninstall) {
    Stop-Node
    # stop OnMyChat if installed
    Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*uvicorn api:app*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-ItemProperty -Path $RunKeyPath -Name $RunValue -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $RunKeyPath -Name "OnMyChatAI" -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:LOCALAPPDATA "OnMyChat") -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force
    }
    Write-Host "On My Disk node was uninstalled ($InstallDir removed)."
    exit 0
}

# --- install ---------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $BinDir, $EtcDir | Out-Null

$downloads = @(
    @{ Url = "$RepoBase/onmydisk-node-latest-x64.exe"; Out = $NodeExe }
    @{ Url = "$RepoBase/omd-tunnel-x64.exe";           Out = $TunnelExe }
    @{ Url = "$RepoBase/onmydisk.conf";                Out = $Conf }
)

foreach ($d in $downloads) {
    Write-Host "Downloading $($d.Url) ..."
    Invoke-WebRequest -Uri $d.Url -OutFile $d.Out -UseBasicParsing
}

# strip Mark-of-the-Web so the statically signed-free exe is not flagged by SmartScreen on first run
Unblock-File $NodeExe -ErrorAction SilentlyContinue
Unblock-File $TunnelExe -ErrorAction SilentlyContinue

Stop-Node

# autostart for the current user (HKCU Run) - the client re-checks this on every start
Set-ItemProperty -Path $RunKeyPath -Name $RunValue -Value ('"' + $NodeExe + '"')

# allow inbound HTTP on :8081 for the claim page; silent no-op without admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    netsh advfirewall firewall add rule name="On My Disk node" dir=in action=allow `
        program=$NodeExe enable=yes profile=any | Out-Null
}

Write-Host "Starting the node ..."
Start-Process -FilePath $NodeExe -WorkingDirectory $BinDir -WindowStyle Hidden

Start-Sleep -Seconds 2
Write-Host ""
Write-Host "On My Disk node installed at $InstallDir"
Write-Host "Open http://localhost:8081 in your browser and claim this device to your account."
Write-Host "TCP forwarding from outside: omd-tunnel.exe --listen <port> <linkID> <targetPort>"

# --- OnMyChat (local AI assistant) ------------------------------------------
function Install-Ai {
    $AiDir  = Join-Path $env:LOCALAPPDATA "OnMyChat"
    $TmpDir = Join-Path $env:TEMP "onmychat-install"
    $PyVersion = "3.12.10"
    $PyDir = Join-Path $InstallDir "python"
    $Py = Join-Path $PyDir "python.exe"
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

    function Download([string]$Url, [string]$Out) {
        if (Test-Path $Out) { Remove-Item $Out -Force }
        Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing
    }

    # Run a native tool with PS 5.1 safety: pip/python write warnings to stderr,
    # and stderr + $ErrorActionPreference=Stop is fatal. Start-Process isolates it
    # and tees output into %TEMP%\onmychat-install for later inspection.
    function Run-Step([string]$FilePath, [string]$Arguments) {
        $log = Join-Path $TmpDir ("step-" + [IO.Path]::GetFileNameWithoutExtension($FilePath) + ".log")
        $pr = Start-Process -FilePath $FilePath -ArgumentList $Arguments `
                -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop `
                -RedirectStandardOutput $log -RedirectStandardError ($log + ".err")
        return $pr.ExitCode
    }

    # 1. per-user portable Python (embeddable distribution, no admin needed)
    if (-not (Test-Path $Py)) {
        Write-Host "Installing portable Python $PyVersion ..."
        New-Item -ItemType Directory -Force -Path $PyDir | Out-Null
        Download "https://www.python.org/ftp/python/$PyVersion/python-$PyVersion-embed-amd64.zip" (Join-Path $TmpDir "python-embed.zip")
        Expand-Archive (Join-Path $TmpDir "python-embed.zip") -DestinationPath $PyDir -Force
        # enable site-packages in the embeddable distribution
        $pth = Get-ChildItem $PyDir -Filter "*._pth" | Select-Object -First 1
        if ($pth) {
            (Get-Content $pth.FullName) -replace "#import site","import site" | Set-Content $pth.FullName
        }
        Download "https://bootstrap.pypa.io/get-pip.py" (Join-Path $TmpDir "get-pip.py")
        Run-Step $Py ('"' + (Join-Path $TmpDir "get-pip.py") + '" --quiet') | Out-Null
        Unblock-File $Py -ErrorAction SilentlyContinue
    } else {
        Write-Host "Portable Python already present at $PyDir"
    }

    # 2. onmychat application
    New-Item -ItemType Directory -Force -Path $AiDir | Out-Null
    if (-not (Test-Path (Join-Path $AiDir "api.py"))) {
        Write-Host "Downloading OnMyChat app ..."
        Download "$RepoBase/onmychat-latest.zip" (Join-Path $TmpDir "onmychat.zip")
        Expand-Archive (Join-Path $TmpDir "onmychat.zip") -DestinationPath $AiDir -Force
        # user dirs
        foreach ($sub in "user_data","memory_index","history","avatars","data") {
        New-Item -ItemType Directory -Force -Path (Join-Path $AiDir $sub) | Out-Null
        }
        # config from example, windows paths
        $cfg = Get-Content (Join-Path $AiDir "config.example.ini") -Raw
        $cfg = $cfg -replace "APP_ROOT_DIR\s*=\s*/opt/onmychat", ("APP_ROOT_DIR = " + ($AiDir -replace "\\","/"))
        Set-Content (Join-Path $AiDir "config.ini") $cfg
    } else {
        Write-Host "OnMyChat already present at $AiDir"
    }

    # 3. python dependencies (this step is long - big wheels like torch/chromadb)
    Write-Host "Installing python dependencies (this may take a long time) ..."
    if ($AiCpu) {
        $rc = Run-Step $Py "-m pip install --quiet torch --index-url https://download.pytorch.org/whl/cpu"
        if ($rc -ne 0) { throw "pip install (cpu torch) failed with exit code $rc" }
    }
    $rc = Run-Step $Py ('-m pip install --quiet -r "' + (Join-Path $AiDir "requirements.txt") + '"')
    if ($rc -ne 0) { throw "pip install failed with exit code $rc - see %TEMP%\onmychat-install pip logs" }
    # crawler support (non-fatal if it fails)
    try { Run-Step $Py "-m playwright install chromium" | Out-Null } catch { }

    # 3b. pre-loaded knowledge base (chromadb) & embedding model cache
    $UnifiedIndexDir = Join-Path $AiDir "memory_index\unified_index"
    $ChromaDbFile = Join-Path $UnifiedIndexDir "chroma.sqlite3"
    if (-not (Test-Path $ChromaDbFile)) {
        Write-Host "Downloading pre-indexed OMD knowledge base ..."
        New-Item -ItemType Directory -Force -Path $UnifiedIndexDir | Out-Null
        $ChromaTar = Join-Path $TmpDir "chroma_omd.tar.gz"
        try {
            Download "https://forge.bineon.team/repo/OnMyChat/chroma_omd.tar.gz" $ChromaTar
            Run-Step "tar.exe" ('-xzf "' + $ChromaTar + '" -C "' + $UnifiedIndexDir + '"') | Out-Null
            if (Test-Path $ChromaTar) { Remove-Item $ChromaTar -Force }
        } catch {
            Write-Warning "Failed to download or unpack ChromaDB knowledge base: $_"
        }
    }

    $HfHubDir = Join-Path $env:USERPROFILE ".cache\huggingface\hub"
    $HfModelDir = Join-Path $HfHubDir "models--sentence-transformers--paraphrase-multilingual-MiniLM-L12-v2"
    if (-not (Test-Path $HfModelDir)) {
        Write-Host "Downloading pre-cached embedding model ..."
        New-Item -ItemType Directory -Force -Path $HfHubDir | Out-Null
        $ModelTar = Join-Path $TmpDir "sentence_model.tar.gz"
        try {
            Download "https://forge.bineon.team/repo/OnMyChat/sentence_model.tar.gz" $ModelTar
            Run-Step "tar.exe" ('-xzf "' + $ModelTar + '" -C "' + $HfHubDir + '"') | Out-Null
            if (Test-Path $ModelTar) { Remove-Item $ModelTar -Force }
        } catch {
            Write-Warning "Failed to download or unpack embedding model: $_"
        }
    }

    # 4. launcher (hidden window via wscript) + HKCU Run autostart
    $Starter = Join-Path $AiDir "start-onmychat.vbs"
    $vbs  = 'Set sh = CreateObject("Wscript.Shell")' + "`r`n"
    $vbs += 'sh.CurrentDirectory = "' + $AiDir + '"' + "`r`n"
    $vbs += 'sh.Run """' + $Py + '"" -m uvicorn api:app --host 127.0.0.1 --port 4000", 0, False' + "`r`n"
    Set-Content $Starter $vbs
    Set-ItemProperty -Path $RunKeyPath -Name "OnMyChatAI" -Value ('"' + $Starter + '"')

    # 5. Ollama for Windows (per-user install, it does not need elevation)
    if (-not $NoOllama) {
        $OllamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
        if (-not (Test-Path $OllamaExe)) {
            Write-Host "Installing Ollama ..."
            Download "https://ollama.com/download/OllamaSetup.exe" (Join-Path $TmpDir "OllamaSetup.exe")
            Start-Process -FilePath (Join-Path $TmpDir "OllamaSetup.exe") -ArgumentList "/VERYSILENT" -Wait
        } else {
            Write-Host "Ollama already present"
        }
    }

    Write-Host "Starting OnMyChat ..."
    & wscript.exe $Starter

    Write-Host ""
    Write-Host "OnMyChat installed at $AiDir (http://localhost:4000)"
    Write-Host "Ollama model to pull for local inference: ollama pull gemma4 (see config.ini DEFAULT_MODEL)"
}

if ($WithAi) { Install-Ai }
