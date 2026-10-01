@echo off
chcp 65001 >nul
echo ====================================================================
echo   FLOVA AI SUNUCUSUNU CANLIYA / TUM DUNYAYA ACMA ARACI (Cloudflare)
echo ====================================================================
echo.
echo Bu arac yerel bilgisayarinizda calisan server.py dosyasini
echo ucretsiz, guvenli ve hizli bir HTTPS adresine baglar.
echo.
echo [1] server.py sunucusunun acik oldugundan emin olun (Port: 3000).
echo [2] Cloudflare uzerinden ucretsiz tünel baslatiliyor...
echo.
set "PATH=C:\Program Files\nodejs;%PATH%"
npx --yes cloudflared tunnel --url http://localhost:3000
pause
