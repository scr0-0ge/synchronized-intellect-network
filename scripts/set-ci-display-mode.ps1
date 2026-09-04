# 把托管 Windows runner 的虚拟显示器调大，让 rendered-surface harness 钉死的
# 1440x1000 内容视口真的装得下。仅供 CI 使用；本地开发机不需要也不该运行它
# （-Probe 除外，Probe 只读不改）。
#
# 依据（2026-08-30 run 33332755780 的失败读数反推，逐像素吻合）：
#   - runner 虚拟屏默认 1024x768，任务栏占约 48px，工作区 1024x720；
#   - measure-electron.mjs 按内容尺寸建带框隐藏窗口（外框 = 内容 + 16x39），
#     Windows 建窗时把外框钳进工作区，内容视口于是被压成
#     (1024-16) x (720-39) = 1008x681，viewport 断言与可见文字封印全红；
#   - 开发机 1920x1200（工作区 1920x1152）装得下 1456x1039 的外框，同一批
#     断言在开发机全绿。宽窗口面（OWNER_PROXY_VIEWPORT 3072x1680）不断言
#     视口，但需要内容宽过约 1668px 才能让 1100px 阅读上限咬合。
#
# 策略：先把任务栏设为自动隐藏（把高度还给工作区），再从显示器支持的模式里
# 挑一个工作区不小于 1456x1039 的：优先 1920x1200（与开发机同款，测试在该
# 尺寸下已知全绿），否则按与 1920x1200 面积差距从小到大依次试。全部失败时把
# 枚举到的模式全部打印出来再红掉，让下一个人不用重新猜环境。

param([switch]$Probe)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct UawDevMode
{
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion;
    public ushort dmDriverVersion;
    public ushort dmSize;
    public ushort dmDriverExtra;
    public uint dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public uint dmDisplayOrientation;
    public uint dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel;
    public uint dmPelsWidth;
    public uint dmPelsHeight;
    public uint dmDisplayFlags;
    public uint dmDisplayFrequency;
    public uint dmICMMethod;
    public uint dmICMIntent;
    public uint dmMediaType;
    public uint dmDitherType;
    public uint dmReserved1;
    public uint dmReserved2;
    public uint dmPanningWidth;
    public uint dmPanningHeight;
}

[StructLayout(LayoutKind.Sequential)]
public struct UawRect { public int Left; public int Top; public int Right; public int Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct UawAppBarData
{
    public uint cbSize;
    public IntPtr hWnd;
    public uint uCallbackMessage;
    public uint uEdge;
    public UawRect rc;
    public IntPtr lParam;
}

public static class UawDisplay
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplaySettingsW(string deviceName, int modeNum, ref UawDevMode devMode);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsW(ref UawDevMode devMode, uint flags);

    [DllImport("user32.dll")]
    static extern bool SystemParametersInfoW(uint action, uint param, ref UawRect rect, uint winIni);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);

    [DllImport("shell32.dll")]
    static extern UIntPtr SHAppBarMessage(uint message, ref UawAppBarData data);

    const int EnumCurrentSettings = -1;
    const uint FieldBitsPerPel = 0x00040000;
    const uint FieldPelsWidth = 0x00080000;
    const uint FieldPelsHeight = 0x00100000;
    const uint FieldDisplayFrequency = 0x00400000;

    static UawDevMode Blank()
    {
        var mode = new UawDevMode();
        mode.dmSize = (ushort)Marshal.SizeOf(typeof(UawDevMode));
        return mode;
    }

    public static string Current()
    {
        var mode = Blank();
        if (!EnumDisplaySettingsW(null, EnumCurrentSettings, ref mode)) return "unavailable";
        return string.Format("{0}x{1}x{2}@{3}", mode.dmPelsWidth, mode.dmPelsHeight, mode.dmBitsPerPel, mode.dmDisplayFrequency);
    }

    /* 每行 "宽 高 色深 刷新率"，枚举顺序即驱动顺序。 */
    public static string[] Modes()
    {
        var lines = new List<string>();
        for (int i = 0; ; i++)
        {
            var mode = Blank();
            if (!EnumDisplaySettingsW(null, i, ref mode)) break;
            lines.Add(string.Format("{0} {1} {2} {3}", mode.dmPelsWidth, mode.dmPelsHeight, mode.dmBitsPerPel, mode.dmDisplayFrequency));
        }
        return lines.ToArray();
    }

    public static int[] WorkArea()
    {
        var rect = new UawRect();
        if (!SystemParametersInfoW(0x0030, 0, ref rect, 0)) return new int[] { -1, -1 };
        return new int[] { rect.Right - rect.Left, rect.Bottom - rect.Top };
    }

    public static int[] Screen()
    {
        return new int[] { GetSystemMetrics(0), GetSystemMetrics(1) };
    }

    /* 返回 ChangeDisplaySettingsW 的原始返回值；0 = DISP_CHANGE_SUCCESSFUL。
       找不到 32 位色的目标模式时返回 -1000。同尺寸多刷新率取最高的。 */
    public static int Apply(uint width, uint height)
    {
        var best = Blank();
        bool found = false;
        for (int i = 0; ; i++)
        {
            var mode = Blank();
            if (!EnumDisplaySettingsW(null, i, ref mode)) break;
            if (mode.dmPelsWidth != width || mode.dmPelsHeight != height || mode.dmBitsPerPel != 32) continue;
            if (!found || mode.dmDisplayFrequency > best.dmDisplayFrequency) { best = mode; found = true; }
        }
        if (!found) return -1000;
        best.dmFields = FieldBitsPerPel | FieldPelsWidth | FieldPelsHeight | FieldDisplayFrequency;
        return ChangeDisplaySettingsW(ref best, 0);
    }

    /* ABM_SETSTATE + ABS_AUTOHIDE：把任务栏高度还给工作区，无需重启 explorer。 */
    public static void TaskbarAutoHide()
    {
        var data = new UawAppBarData();
        data.cbSize = (uint)Marshal.SizeOf(typeof(UawAppBarData));
        data.lParam = (IntPtr)1;
        SHAppBarMessage(0x0000000A, ref data);
    }
}
"@

