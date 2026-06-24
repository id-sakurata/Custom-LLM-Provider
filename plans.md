# Rencana: Perbaikan Auto Retry untuk Empty Response

## Latar Belakang

Error "Sorry, no response was returned." muncul di VS Code Copilot Chat ketika:
1. API mengembalikan HTTP 200 OK (sukses)
2. Stream SSE selesai (`data: [DONE]`) tanpa mengirim konten apapun
3. Tidak ada error yang dilempar — stream hanya selesai tanpa yield

Retry saat ini hanya menangkap error (exception throw), bukan silent empty response.

---

## Analisis Lokasi Kode

| File | Baris | Masalah |
|------|-------|---------|
| `chatHandler.ts` | `streamCompletion()` | Generator selesai tanpa yield jika stream kosong |
| `chatHandler.ts` | `sendRequest()` | Retry loop tidak terpicu karena tidak ada error |
| `retryHandler.ts` | `isRetryableHttpError()` | Tidak handle kasus "no content yielded" |

---

## Solusi

### 1. `chatHandler.ts` — Deteksi Empty Response

Di `streamCompletion`, setelah loop utama selesai (`done = true`), cek apakah ada chunk yang mengandung content/tool_calls. Jika stream selesai tanpa yield data apapun, lempar error khusus:

```typescript
// Di akhir streamCompletion, sebelum method selesai:
if (chunks.length === 0 && accumulatedText === '' && toolCallAccumulator.size === 0) {
  throw new Error('Empty response: stream completed with no content');
}
```

Catatan: error ini hanya lempar jika **seluruh stream** selesai tanpa data. Jika sudah ada yield, tidak perlu error.

### 2. `retryHandler.ts` — Tambahkan `isEmptyResponseError()`

```typescript
export function isEmptyResponseError(err: Error): boolean {
  return err.message.includes('Empty response');
}
```

Update `isRetryableHttpError` atau buat helper baru yang juga mengecek empty response.

### 3. `chatHandler.ts` — Retry Loop untuk Empty Response

Di `sendRequest`, retry loop saat ini hanya menangkap error. Pastikan empty response juga masuk ke mekanisme retry yang sama.

Kode will look like:

```typescript
for (let attempt = 0; attempt <= maxRetries; attempt++) {
  try {
    let streamedAny = false;
    for await (const part of this.streamCompletion(body, token)) {
      streamedAny = true;
      hasYieldedContent = true;
      yield part;
    }
    // Jika loop selesai tanpa yield apapun → empty response
    if (!streamedAny) {
      throw new Error('Empty response: stream completed with no content');
    }
    break;
  } catch (err) {
    // retry logic ...
  }
}
```

Ini lebih baik daripada melempar error di `streamCompletion` karena kita bisa bedakan: stream selesai normal (dengan yield) vs stream kosong.

### 4. `retryHandler.ts` — Update `isRetryableHttpError`

```typescript
export function isRetryableHttpError(err: Error, retryOnStatus: number[]): boolean {
  const msg = err.message;
  // ... existing checks ...
  if (msg.includes('Empty response')) {
    return true;
  }
  return false;
}
```

### 5. Opsional — Konfigurasi Baru

Tambah properti (jika perlu dibedakan dari retry biasa):

```jsonc
"customLlmProvider.retryOnEmptyResponse": {
  "type": "boolean",
  "default": true,
  "description": "Retry when the API returns an empty response (no content)."
}
```

Atau bisa reuse `maxRetries` yang sudah ada (lebih sederhana).

---

## Task List

- [x] `chatHandler.ts` — deteksi empty response dan lempar error setelah `for await` selesai tanpa yield
- [x] `retryHandler.ts` — update `isRetryableHttpError` untuk handle "Empty response"
- [x] Validasi kompilasi (tsc + esbuild lulus)
