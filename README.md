# TRẠM GIỮ HÀNG HÓA FPT - SMART FOOD & PARCEL LOCKER (PROTOTYPE 2 NGĂN) 🔒🍲

Hệ thống Kiosk Tủ thông minh giữ đồ ăn & bưu kiện dành cho Sinh viên và Shipper. Dự án tích hợp hoàn chỉnh từ **Backend Server (Node.js/Express)**, **Giao diện Web 2D phẳng (Mobile-First Dashboard)** đến **Firmware vi điều khiển ESP32 DevKit V1**.

---

## 📋 MỤC LỤC
1. [Kiến trúc hệ thống](#-kiến-trúc-hệ-thống)
2. [Sơ đồ đấu nối phần cứng ESP32](#-sơ-đồ-đấu-nối-phần-cứng-esp32)
3. [Luồng nghiệp vụ khép kín (Dual-OTP & SLA)](#-luồng-nghiệp-vụ-khép-kín-dual-otp--sla)
4. [Hướng dẫn cài đặt & Khởi chạy Backend Server](#-hướng-dẫn-cài-đặt--khởi-chạy-backend-server)
5. [Hướng dẫn cấu hình & Nạp Firmware cho ESP32](#-hướng-dẫn-cấu-hình--nạp-firmware-cho-esp32)
6. [Hệ thống RESTful API Endpoints](#-hệ-thống-restful-api-endpoints)

---

## 🏛️ KIẾN TRÚC HỆ THỐNG

- **Web Frontend (2D Flat Design):**
  - Giao diện phẳng 2D hiện đại, không dùng Canvas 3D nặng nề, tối ưu mượt mà trên cả điện thoại di động (Mobile-First) và máy tính.
  - **Tab 1 - Cổng đặt tủ (Booking Portal):** Xem tình trạng 2 ngăn (Xanh: Trống, Vàng: Chờ giao, Đỏ: Đang giữ đồ), form đặt tủ thân thiện, hiển thị Dual-OTP rõ ràng kèm nút "Sao chép tin nhắn gửi Shipper".
  - **Tab 2 - Giám sát an toàn SLA (Live Dashboard):** Giám sát trạng thái chốt cửa, cảm biến đồ ăn, thời gian lưu trữ thực tế, thanh tiến trình đếm ngược SLA (0-45m An toàn, 45-120m Cảnh báo vàng, >120m Quá hạn đỏ) và bảng lịch sử đơn hàng.
  - **Tab 3 - Bảng điều khiển giả lập IoT (Simulator):** Cho phép test toàn bộ luồng nghiệp vụ không cần phần cứng ngay trên trình duyệt.
- **Backend Server (Node.js Express):**
  - Cơ sở dữ liệu SQLite (`better-sqlite3`) kèm cơ chế dự phòng tự động (Auto-Fallback) sang File JSON Store không cần cài đặt C++ Build Tools.
  - Server-Sent Events (SSE) đẩy dữ liệu thời gian thực tới Web UI ngay khi có sự kiện từ ESP32.
  - Background Service đếm ngược SLA lưu trữ thực phẩm mỗi 5 giây.
- **Firmware ESP32 (Arduino C++):**
  - Quản lý Wi-Fi tự động kết nối lại khi rớt mạng.
  - Điều khiển xung mở khóa Solenoid 0.8s an toàn cuộn hút.
  - Hiển thị LCD 20x4 I2C chống chớp giật (Flicker-free).
  - Máy trạng thái (FSM) lọc dội (debounce) cảm biến E18-D80NK và MC-38.
  - Hỗ trợ nhập mã OTP từ Serial Monitor (115200 baud) và bàn phím ma trận PCF8574 I2C.

---

## 🔌 SƠ ĐỒ ĐẤU NỐI PHẦN CỨNG ESP32

Vi điều khiển trung tâm: **ESP32 DevKit V1 (30 chân)**.

| Thiết bị ngoại vi | Chân ESP32 | Chế độ / Mức logic | Mô tả chức năng |
| :--- | :--- | :--- | :--- |
| **Relay Kênh 1** | **GPIO 18** | `OUTPUT` (Kích LOW) | Kích mở khóa Solenoid 12V Ngăn 1 (xung 0.8s) |
| **Relay Kênh 2** | **GPIO 19** | `OUTPUT` (Kích LOW) | Kích mở khóa Solenoid 12V Ngăn 2 (xung 0.8s) |
| **Cảm biến hồng ngoại E18-D80NK** | **GPIO 25** | `INPUT_PULLUP` | Phát hiện hàng (Mức `LOW` = Có hàng, `HIGH` = Trống) |
| **Công tắc từ MC-38** | **GPIO 26** | `INPUT_PULLUP` | Giám sát cửa (Mức `LOW` = Cửa đóng, `HIGH` = Cửa mở) |
| **Màn hình LCD 20x4 (I2C 0x27)** | **SDA: GPIO 21**<br>**SCL: GPIO 22** | Giao tiếp I2C | Hiển thị thông báo, hướng dẫn thao tác không dấu |
| **Bo đệm Keypad PCF8574 (0x20)** | **SDA: GPIO 21**<br>**SCL: GPIO 22** | Giao tiếp I2C | Quét bàn phím ma trận 4x4 nhập mã OTP |
| **Nguồn cấp Solenoid** | Nguồn ngoài 12V DC | Nối chung GND | Cấp qua tiếp điểm thường mở (NO) của Relay |

---

## 🔄 LUỒNG NGHIỆP VỤ KHÉP KÍN (DUAL-OTP & SLA)

```
[Sinh viên Đặt Tủ trên Web]
        │
        ├──> Sinh 2 mã: OTP Shipper & OTP Sinh viên
        │
[Shipper đến tủ nhập OTP Shipper]
        │
        ├──> ESP32 gửi POST /api/locker/verify-otp
        │
        ├──> Khớp mã -> ESP32 kích Relay 0.8s bung chốt mở cửa
        │    LCD: "XIN CHAO SHIPPER! HAY BO HANG VA DONG CUA"
        │
        ├──> Shipper đặt món (E18: LOW) & đóng cửa (MC-38: LOW)
        │
        ├──> ESP32 gửi POST /api/locker/update-status (ITEM_STORED)
        │
[Server kích hoạt SLA an toàn thực phẩm]
        │
        ├──> 0 ~ 45 phút: An toàn (Xanh) - Đồ ăn còn nóng
        ├──> 45 ~ 120 phút: Cảnh báo Cấp 1 (Vàng) - Đồ ăn sắp nguội
        └──> > 120 phút: Quá hạn (Đỏ) - Trạng thái ABANDONED, hủy OTP
        │
[Sinh viên đến tủ nhập OTP Sinh viên]
        │
        ├──> ESP32 gửi POST /api/locker/verify-otp
        │
        ├──> Khớp mã -> Kích Relay 0.8s bung chốt mở cửa
        │    LCD: "XIN CHAO BAN! HAY LAY DO VA DONG CUA"
        │
        ├──> Sinh viên lấy đồ (E18: HIGH) & đóng cửa (MC-38: LOW)
        │
        └──> ESP32 gửi POST /api/locker/update-status (ITEM_PICKED)
             Tủ trở về trạng thái AVAILABLE (Sẵn sàng phục vụ lượt tiếp)
```

---

## 💻 HƯỚNG DẪN CÀI ĐẶT & KHỞI CHẠY BACKEND SERVER

### Bước 1: Yêu cầu môi trường
- Đã cài đặt **Node.js** (Khuyên dùng v18, v20 hoặc v22 trở lên).
- Kiểm tra bằng lệnh: `node -v` và `npm -v`.

### Bước 2: Cài đặt gói thư viện
Mở Terminal / PowerShell tại thư mục dự án và chạy:
```bash
npm install
```

### Bước 3: Khởi động Server
```bash
npm start
```
Server sẽ in ra thông tin mạng nội bộ:
```
======================================================
🚀 SMART FOOD & PARCEL LOCKER - BACKEND SERVER RUNNING
======================================================
* Local Web:  http://localhost:3000
* LAN Network (Dành cho ESP32 & Mobile): http://192.168.1.14:3000
* Database:   SQLite / JSON File Store
======================================================
```
- Mở trình duyệt máy tính: Truy cập `http://localhost:3000`
- Mở trên điện thoại cùng mạng Wi-Fi: Truy cập `http://<IP_LAN_CỦA_MÁY>:3000` (ví dụ: `http://192.168.1.14:3000`)

---

## 🛠️ HƯỚNG DẪN CẤU HÌNH & NẠP FIRMWARE CHO ESP32

### Bước 1: Lấy địa chỉ IP mạng LAN của máy tính
Mở CMD hoặc PowerShell trên máy tính chạy:
```powershell
ipconfig
```
Tìm dòng **IPv4 Address** của card mạng Wi-Fi đang kết nối (ví dụ: `192.168.1.14`).

### Bước 2: Cấu hình mã nguồn ESP32
Mở file `firmware/SmartLocker_ESP32/SmartLocker_ESP32.ino` trên **Arduino IDE**:
1. Cập nhật thông tin mạng Wi-Fi:
   ```cpp
   const char* WIFI_SSID     = "TÊN_WIFI_CỦA_BẠN";
   const char* WIFI_PASSWORD = "MẬT_KHẨU_WIFI";
   ```
2. Cập nhật IP máy tính đã lấy ở Bước 1:
   ```cpp
   String SERVER_BASE_URL    = "http://192.168.1.14:3000"; // Thay đúng IP của bạn
   ```

### Bước 3: Cài đặt thư viện cần thiết trên Arduino IDE
Vào `Tools` -> `Manage Libraries...` (Ctrl + Shift + I), tìm và cài:
1. **ArduinoJson** (phiên bản 6.x hoặc 7.x bởi Benoit Blanchon)
2. **LiquidCrystal_I2C** (bởi Frank de Brabander)

### Bước 4: Nạp code vào ESP32
1. Chọn Board: `Tools` -> `Board` -> `ESP32 Arduino` -> `DOIT ESP32 DEVKIT V1` (hoặc `ESP32 Dev Module`).
2. Chọn cổng COM: `Tools` -> `Port` -> chọn cổng COM nối với ESP32.
3. Bấm **Upload** (Mũi tên sang phải).
4. Mở **Serial Monitor** với tốc độ **115200 baud**. Bạn có thể gõ trực tiếp 6 số OTP vào ô gửi lệnh để test mở tủ!

---

## 📡 HỆ THỐNG RESTFUL API ENDPOINTS

| Phương thức | Đường dẫn URL | Dữ liệu gửi (Body / Params) | Dữ liệu trả về (JSON Response) |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/lockers` | Không | Danh sách 2 ngăn tủ, trạng thái cảm biến và tiến độ SLA |
| `POST` | `/api/lockers/book` | `{"compartment_id": 1, "student_name": "...", "student_phone": "...", "notes": "..."}` | `{"success": true, "otp_shipper": "123456", "otp_student": "654321"}` |
| `POST` | `/api/locker/verify-otp` | `{"otp": "123456"}` | `{"status": "SUCCESS", "role": "SHIPPER", "compartment_id": 1}` hoặc `{"status": "INVALID"}` |
| `POST` | `/api/locker/update-status` | `{"compartment_id": 1, "event": "ITEM_STORED"}` | `{"success": true, "message": "..."}` |
| `GET` | `/api/orders/history` | `?limit=20` | Danh sách lịch sử các đơn hàng đã phục vụ |
| `POST` | `/api/lockers/reset` | Không | Đặt lại toàn bộ hệ thống về trạng thái sẵn sàng ban đầu |
| `GET` | `/api/events` | Server-Sent Events (SSE) | Luồng stream thời gian thực cho Web UI tự động cập nhật |

---
**Giữ đồ an toàn - Tiện lợi sinh viên - Nhanh chóng shipper.** 🚀
