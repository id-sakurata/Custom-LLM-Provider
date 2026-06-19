# Panduan Pengembangan Proyek: Custom LLM Provider

File ini berfungsi sebagai pedoman utama untuk pengembangan dan pemeliharaan proyek **Custom LLM Provider**. Semua kontributor harus mengikuti konvensi dan arsitektur yang dijelaskan di bawah ini.

## 1. Gambaran Umum
Proyek ini adalah ekstensi VS Code yang mendaftarkan *Language Model Chat Provider* kustom ke dalam ekosistem Copilot Chat. Ekstensi ini secara otomatis mengambil daftar model dari endpoint yang kompatibel dengan OpenAI dan menyediakannya untuk digunakan di VS Code.

## 2. Struktur Arsitektur
Kode sumber berada di direktori `src/` dengan pembagian tanggung jawab sebagai berikut:

- **`extension.ts`**: *Entry point* ekstensi. Menangani aktivasi, registrasi perintah (`refreshModels`, `showStatus`, `setupWizard`, `openDashboard`), dan mendengarkan perubahan konfigurasi.
- **`modelRegistry.ts`**: Komponen pusat yang mengelola daftar model. Bertanggung jawab atas registrasi ke `vscode.lm`, sinkronisasi dengan endpoint, dan pengaturan *auto-refresh*.
- **`chatHandler.ts`**: Menangani logika komunikasi dengan Chat API. Mengonversi pesan VS Code ke format OpenAI, menangani streaming respon, *tool calling*, dan *reasoning/thinking tokens*.
- **`config.ts`**: *Wrapper* untuk konfigurasi VS Code (`package.json`). Menyediakan akses tipe-aman ke pengaturan pengguna.
- **`modelFetcher.ts`**: Modul utilitas untuk mengambil data dari endpoint `/v1/models` menggunakan modul `http`/`https` bawaan Node.js.
- **`toolAdapter.ts`**: Adapter untuk menerjemahkan format tool/function calling ke format API (openai-tools/openai-functions) dan mendeteksi tool call dalam teks stream.
- **`dashboardProvider.ts`**: Webview provider untuk memvisualisasikan dashboard status ekstensi dan model terdaftar.
- **`statusBar.ts`**: Mengelola status bar VS Code untuk mengindikasikan status operasional ekstensi.
- **`setupWizard.ts`**: Menyediakan wizard interaktif langkah-demi-langkah untuk setup awal extension (endpoint dan API Key).
- **`types.ts`**: Definisi antarmuka (interfaces) dan konstanta global.

## 3. Standar Pengkodean

### Konvensi TypeScript
- Gunakan tipe data yang eksplisit untuk parameter fungsi dan *return values*.
- Hindari penggunaan `any`. Jika tipe data tidak pasti, gunakan `unknown` atau definisikan *interface* yang sesuai di `types.ts`.
- Gunakan `readonly` untuk properti atau parameter yang tidak boleh diubah.

### Pola Asinkron & Streaming
- Gunakan `AsyncIterable` (melalui `async *yield`) untuk menangani respon streaming di `chatHandler.ts`.
- Selalu periksa `CancellationToken` (terutama dalam loop streaming) untuk mendukung pembatalan permintaan oleh pengguna.
- Pastikan penggunaan `await` yang tepat untuk menghindari *race conditions* saat me-refresh model.
- **Performa**: Gunakan `http`/`https` Agent dengan `keepAlive: true` untuk meminimalkan latensi koneksi.

### Logging & Output
- Gunakan `vscode.OutputChannel` (bernama "Custom LLM Provider") untuk logging aktivitas sistem.
- Sertakan *timestamp* pada log untuk memudahkan debugging (gunakan fungsi `timestamp()` di `modelRegistry.ts`).

## 4. Panduan Pengembangan

### Menambah Kapabilitas Baru
Jika API tujuan mendukung fitur baru (misalnya: *image input* atau format *reasoning* baru):
1. Perbarui `ModelCapabilities` di `types.ts`.
2. Tambahkan properti yang relevan di `package.json` (bagian `configuration`).
3. Perbarui `ConfigManager` di `config.ts` untuk membaca properti tersebut.
4. Perbarui logika `resolveCapabilities` di `modelRegistry.ts` untuk mendukung metadata baru dari API.
5. Implementasikan logika pengiriman/penerimaan data baru di `chatHandler.ts`.
    - Untuk **Vision**: Gunakan `vscode.LanguageModelImagePart` dan konversi ke Base64.

### Sinkronisasi Kapabilitas Otomatis
Ekstensi secara otomatis mencoba mendeteksi kapabilitas model dari metadata API (`context_length`, `max_input_tokens`, `capabilities`). Urutan prioritas penggabungan kapabilitas adalah:
1. **Model Overrides**: Pengaturan manual pengguna per model ID (Prioritas Tertinggi).
2. **API Metadata**: Data yang dikirim langsung oleh endpoint `/v1/models`.
3. **Global Fallback**: Pengaturan umum di VS Code (Prioritas Terendah).

### Model Filtering
Pengguna dapat memfilter daftar model yang muncul menggunakan wildcard (`*`):
- **`includeModels`**: Jika diisi, hanya model yang cocok yang akan didaftarkan.
- **`excludeModels`**: Model yang cocok akan selalu diabaikan.

### Fitur Thinking / Reasoning
Mendukung model dengan kemampuan "thinking" (seperti DeepSeek-R1 atau OpenAI o1):
- Menampilkan proses berpikir model sebagai blok kutipan Markdown di chat.
- Mendukung berbagai format API: `reasoning_effort` (OpenAI), `thinking` (Anthropic), dan `include_reasoning` (DeepSeek).

### Penanganan Error
- Error jaringan atau parsing model harus dicatat ke `OutputChannel` dan ditampilkan melalui `vscode.window.showWarningMessage` jika menghambat fungsi utama.
- Di `chatHandler.ts`, pastikan error dalam stream ditangkap dan dipetakan ke `vscode.LanguageModelError` yang relevan (misal: `NoPermissions` untuk 401/403).

## 5. Sinkronisasi Konfigurasi
Setiap kali menambahkan properti baru di `package.json`:
- Pastikan ada nilai `default` yang masuk akal.
- Tambahkan properti tersebut ke dalam pemeriksaan di `extension.ts` pada event `onDidChangeConfiguration` agar model dapat diregistrasi ulang secara otomatis.

## 6. Catatan Penting
- **Token Counting**: Menggunakan library `js-tiktoken` dengan encoding `cl100k_base` untuk akurasi tinggi.
- **Dependencies**: Usahakan menjaga ketergantungan minimal. Gunakan modul bawaan Node.js (`http`, `https`, `url`) jika memungkinkan.
