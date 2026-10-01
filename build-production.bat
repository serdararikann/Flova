@echo off
chcp 65001 >nul
echo ===================================================
echo   FLOVA AUDIO STUDIO - KOD KARARTMA ^& DERLEME
echo ===================================================
echo.
echo [1/3] Node.js ve ortam degiskenleri hazirlaniyor...
set "PATH=C:\Program Files\nodejs;%PATH%"

echo [2/3] Proje paketleniyor ve JavaScript kodlari karartiliyor...
call npm run build

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ===================================================
    echo   [BASARILI] Kod karartma ve derleme tamamlandi!
    echo   Uretilen dosyalar 'dist' klasorunde hazirdir.
    echo   Netlify, Vercel veya sunucunuza 'dist' klasorunu
    echo   yukleyebilirsiniz.
    echo ===================================================
) else (
    echo.
    echo [HATA] Derleme sirasinda bir sorun olustu.
)
pause
