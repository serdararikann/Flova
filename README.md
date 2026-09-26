# 🎛️ Flova Audio Studio Pro

Modern, web tabanlı çok kanallı ses düzenleme, birleştirme ve yapay zeka destekli enstrüman/vokal ayrıştırma stüdyosu.

---

## ✨ Özellikler

### 1. ✂️ Kesici & Düzenleyici (Waveform Editor)
- Etkileşimli, piksel hassasiyetinde dalga formu (waveform) görselleştirmesi ve serbest seçim alanı.
- Hassas kırpma (Trim), seçili alanı kesip silme (Cut/Delete), sessize alma (Silence).
- Yumuşak geçişler: Milisaniyelik Fade In & Fade Out kontrolleri ve tersine çevirme (Reverse).
- Anlık çok adımlı Geri Al / Yinele (Undo/Redo) desteği.

### 2. 🔗 Parça Birleştirici (Audio Merger)
- Sınırsız sayıda parçayı sıralı birleştirme.
- Her parçaya özel aralık seçimi (Trim Start/End), ses seviyesi (Volume) ve bağımsız Fade In / Fade Out zarfları.
- Parçalar arası akıllı yumuşak geçiş (Crossfade).
- Doğrudan WAV/MP3 dışa aktarma veya düzenleyiciye tek tıkla aktarma.

### 3. 🎙️ Vokal & Enstrümantal Ayrıştırıcı (2-Stem Splitter)
- **🤖 Demucs v4 AI Modeli:** İnsan sesi ile arka plan müziğini stüdyo kalitesinde ayrıştırır.
- **⚡ Hızlı Spektral DSP:** Tarayıcı içi anlık önizleme, VAD (Voice Activity Detection) gürültü kapısı ve sibilans koruması.
- Canlı 2-Kanal Mikser: Solo, Mute, Bağımsız Gain ve A/B kıyaslama.

### 4. 🎸 Çoklu Enstrüman & Stem Ayrıştırıcı (4-Stem & 6-Stem Pro)
- **6 Bağımsız Stem:**
  - 🎤 Vokal
  - 🥁 Davul & Perküsyon
  - 🎸 Bas
  - 🎸 Gitar
  - 🎹 Piyano
  - 🎻 Sentetik & Diğer Enstrümanlar
- **Senkronize 6-Kanal Stüdyo Mikseri:** Bağımsız Volume fader'ları, Stereo Pan (-1.0 ile +1.0) ve Solo / Mute anahtarları.
- **A/B Karşılaştırması:** Orijinal miks ile ayrıştırılmış stem miksini tek tıkla canlı kıyaslama.
- **Dışa Aktarma:** Tek tıkla tüm stem'leri `.zip` arşivi olarak indirme, her stem'i bağımsız WAV kaydetme veya mikser ayarlarınıza göre özel altyapı (Karaoke / Drumless vb.) render etme.

### 5. 🎛️ Canlı Spektrum & Master Efektler
- 60 fps gerçek zamanlı FFT frekans spektrumu.
- Master Volume, Tempo/Hız kontrolü (Speed / Pitch), Stereo Pan ve 8D Ses (Oto-Pan).
- 5-Bant Stüdyo EQ (60Hz, 250Hz, 1kHz, 4kHz, 12kHz) ve Flat/Bass/Vocal/Electro hazır ayarları.
- Stüdyo Reverb & Delay / Echo simülatörü.

---

## 🚀 Kurulum ve Çalıştırma

### Gereksinimler
- Python 3.10+
- Modern bir web tarayıcısı (Chrome, Edge, Firefox, Brave, Safari)

### 1. Depoyu Klonlayın
```bash
git clone https://github.com/serdararikann/Flova.git
cd Flova
```

### 2. Python Ortamını Hazırlayın
```bash
python -m venv .venv

# Windows:
.venv\Scripts\activate

# macOS / Linux:
source .venv/bin/activate

pip install -r requirements-server.txt
```

### 3. Sunucuyu Başlatın
```bash
python server.py
```
Sunucu başlatıldığında `http://localhost:3000` adresine giderek stüdyoyu hemen kullanmaya başlayabilirsiniz!

---

## 🛠️ Teknolojiler
- **Arayüz:** Vanilla JavaScript (ES Modules), Vanilla CSS (Custom Design System, Glassmorphism, Dark DAW Theme), HTML5 Canvas Web Audio API.
- **Yapay Zeka & DSP:** Demucs v4 Hybrid Transformer (`htdemucs` & `htdemucs_6s`), ONNX Runtime, SciPy, NumPy, SoundFile.
- **Ses Kodlayıcılar:** Web Audio API OfflineAudioContext, LAMEjs (MP3), JSZip.

---

## 📄 Lisans
MIT License
