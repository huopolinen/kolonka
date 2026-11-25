#!/bin/sh
# Capture the Kolonka window from the real screen (keeps the Mica backdrop), for README screenshots.
# usage: KOLONKA_DATA=... tools/capture.sh out.png
out="$1"
dir=$(cd "$(dirname "$0")/.." && pwd)
node "$dir/bin/kolonka.js" focus
node -e "setTimeout(()=>{},700)"
b=$(node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.env.KOLONKA_DATA+'/control.json'));fetch(c.url+'/api/window',{headers:{authorization:'Bearer '+c.token}}).then(r=>r.json()).then(j=>console.log([j.x,j.y,j.width,j.height].join(' ')))")
set -- $b
win_out=$(cygpath -w "$out")
powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Drawing; Add-Type 'using System.Runtime.InteropServices; public class D { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'; [D]::SetProcessDPIAware() | Out-Null; \$bmp=New-Object System.Drawing.Bitmap $3, $4; \$g=[System.Drawing.Graphics]::FromImage(\$bmp); \$g.CopyFromScreen($1,$2,0,0,\$bmp.Size); \$bmp.Save('$win_out'); 'saved $win_out'"