function Format-Pair([int[]] $pair) { "{0}x{1}" -f $pair[0], $pair[1] }

# 钉死内容 1440x1000 + 带框窗口的 16x39 边框 = 外框 1456x1039，工作区必须不小于它。
$requiredWorkWidth = 1456
$requiredWorkHeight = 1039
# 阅读上限在 inspector 可见时要内容宽过约 1668px 才咬合；1668 + 16 边框。
$capEngageOuterWidth = 1684

Write-Host ("current mode : {0}" -f [UawDisplay]::Current())
Write-Host ("screen       : {0}" -f (Format-Pair ([UawDisplay]::Screen())))
Write-Host ("work area    : {0}" -f (Format-Pair ([UawDisplay]::WorkArea())))
Write-Host "supported modes (width height bits hz):"
[UawDisplay]::Modes() | ForEach-Object { Write-Host "  $_" }

if ($Probe) { exit 0 }

[UawDisplay]::TaskbarAutoHide()
Write-Host ("work area after taskbar auto-hide: {0}" -f (Format-Pair ([UawDisplay]::WorkArea())))

# 候选：32 位色、尺寸本身够放外框的模式，去重后 1920x1200 优先，
# 其余按与 1920x1200 的面积差距从小到大（越接近开发机越好）。
$devArea = 1920 * 1200
$candidates = [UawDisplay]::Modes() |
  ForEach-Object {
    $parts = $_ -split " "
    [pscustomobject]@{ Width = [int]$parts[0]; Height = [int]$parts[1]; Bits = [int]$parts[2] }
  } |
  Where-Object { $_.Bits -eq 32 -and $_.Width -ge $requiredWorkWidth -and $_.Height -ge $requiredWorkHeight } |
  Sort-Object -Property Width, Height -Unique |
  Sort-Object -Property @{ Expression = { if ($_.Width -eq 1920 -and $_.Height -eq 1200) { -1 } else { [Math]::Abs($_.Width * $_.Height - $devArea) } } }

if (-not $candidates) {
  Write-Host "::error::no display mode can hold a 1456x1039 outer frame; mode list above is complete"
  exit 1
}

foreach ($candidate in $candidates) {
  $target = "{0}x{1}" -f $candidate.Width, $candidate.Height
  $code = [UawDisplay]::Apply([uint32]$candidate.Width, [uint32]$candidate.Height)
  if ($code -ne 0) {
    Write-Host "mode $target rejected (ChangeDisplaySettings=$code), trying next"
    continue
  }
  # 工作区尺寸随任务栏重排有延迟，轮询最多 10 秒。
  for ($i = 0; $i -lt 20; $i++) {
    $work = [UawDisplay]::WorkArea()
    if ($work[0] -ge $requiredWorkWidth -and $work[1] -ge $requiredWorkHeight) {
      Write-Host ("mode {0} active; work area {1} holds the {2}x{3} outer frame" -f `
        [UawDisplay]::Current(), (Format-Pair $work), $requiredWorkWidth, $requiredWorkHeight)
      if ($work[0] -lt $capEngageOuterWidth) {
        Write-Host "::warning::work area narrower than $capEngageOuterWidth; the wide-window reading-cap surface may not engage"
      }
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host ("mode {0} applied but work area stayed {1}, trying next" -f $target, (Format-Pair ([UawDisplay]::WorkArea())))
}

Write-Host "::error::every candidate mode failed to yield a work area of at least ${requiredWorkWidth}x${requiredWorkHeight}"
exit 1
