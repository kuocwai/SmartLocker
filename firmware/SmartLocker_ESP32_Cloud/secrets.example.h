#pragma once
// Copy this file to secrets.h (never commit secrets.h).
// ============================================================
// BẢN CLOUD: Cấu hình kết nối tới server Railway (HTTPS)
// ============================================================
#define SMARTLOCKER_WIFI_SSID     "YOUR_WIFI_NAME"
#define SMARTLOCKER_WIFI_PASSWORD  "YOUR_WIFI_PASSWORD"

// URL Railway có dạng: https://your-project-production.up.railway.app
// KHÔNG có dấu / ở cuối, KHÔNG có port
#define SMARTLOCKER_SERVER_URL    "https://smartlocker-backend-production.up.railway.app"

// Device key: phải khớp với biến SMARTLOCKER_DEVICE_KEY trên Railway
#define SMARTLOCKER_DEVICE_API_KEY "REPLACE_WITH_DEVICE_KEY_AT_LEAST_16_CHARS"
