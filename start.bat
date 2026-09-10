@echo off
setlocal EnableExtensions

REM ===========================================================================
REM  Synchronized Intellect Network -- start here.
REM
REM  Double-click this file, or run it from any shell:
REM
REM      start.bat
REM      start.bat --user-data-dir=C:\sin-throwaway
REM
REM  Every argument you pass is handed to the app unchanged, so Electron's own
REM  --user-data-dir keeps a throwaway profile away from your real one.
REM
REM  What it does, in order: use node on PATH when it is 22.5 or newer;
REM  otherwise download the verified Node 24.20.0 LTS zip into this product's
REM  private per-user runtime directory; find pnpm (or run the pinned pnpm
REM  through node's corepack); install dependencies if they are missing, build
REM  the three bundles, launch the app.
REM
REM  What it never does: install anything globally, change a system setting, or
REM  touch anything outside this directory, this product's private runtime
REM  directory under LOCALAPPDATA, and the package managers' own caches.
REM
REM  Every failure below says what was looked for, where it was looked for, and
REM  where to get it, and then waits for a key so that a double-clicked window
REM  does not vanish before it can be read. A tool that fails without saying why
REM  is worse than no tool.
REM ===========================================================================

title Synchronized Intellect Network

REM pushd, not cd /d: cmd cannot make a UNC path the current directory, and
REM `cd /d "\\server\share\repo"` FAILS QUIETLY -- it prints one line, sets
REM ERRORLEVEL, and leaves the shell sitting in C:\Windows, where every relative
REM path below would then resolve. pushd maps a temporary drive letter for the
REM life of this window instead, which is released when the window closes.
pushd "%~dp0"
if errorlevel 1 goto nodirectory

REM cmd searches the current directory before PATH unless this is set, so an
REM unrelated node.exe or pnpm.cmd sitting in this folder could otherwise be
REM picked up instead of the real one. This is a variable for THIS process and
REM the processes it starts; nothing on the machine is changed.
set "NoDefaultCurrentDirectoryInExePath=1"

set "PNPM_VERSION=11.20.0"
set "NODE_MINIMUM=22.5"
set "NODE_LTS_VERSION=24.20.0"
set "NODE_PACKAGE=node-v%NODE_LTS_VERSION%-win-x64"
set "NODE_ARCHIVE_NAME=%NODE_PACKAGE%.zip"
set "NODE_DOWNLOAD_ROOT=https://nodejs.org/dist/v%NODE_LTS_VERSION%"
set "NODE_ARCHIVE_URL=%NODE_DOWNLOAD_ROOT%/%NODE_ARCHIVE_NAME%"
set "NODE_SHASUMS_URL=%NODE_DOWNLOAD_ROOT%/SHASUMS256.txt"
set "NODE_CACHE_ROOT=%LOCALAPPDATA%\unified-agent-workbench\runtime\node"

echo.
echo   Synchronized Intellect Network
echo   ------------------------------------------------------------
echo.

REM ---- 1. node --------------------------------------------------------------
set "NODEEXE="
for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODEEXE=%%~$PATH:N"
if not defined NODEEXE goto needprivatenode

for %%N in ("%NODEEXE%") do set "NODEDIR=%%~dpN"
if "%NODEDIR:~-1%"=="\" set "NODEDIR=%NODEDIR:~0,-1%"
set "PATH=%NODEDIR%;%PATH%"

REM ---- 2. node is new enough ------------------------------------------------
REM node:sqlite -- the durable local ledger and the tests that read it -- was
REM added in node 22.5. Below that the app cannot open its own database, so
REM the launcher must use its private LTS runtime rather than merely warn.
REM Captured straight out of the pipe. An earlier draft went through a file in
REM %TEMP%, which turned an unwritable temp directory into "your node is broken"
REM -- a message that sends the reader off to reinstall a perfectly good node.
REM node is on the front of PATH and the current directory is out of the search
REM order, so the bare name here can only be the node found above.
set "NODEVER="
for /f "delims=" %%V in ('node -p "process.versions.node" 2^>nul') do set "NODEVER=%%V"
if not defined NODEVER goto nodenoversion

"%NODEEXE%" -e "const v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)"
if errorlevel 1 goto nodeonpathtooold

echo   node        %NODEVER%  (%NODEEXE%)
goto nodeready

:nodeonpathtooold
set "PATHNODEVER=%NODEVER%"
echo   node %PATHNODEVER% on PATH is too old; this project needs %NODE_MINIMUM% or newer.
echo   node:sqlite, used for the local conversation store, first shipped in 22.5.
echo   The installed node is left untouched; using private Node %NODE_LTS_VERSION% LTS instead.
goto prepareprivatenode

:needprivatenode
echo   node was not found on PATH; preparing private Node %NODE_LTS_VERSION% LTS.

:prepareprivatenode
call :ensureprivatenode
if errorlevel 1 goto nodeprovisionfailed
set "NODEEXE=%NODE_CACHE_ROOT%\bin\node.exe"
for %%N in ("%NODEEXE%") do set "NODEDIR=%%~dpN"
if "%NODEDIR:~-1%"=="\" set "NODEDIR=%NODEDIR:~0,-1%"
set "PATH=%NODEDIR%;%PATH%"
set "NODEVER="
for /f "delims=" %%V in ('node -p "process.versions.node" 2^>nul') do set "NODEVER=%%V"
if not defined NODEVER goto privatenodeinvalid
echo   node        %NODEVER%  (%NODEEXE%, %NODE_PRIVATE_SOURCE%)

:nodeready
REM ---- 3. pnpm --------------------------------------------------------------
set "PNPM_RUN="
set "PNPM_SOURCE="

set "PNPMONPATH="
for %%P in (pnpm.cmd) do if not "%%~$PATH:P"=="" set "PNPMONPATH=%%~$PATH:P"
if not defined PNPMONPATH for %%P in (pnpm.exe) do if not "%%~$PATH:P"=="" set "PNPMONPATH=%%~$PATH:P"
if not defined PNPMONPATH for %%P in (pnpm.bat) do if not "%%~$PATH:P"=="" set "PNPMONPATH=%%~$PATH:P"

if defined PNPMONPATH goto havepnpm

REM No pnpm. node ships corepack, which can run an exact pnpm version out of a
REM per-user cache. That is a download into %LOCALAPPDATA%, not an install: no
REM global package, no PATH entry, nothing left behind for other projects.
set "COREPACKCMD="
for %%C in (corepack.cmd) do if not "%%~$PATH:C"=="" set "COREPACKCMD=%%~$PATH:C"
if not defined COREPACKCMD if exist "%NODEDIR%\corepack.cmd" set "COREPACKCMD=%NODEDIR%\corepack.cmd"
if not defined COREPACKCMD goto nopnpm

REM Without this, the first corepack download stops on an interactive y/n
REM prompt -- which a double-clicked window turns into a silent hang.
set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"
REM Deliberately the bare `set VAR=value` form, not `set "VAR=value"`: the value
REM has to CARRY quotes around the path so that `call %PNPM_RUN% install` expands
REM into a quoted command plus its arguments. It is the one place in this file
REM that departs from the quoted-set convention, and it is why.
set PNPM_RUN="%COREPACKCMD%" pnpm@%PNPM_VERSION%
set "PNPM_SOURCE=corepack (%COREPACKCMD%), pnpm %PNPM_VERSION%, nothing installed globally"
goto pnpmready

:havepnpm
set PNPM_RUN="%PNPMONPATH%"
set "PNPM_SOURCE=%PNPMONPATH%"

:pnpmready
echo   pnpm        %PNPM_SOURCE%

REM ---- 4. dependencies ------------------------------------------------------
REM Two questions, not one. "Is anything installed" is the first run. "Is what
REM is installed still what the lockfile asks for" is every `git pull` after it,
REM and skipping that one hands the reader a runtime error from a stale
REM dependency instead of a message -- the single thing every other path in this
REM file refuses to do. pnpm writes node_modules\.modules.yaml at the end of an
REM install, so a lockfile newer than that marker means the tree moved on. A
REM node_modules laid down by npm has no marker at all, and reinstalls.
if not exist "node_modules\.bin\vite.CMD" goto installdeps
if not exist "node_modules\.bin\electron.CMD" goto installdeps
node -e "const{statSync}=require('node:fs');try{process.exit(statSync('pnpm-lock.yaml').mtimeMs>statSync('node_modules/.modules.yaml').mtimeMs?1:0)}catch{process.exit(1)}"
if errorlevel 1 goto installdeps
goto depsready

:installdeps
echo.
echo   installing dependencies from pnpm-lock.yaml...
call %PNPM_RUN% install --frozen-lockfile
if errorlevel 1 goto installfailed
if not exist "node_modules\.bin\vite.CMD" goto installincomplete
if not exist "node_modules\.bin\electron.CMD" goto installincomplete
echo   dependencies installed

:depsready

REM ---- 5. build -------------------------------------------------------------
REM Every launch rebuilds, which takes a few seconds. That is deliberate: it
REM means you can never be looking at a window built from stale code and
REM conclude that a change did not land.
REM
REM The three entry artifacts are deleted BEFORE the build and required to
REM exist after it. A build that exits zero and writes nothing must not be
REM allowed to hand you the previous launch's files.
echo.
echo   building...

if exist "dist\main\main.js" del /f /q "dist\main\main.js" >nul 2>&1
if exist "dist\main\main.js" goto stalemain
if exist "dist\preload\preload.cjs" del /f /q "dist\preload\preload.cjs" >nul 2>&1
if exist "dist\preload\preload.cjs" goto stalepreload
if exist "dist\renderer\index.html" del /f /q "dist\renderer\index.html" >nul 2>&1
if exist "dist\renderer\index.html" goto stalerenderer

call "node_modules\.bin\vite.CMD" build --config vite.main.config.ts
if errorlevel 1 goto buildfailedmain
call "node_modules\.bin\vite.CMD" build --config vite.preload.config.ts
if errorlevel 1 goto buildfailedpreload
call "node_modules\.bin\vite.CMD" build --config vite.renderer.config.ts
if errorlevel 1 goto buildfailedrenderer

if not exist "dist\main\main.js" goto missingmain
if not exist "dist\preload\preload.cjs" goto missingpreload
if not exist "dist\renderer\index.html" goto missingrenderer

echo   build ok

REM ---- 6. launch ------------------------------------------------------------
echo.
echo   starting the app
echo   -- keep this window open; closing it closes the app
echo.

call "node_modules\.bin\electron.CMD" . %*
set "APPEXIT=%ERRORLEVEL%"

echo.
echo   the app has exited (exit code %APPEXIT%).
echo.
REM A clean exit closes the window. A crash does not: an app that dies on
REM startup would otherwise be a window that flashes once, which tells the
REM reader nothing. Whatever the app printed above is still on screen.
if not "%APPEXIT%"=="0" pause
exit /b %APPEXIT%

REM ===========================================================================
REM  failures
REM ===========================================================================

:nodirectory
echo   [X] Could not make the repository folder the current directory.
echo.
echo       Folder:     %~dp0
echo       Reason:     Windows cmd cannot work directly inside a network
echo                   (UNC) path, and mapping a temporary drive for it
echo                   failed too.
echo       Try:        copy or clone the repository onto a local disk, or map
echo                   the share to a drive letter and run this file from there.
echo.
pause
exit /b 1

:nodenoversion
echo   [X] Found a node.exe, but it could not tell me its version.
echo.
echo       Found:      %NODEEXE%
echo       Ran:        node -p "process.versions.node"
echo       Got:        nothing
echo       Reason:     whatever is on your PATH under that name is not a
echo                   working node. A shim pointing at an uninstalled
echo                   version does this.
echo       Get it:     https://nodejs.org  -- version %NODE_MINIMUM% or newer.
echo.
pause
exit /b 1

:privatenodeinvalid
set "NODE_SETUP_FAILURE=The cached private node.exe stopped working after it was prepared."
goto nodeprovisionfailed

:nodeprovisionfailed
echo.
echo   [X] Could not prepare the private Node %NODE_LTS_VERSION% LTS runtime.
echo.
echo       Problem:    %NODE_SETUP_FAILURE%
echo       Looked for: a working node.exe version %NODE_MINIMUM% or newer
echo       On PATH:    every directory on PATH
echo       In cache:   %NODE_CACHE_ROOT%\bin
echo       Get it:     %NODE_ARCHIVE_URL%
echo       Verify at:  %NODE_SHASUMS_URL%
echo       Kept files: only inside the private cache above; nothing was
echo                   installed globally and no system setting was changed.
echo.
pause
exit /b 1

:nopnpm
echo   [X] Could not find pnpm, and could not find corepack to supply it.
echo.
echo       Looked for: pnpm.cmd, pnpm.exe, pnpm.bat on your PATH
echo                   corepack.cmd on your PATH
echo                   corepack.cmd in %NODEDIR%
echo       Get it:     https://pnpm.io/installation
echo.
echo       corepack ships with node and would have run pnpm %PNPM_VERSION% for
echo       you without installing anything. Some node builds omit it; if yours
echo       did, installing pnpm yourself is the way forward.
echo.
pause
exit /b 1

:installfailed
echo.
echo   [X] Installing dependencies failed.
echo.
echo       Command:    pnpm install --frozen-lockfile
echo       pnpm:       %PNPM_SOURCE%
echo       Where:      %CD%
echo       Reason:     the output above says which package or which network
echo                   call failed. --frozen-lockfile also fails when
echo                   package.json and pnpm-lock.yaml disagree, which means
echo                   the checkout is incomplete rather than the network.
echo.
pause
exit /b 1

:installincomplete
echo.
echo   [X] The install reported success but node_modules is incomplete.
echo.
echo       Expected:   node_modules\.bin\vite.CMD
echo                   node_modules\.bin\electron.CMD
echo       Where:      %CD%
echo       Try:        delete node_modules and run this file again.
echo.
pause
exit /b 1

:stalemain
set "BUILDFAILURE=could not delete the previous build output dist\main\main.js"
goto buildstopped
:stalepreload
set "BUILDFAILURE=could not delete the previous build output dist\preload\preload.cjs"
goto buildstopped
:stalerenderer
set "BUILDFAILURE=could not delete the previous build output dist\renderer\index.html"
goto buildstopped

:buildfailedmain
set "BUILDFAILURE=the main bundle failed to build (vite.main.config.ts)"
goto buildstopped
:buildfailedpreload
set "BUILDFAILURE=the preload bundle failed to build (vite.preload.config.ts)"
goto buildstopped
:buildfailedrenderer
set "BUILDFAILURE=the renderer bundle failed to build (vite.renderer.config.ts)"
goto buildstopped

:missingmain
set "BUILDFAILURE=the main build exited 0 but wrote no dist\main\main.js"
goto buildstopped
:missingpreload
set "BUILDFAILURE=the preload build exited 0 but wrote no dist\preload\preload.cjs"
goto buildstopped
:missingrenderer
set "BUILDFAILURE=the renderer build exited 0 but wrote no dist\renderer\index.html"
goto buildstopped

:buildstopped
echo.
echo   [X] Build stopped: %BUILDFAILURE%
echo.
echo       Where:      %CD%
echo       Reason:     the build output above carries the compiler's own
echo                   message. The app is NOT started from a partial build,
echo                   because a window built from stale files is worse than
echo                   no window.
echo.
pause
exit /b 1

REM ===========================================================================
REM  private Node provisioning
REM ===========================================================================

:ensureprivatenode
set "NODE_PRIVATE_SOURCE="
set "NODE_SETUP_FAILURE="
call :validateprivatenode "%NODE_CACHE_ROOT%\bin\node.exe"
if not errorlevel 1 goto privatecached

if not defined LOCALAPPDATA (
  set "NODE_SETUP_FAILURE=Windows did not provide LOCALAPPDATA, so there is no private cache location."
  exit /b 2
)

set "POWERSHELLEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELLEXE%" (
  set "NODE_SETUP_FAILURE=Windows PowerShell was not found, so the Node zip cannot be verified and extracted."
  exit /b 2
)

md "%NODE_CACHE_ROOT%" >nul 2>&1
if not exist "%NODE_CACHE_ROOT%" (
  set "NODE_SETUP_FAILURE=The private cache directory could not be created."
  exit /b 2
)

:picknodestage
set "NODE_STAGE=%NODE_CACHE_ROOT%\stage-%RANDOM%-%RANDOM%"
if exist "%NODE_STAGE%" goto picknodestage
md "%NODE_STAGE%" >nul 2>&1
if not exist "%NODE_STAGE%" (
  set "NODE_SETUP_FAILURE=A temporary directory could not be created inside the private cache."
  exit /b 2
)

set "NODE_ARCHIVE=%NODE_STAGE%\%NODE_ARCHIVE_NAME%"
set "NODE_SHASUMS=%NODE_STAGE%\SHASUMS256.txt"

if defined SIN_NODE_ZIP_SOURCE goto copynodetestsource
echo   downloading %NODE_ARCHIVE_URL%
"%POWERSHELLEXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:NODE_ARCHIVE_URL -OutFile $env:NODE_ARCHIVE"
if errorlevel 1 goto nodearchivedownloadfailed
echo   downloading %NODE_SHASUMS_URL%
"%POWERSHELLEXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri $env:NODE_SHASUMS_URL -OutFile $env:NODE_SHASUMS"
if errorlevel 1 goto nodesharedownloadfailed
goto verifynodearchive

:copynodetestsource
REM Test seam: the suite supplies a local zip and the SHASUMS256.txt beside it.
REM Normal launches never set this variable and always use the official HTTPS URLs.
copy /y "%SIN_NODE_ZIP_SOURCE%" "%NODE_ARCHIVE%" >nul 2>&1
if errorlevel 1 goto nodearchivedownloadfailed
for %%Z in ("%SIN_NODE_ZIP_SOURCE%") do set "NODE_INJECTED_SHASUMS=%%~dpZSHASUMS256.txt"
copy /y "%NODE_INJECTED_SHASUMS%" "%NODE_SHASUMS%" >nul 2>&1
if errorlevel 1 goto nodesharedownloadfailed

:verifynodearchive
"%POWERSHELLEXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$entry=Get-Content -LiteralPath $env:NODE_SHASUMS | Where-Object { $_ -match ('^([0-9A-Fa-f]{64})\s+\*?' + [regex]::Escape($env:NODE_ARCHIVE_NAME) + '$') } | Select-Object -First 1; if ($null -eq $entry) { exit 41 }; $expected=($entry -split '\s+')[0]; $stream=[IO.File]::OpenRead($env:NODE_ARCHIVE); try { $sha=[Security.Cryptography.SHA256]::Create(); try { $actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') } finally { $sha.Dispose() } } finally { $stream.Dispose() }; if ($actual -ne $expected) { exit 42 }"
set "NODE_VERIFY_EXIT=%ERRORLEVEL%"
if "%NODE_VERIFY_EXIT%"=="41" goto nodesharemismatch
if "%NODE_VERIFY_EXIT%"=="42" goto nodebadhash
if not "%NODE_VERIFY_EXIT%"=="0" goto nodechecksumerror
echo   SHA-256 checksum verified against %NODE_SHASUMS_URL%

"%POWERSHELLEXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:NODE_ARCHIVE, $env:NODE_STAGE)"
if errorlevel 1 goto nodeextractfailed

call :validateprivatenode "%NODE_STAGE%\%NODE_PACKAGE%\node.exe"
if errorlevel 1 goto nodearchiveinvalid

if exist "%NODE_CACHE_ROOT%\bin" rd /s /q "%NODE_CACHE_ROOT%\bin" >nul 2>&1
if exist "%NODE_CACHE_ROOT%\bin" goto nodecachebusy
move /y "%NODE_STAGE%\%NODE_PACKAGE%" "%NODE_CACHE_ROOT%\bin" >nul 2>&1
if errorlevel 1 goto nodepublishfailed
call :validateprivatenode "%NODE_CACHE_ROOT%\bin\node.exe"
if errorlevel 1 goto nodepublishedinvalid

rd /s /q "%NODE_STAGE%" >nul 2>&1
set "NODE_PRIVATE_SOURCE=private Node %NODE_LTS_VERSION% LTS"
exit /b 0

:privatecached
set "NODE_PRIVATE_SOURCE=cached private Node"
echo   using cached private Node from %NODE_CACHE_ROOT%\bin
exit /b 0

:nodearchivedownloadfailed
set "NODE_SETUP_FAILURE=The Node zip could not be downloaded or copied. Check the network and try again."
goto nodepreparefailed

:nodesharedownloadfailed
set "NODE_SETUP_FAILURE=The official SHASUMS256.txt could not be downloaded or copied, so the zip was not trusted."
goto nodepreparefailed

:nodesharemismatch
set "NODE_SETUP_FAILURE=The official SHASUMS256.txt has no entry for %NODE_ARCHIVE_NAME%."
goto nodepreparefailed

:nodebadhash
set "NODE_SETUP_FAILURE=The downloaded Node zip SHA-256 checksum did not match the official SHASUMS256.txt; it was not executed."
goto nodepreparefailed

:nodechecksumerror
set "NODE_SETUP_FAILURE=Windows could not calculate or compare the Node zip SHA-256 checksum; it was not executed."
goto nodepreparefailed

:nodeextractfailed
set "NODE_SETUP_FAILURE=The verified Node zip could not be extracted into the private cache."
goto nodepreparefailed

:nodearchiveinvalid
set "NODE_SETUP_FAILURE=The verified archive did not contain a working node.exe version %NODE_MINIMUM% or newer."
goto nodepreparefailed

:nodecachebusy
set "NODE_SETUP_FAILURE=The old private cache could not be replaced; another process may be using it."
goto nodepreparefailed

:nodepublishfailed
call :validateprivatenode "%NODE_CACHE_ROOT%\bin\node.exe"
if not errorlevel 1 goto nodepublishwonrace
set "NODE_SETUP_FAILURE=The verified Node runtime could not be moved into the private cache."
goto nodepreparefailed

:nodepublishwonrace
rd /s /q "%NODE_STAGE%" >nul 2>&1
set "NODE_PRIVATE_SOURCE=cached private Node"
exit /b 0

:nodepublishedinvalid
if exist "%NODE_CACHE_ROOT%\bin" rd /s /q "%NODE_CACHE_ROOT%\bin" >nul 2>&1
set "NODE_SETUP_FAILURE=The private node.exe did not run after it was moved into the cache."
goto nodepreparefailed

:nodepreparefailed
if defined NODE_STAGE if exist "%NODE_STAGE%" rd /s /q "%NODE_STAGE%" >nul 2>&1
exit /b 2

:validateprivatenode
if not exist "%~1" exit /b 2
"%~1" -e "const v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)" >nul 2>&1
if errorlevel 1 exit /b 2
exit /b 0
