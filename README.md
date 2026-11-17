# BudgEx Puzzle-Cam (Exhibition Hand-Tracking Game)

Game puzzle interaktif berbasis webcam & hand-tracking (MediaPipe Hands) untuk booth pameran **BudgEx**.

## Cara Pakai (paling gampang)

1. **Klik dua kali `Jalankan Game.bat`** di folder ini.
   - Muncul jendela hitam. **Jangan ditutup** selama game dipakai.
   - Browser otomatis terbuka di `http://localhost:8080`.
2. Kalau browser minta izin kamera, klik **Allow / Izinkan**.
3. **Klik sekali di layar** (atau tekan `R`), supaya suara aktif.
4. Tekan **F11** untuk layar penuh.
5. Selesai pameran: tutup browser, lalu tutup jendela hitam.

> Paling bagus dibuka di **Chrome** atau **Edge**. Kalau browser default kamu lain,
> copy alamat `http://localhost:8080` ke Chrome.

### Kalau ada masalah
- **"Python belum terpasang"**: pasang Python dari https://www.python.org/downloads/
  (centang **"Add python.exe to PATH"** waktu install), lalu klik dua kali `Jalankan Game.bat` lagi.
- **Tampilan aneh / masih versi lama**: tekan **Ctrl + Shift + R** di browser.
- **Kamera tidak jalan**: pastikan izin kamera di-*Allow* (ikon kamera di address bar),
  dan tidak ada aplikasi lain (Zoom, Meet, dll.) yang sedang memakai kamera.
- **Error "address already in use"**: game masih jalan di jendela hitam lain. Pakai yang itu saja,
  atau tutup semua jendela hitam lalu jalankan ulang.

> **Tidak butuh internet.** Pelacak tangan (MediaPipe) dan font sudah ada di folder `vendor/` dan `fonts/`,
> jadi game tetap jalan walaupun Wi-Fi pameran mati atau lemot.
> Yang dibutuhkan cuma Python di laptop (sekali pasang).

### Cara manual (tanpa .bat)
```bash
cd budgex-puzzle-cam
python serve.py
```
Lalu buka `http://localhost:8080` di Chrome/Edge.
`serve.py` mirip `python -m http.server`, bedanya browser dilarang menyimpan cache, jadi perubahan file langsung muncul saat refresh.
Game tidak bisa dibuka langsung dengan klik dua kali `index.html`, karena browser memblokir webcam di alamat `file://`.

## Pakai Kamera HP (kalau ruangan backlight / gelap)

Kamera HP biasanya jauh lebih bagus melawan cahaya dari belakang. Caranya: HP dijadikan **webcam**
untuk laptop, lalu di game tekan tombol **Ganti Kamera** (atau `C`) sampai kamera HP yang dipakai.
Pilihan kamera diingat, jadi setelah refresh tidak perlu pilih lagi.

**Android + Windows 11 (tanpa aplikasi tambahan):**
1. Di HP, pasang aplikasi **Link to Windows** dan login akun Microsoft yang sama dengan laptop.
2. Di laptop: **Settings → Bluetooth & devices → Mobile devices** → nyalakan
   *Allow this PC to access your mobile devices* → **Manage devices** → nyalakan **Use as a connected camera**.
3. Buka game, tekan **Ganti Kamera** sampai statusnya menunjukkan kamera HP (namanya mirip *Windows Virtual Camera*).

**iPhone, atau kalau cara di atas tidak muncul:** pasang **Iriun Webcam** atau **DroidCam**
(aplikasi di HP + program di laptop, sambungkan lewat Wi-Fi yang sama atau kabel USB). Setelah tersambung,
tekan **Ganti Kamera** di game.

Tips cahaya: taruh HP di atas/dekat layar menghadap pengunjung, dan hindari jendela/lampu terang
tepat di belakang pengunjung. Sambungan kabel USB lebih stabil daripada Wi-Fi pameran.

## Cara Main
- **Tekan tombol Mulai** di tengah layar: cubit tombolnya pakai tangan di depan kamera (tombolnya membesar
  kalau kursor tangan sudah di atasnya), atau klik / sentuh. Game tidak mulai sendiri walaupun ada tangan terlihat.
