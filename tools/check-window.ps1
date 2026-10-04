Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static void Down() { mouse_event(0x0002,0,0,0,IntPtr.Zero); }
  public static void Up() { mouse_event(0x0004,0,0,0,IntPtr.Zero); }
  public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(250); Down(); System.Threading.Thread.Sleep(80); Up(); }
  public static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
}
"@

# Screenshot and SetCursorPos disagree on a scaled display unless the process is
# DPI aware, and the click then lands next to the pet instead of on it.
[void][W]::SetProcessDPIAware()

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
# Point this at any Python with Pillow + numpy; the bundled DSH runtime is the
# convenient default on a machine that already runs the harness.
$py = if ($env:DSH_PYTHON) { $env:DSH_PYTHON } else {
  Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
}

function Foreground($label) {
  Write-Host "$label -> '$([W]::Title([W]::GetForegroundWindow()))'"
}

function Grab($path) {
  $bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($screen.X, $screen.Y, 0, 0, (New-Object System.Drawing.Size $screen.Width, $screen.Height))
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}

# Minimise the app itself: that is the user's situation (the app is out of the
# way while they watch something else), and it removes any ambiguity about which
# window is in front.
$dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $dsh) { Write-Host "DSH window not found"; exit 0 }
Write-Host "minimising DSH (hwnd=$($dsh.MainWindowHandle))"
[void][W]::ShowWindow($dsh.MainWindowHandle, 6)
Start-Sleep -Milliseconds 1500
[void][W]::ClipCursor([IntPtr]::Zero)
Foreground "with DSH out of the way"

[void][W]::ClipCursor([IntPtr]::Zero)
Grab "$dir\_h1.png"

# Search inside the pet's own window only. The whale's blue also shows up in
# ordinary applications, and a whole-screen scan would happily aim the click at
# whatever else is blue that day.
$petProc = Get-Process -Name electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $petProc) { Write-Host "pet window not found"; exit 0 }
$pr = New-Object W+RECT
[void][W]::GetWindowRect($petProc.MainWindowHandle, [ref]$pr)
Write-Host "pet window ($($pr.L),$($pr.T))-($($pr.R),$($pr.B))"

$box = (& $py "$dir\find-pet.py" $pr.L $pr.T $pr.R $pr.B) -join ' '
$first = ($box -split ' ')[0]
if ($first -ne 'BOX') { Write-Host "pet sprite not found inside its window: $box"; exit 0 }
$parts = $box -split ' '
$cx = [int](([int]$parts[1] + [int]$parts[3]) / 2)
$cy = [int](([int]$parts[2] + [int]$parts[4]) / 2)
Write-Host "clicking the pet at $cx,$cy"

[void][W]::ClipCursor([IntPtr]::Zero)
[W]::Click($cx, $cy)

Start-Sleep -Milliseconds 3500
Foreground "after clicking the pet"

try { $other | Stop-Process -Force -ErrorAction SilentlyContinue } catch {}