- Muncul hitung mundur **3-2-1-Mulai!**, lalu timer berjalan
  (bawaan `90 detik`; ganti lewat dropdown **Durasi** di bar atas, 30 detik sampai 5 menit, dan pilihannya diingat browser).
- **Cubit gaya OK 👌** potongan puzzle (jempol + telunjuk ketemu, **jari tengah, manis, kelingking tetap lurus**),
  lalu geser ke kotaknya di papan tengah. Begitu pas, potongan otomatis terkunci. Mouse / touchscreen juga bisa dipakai.
  Kalau 3 jari lain ikut mengepal, pelacak gampang salah mengira jari tengah/manis sebagai telunjuk.
- Lingkaran kursor mengikuti **ujung jempol**, jadi arahkan jempol ke potongan yang mau diambil.
- **10 detik terakhir**: layar berdenyut merah tiap detik, makin lama makin tebal.
- **Menang**: confetti, papan berkilau, musik fanfare, lalu kartu "Kamu Menang!". Tunjukkan ke penjaga booth untuk klaim stiker.
- **Pengunjung berikutnya**: klik **Main Lagi** atau tekan `R`.

## Shortcut
- **`C`**: Ganti kamera (misal ke kamera HP). Tombolnya hanya muncul kalau ada lebih dari 1 kamera.
- **`T`**: Ganti durasi ke pilihan berikutnya (30 detik → … → 5 menit → balik ke 30 detik).
- **`G`**: Ganti ukuran grid (`4×3` ↔ `4×4`).
- **`R`**: Acak ulang / reset game untuk pengunjung berikutnya.
- **`F11`**: Layar penuh (shortcut browser).

## Struktur Folder
- `Jalankan Game.bat` — Klik dua kali untuk menjalankan game
- `serve.py` — Server lokal (tanpa cache)
- `index.html` — Halaman utama aplikasi kiosk
- `css/style.css` — Tampilan, animasi hitung mundur, merah peringatan, kartu menang
- `js/app.js` — Logika game, timer (durasi bisa diganti), deteksi cubitan tangan, suara & confetti
- `assets/puzzle-mascot.jpg` — Gambar puzzle maskot BudgEx
- `assets/logo-budgex.png` — Logo BudgEx (pojok kiri atas & ikon tab)
- `vendor/mediapipe-hands/` — Pelacak tangan MediaPipe Hands v0.4.1675469240 (offline, lisensi Apache-2.0)
- `fonts/` — Font JetBrains Mono & Plus Jakarta Sans (offline, lisensi SIL OFL 1.1)

> Kalau folder game di-copy ke laptop lain, **copy satu folder utuh**, termasuk `vendor/` dan `fonts/`.

### Setelan yang bisa diubah (di `js/app.js`)
- Pilihan durasi di dropdown: daftar `<option>` di `#duration-select` (`index.html`). Bawaan: `DEFAULT_DURATION` di `js/app.js`.
- Kepekaan cubitan: `PINCH_ON` (makin besar = makin gampang ambil) dan `PINCH_OFF` (makin besar = makin susah lepas).
- Telunjuk salah baca saat potongan dipegang: `INDEX_JUMP` (seberapa jauh lompatan telunjuk dianggap salah baca)
  dan `INDEX_JUMP_CONFIRM_MS` (berapa lama posisi baru harus bertahan sebelum dipercaya).
- Mulai merah peringatan: `DANGER_FROM_SECONDS`.
- Tangan hilang-hilangan: `LOST_HAND_GRACE_MS` (berapa lama kursor bertahan saat tangan sesaat tidak terdeteksi),
  serta `minDetectionConfidence` / `minTrackingConfidence` di `hands.setOptions` (makin kecil = makin gampang terdeteksi,
  tapi bisa salah deteksi).
- Model pelacak tangan: `modelComplexity` di `hands.setOptions`. `1` = model **full** (bawaan, lebih akurat & jarang hilang),
  `0` = model **lite** (lebih ringan). Kalau laptop booth terasa patah-patah, ganti ke `0`.
