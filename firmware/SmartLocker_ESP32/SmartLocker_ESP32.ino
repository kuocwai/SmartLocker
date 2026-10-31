/**
 * ======================================================================================
 * DỰ ÁN: SMART FOOD & PARCEL LOCKER PROTOTYPE (2 NGĂN)
 * TRUNG TÂM ĐIỀU KHIỂN & FIRMWARE ESP32 DEVKIT V1
 * ======================================================================================
 * 
 * PHẦN CỨNG ĐÃ ĐẤU NỐI & KIỂM TRA THỰC TẾ:
 *  - ESP32 DevKit V1 (30 Chân)
 *  - Relay Kênh 1 (Khóa Solenoid Ngăn 1): GPIO 18 (Kích mức LOW, giữ xung 0.8s)
 *  - Relay Kênh 2 (Khóa Solenoid Ngăn 2): GPIO 19 (Kích mức LOW, giữ xung 0.8s)
 *  - Cảm biến hồng ngoại E18-D80NK (Phát hiện đồ ăn/hàng): GPIO 25 (INPUT_PULLUP, LOW = Có hàng)
 *  - Công tắc từ MC-38 (Giám sát cửa đóng/mở): GPIO 26 (INPUT_PULLUP, LOW = Đóng, HIGH = Mở)
 *  - Màn hình LCD 20x4 I2C: SDA -> GPIO 21, SCL -> GPIO 22 (Địa chỉ I2C: 0x27)
 *  - Bo mở rộng bàn phím PCF8574 I2C: SDA -> GPIO 21, SCL -> GPIO 22 (Địa chỉ I2C: 0x20)
 *  - Hỗ trợ nhập mã OTP linh hoạt qua: Serial Monitor máy tính & Bàn phím ma trận I2C.
 * 
 * THƯ VIỆN CẦN CÀI ĐẶT TRÊN ARDUINO IDE:
 *  1. ArduinoJson (bản 6.x hoặc 7.x của Benoit Blanchon)
 *  2. LiquidCrystal_I2C (bản của Frank de Brabander hoặc Marco Schwartz)
 *  3. Keypad (bản của Mark Stanley / Alexander Brevig - Tùy chọn nếu dùng phím)
 * ======================================================================================
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "Fix04DoorCycle.h"

// ======================================================================================
// 1. CẤU HÌNH MẠNG WI-FI VÀ ĐỊA CHỈ BACKEND SERVER
// ======================================================================================
// Sao chép secrets.example.h -> secrets.h (gitignore); KHÔNG commit khóa hoặc Wi-Fi.
#include "secrets.h"
const char* WIFI_SSID = SMARTLOCKER_WIFI_SSID;
const char* WIFI_PASSWORD = SMARTLOCKER_WIFI_PASSWORD;
const char* DEVICE_API_KEY = SMARTLOCKER_DEVICE_API_KEY;
String SERVER_BASE_URL = SMARTLOCKER_SERVER_URL;

// Các đường dẫn API endpoints
const String API_VERIFY_OTP    = "/api/locker/verify-otp";
const String API_UPDATE_STATUS = "/api/locker/update-status";
const String API_GET_LOCKERS   = "/api/lockers";

// ======================================================================================
// 2. KHAI BÁO CHÂN PHẦN CỨNG (GPIO PIN DEFINITIONS)
// ======================================================================================
#define PIN_RELAY_1       18   // Relay Ngăn 1 (Solenoid 12V, kích mức LOW)
#define PIN_RELAY_2       19   // Relay Ngăn 2 (Solenoid 12V, kích mức LOW)
#define PIN_SENSOR_E18    25   // Cảm biến tiệm cận E18-D80NK (LOW = Có hàng, HIGH = Trống)
#define PIN_SENSOR_MC38   26   // Công tắc từ MC-38 (LOW = Cửa đóng, HIGH = Cửa mở)

#define I2C_SDA_PIN       21   // Chân I2C SDA cho LCD và PCF8574
#define I2C_SCL_PIN       22   // Chân I2C SCL cho LCD và PCF8574

#define LCD_I2C_ADDR      0x27 // Địa chỉ I2C của màn hình LCD 20x4
#define PCF8574_I2C_ADDR  0x20 // Địa chỉ I2C của bo đệm Keypad PCF8574

// Thời gian giữ xung kích mở khóa Solenoid (0.8 giây = 800 mili-giây)
const unsigned long SOLENOID_PULSE_MS = 800;

// Khởi tạo đối tượng LCD 20 cột, 4 hàng
LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 20, 4);

// ======================================================================================
// 3. MÁY TRẠNG THÁI HỆ THỐNG (FINITE STATE MACHINE - FSM)
// ======================================================================================
enum SystemState {
  STATE_IDLE,                 // Đang rảnh, chờ người dùng nhập mã OTP
  STATE_WAITING_DEPOSIT,      // Đã mở cửa cho Shipper, chờ bỏ hàng & đóng cửa
  STATE_WAITING_PICKUP,       // Đã mở cửa cho Sinh viên, chờ lấy đồ & đóng cửa
  STATE_MESSAGE_PAUSE,        // Hiển thị thông báo tạm thời rồi quay về IDLE
  STATE_PENDING_UPDATE,       // Đã đóng cửa, chờ ACK xác thực từ Backend
  STATE_NEEDS_ATTENTION       // Backend từ chối: cần kiểm tra thủ công
};

SystemState currentState = STATE_IDLE;
int currentActiveCompartment = 0;       // Ngăn tủ đang được thao tác (1 hoặc 2)
unsigned long stateTimer = 0;          // Bộ đếm thời gian cho các trạng thái chờ
unsigned long pauseDuration = 0;       // Thời gian tạm dừng hiển thị thông báo

// Biến lưu trữ mã OTP đang nhập
String enteredOtp = "";
const int OTP_LENGTH = 6;              // Độ dài mã OTP chuẩn là 6 chữ số

// Biến giám sát trạng thái cảm biến (chống dội - debouncing)
int lastE18State = HIGH;
int lastMC38State = LOW;
unsigned long sensorDebounceTimer = 0;
const unsigned long DEBOUNCE_DELAY = 400; // 400ms ổn định tín hiệu cảm biến
smartlocker::DoorCycle fix04DoorCycle;
String fix04PendingEvent = "";
unsigned long fix04LastPostAttempt = 0;
const unsigned long FIX04_RETRY_MS = 3000; // Thử lại khi mất mạng / response không chắc chắn


// Biến quản lý định kỳ kiểm tra kết nối WiFi & Server
unsigned long lastWiFiCheckTimer = 0;
unsigned long lastStatusSyncTimer = 0;
bool pcf8574Available = false;

// Bộ đệm trạng thái hiển thị 2 ngăn tủ từ Server
String locker1StateStr = "[TRONG]";
String locker2StateStr = "[TRONG]";

// ======================================================================================
// 4. CÁC HÀM TIỆN ÍCH HIỂN THỊ LCD 20x4 (KHÔNG CHỚP NHÁY MÀN HÌNH)
// ======================================================================================

/**
 * In chuỗi ký tự ra hàng chỉ định trên LCD.
 * Tự động chèn khoảng trắng lấp đầy 20 ký tự để xóa ký tự cũ mà KHÔNG CẦN gọi lcd.clear()
 * giúp màn hình hoàn toàn không bị chớp giật (Flicker-free).
 */
void lcdPrintLine(uint8_t row, String text, bool center = false) {
  if (row >= 4) return;
  
  // Cắt ngắn nếu vượt quá 20 ký tự
  if (text.length() > 20) {
    text = text.substring(0, 20);
  }
  
  String output = text;
  if (center) {
    int pad = (20 - text.length()) / 2;
    output = "";
    for (int i = 0; i < pad; i++) output += " ";
    output += text;
  }
  
  // Bổ sung dấu cách cho đủ đúng 20 ký tự
  while (output.length() < 20) {
    output += " ";
  }
  
  lcd.setCursor(0, row);
  lcd.print(output);
}

/**
 * Hiển thị màn hình chờ mặc định (IDLE Screen)
 */
void displayIdleScreen() {
  lcdPrintLine(0, "TRAM GIU HANG FPT", true);
  lcdPrintLine(1, "N1:" + locker1StateStr + " N2:" + locker2StateStr, true);
  
  if (enteredOtp.length() == 0) {
    lcdPrintLine(2, "NHAP MA OTP (6 SO):", false);
    lcdPrintLine(3, "[ _ _ _ _ _ _ ]", true);
  } else {
    lcdPrintLine(2, "DANG NHAP OTP:", false);
    String masked = "[ ";
    for (int i = 0; i < enteredOtp.length(); i++) {
      masked += enteredOtp.charAt(i);
      masked += " ";
    }
    for (int i = enteredOtp.length(); i < OTP_LENGTH; i++) {
      masked += "_ ";
    }
    masked += "]";
    lcdPrintLine(3, masked, true);
  }
}

/**
 * Hiển thị thông báo tạm thời rồi tự động chuyển về IDLE sau `ms` mili-giây
 */
void showMessageAndPause(String l0, String l1, String l2, String l3, unsigned long ms) {
  lcdPrintLine(0, l0, true);
  lcdPrintLine(1, l1, true);
  lcdPrintLine(2, l2, true);
  lcdPrintLine(3, l3, true);
  currentState = STATE_MESSAGE_PAUSE;
  stateTimer = millis();
  pauseDuration = ms;
}

// ======================================================================================
// 5. ĐIỀU KHIỂN KHÓA SOLENOID QUA RELAY (XUNG 0.8 GIÂY)
// ======================================================================================

/**
 * Kích mở Solenoid Lock cho ngăn tủ chỉ định.
 * Kích mức LOW trong 0.8 giây rồi tự động ngắt về HIGH để chống cháy cuộn dây Solenoid.
 */
void triggerSolenoidUnlock(int compartmentId) {
  int relayPin = (compartmentId == 1) ? PIN_RELAY_1 : PIN_RELAY_2;
  
  Serial.printf("[SOLENOID] >>> KICH MO KHOA NGAN %d (GPIO %d: LOW 0.8s) <<<\n", compartmentId, relayPin);
  
  // Kích mức LOW (Rơ le đóng, cấp nguồn 12V vào cuộn chốt Solenoid bung ra)
  digitalWrite(relayPin, LOW);
  delay(SOLENOID_PULSE_MS);
  
  // Trả về mức HIGH (Rơ le nhả, ngắt dòng điện an toàn)
  digitalWrite(relayPin, HIGH);
  Serial.printf("[SOLENOID] >>> DA KHOA LAI CHOT NGAN %d (GPIO %d: HIGH) <<<\n", compartmentId, relayPin);
}

// ======================================================================================
// 6. GIAO TIẾP VỚI BACKEND SERVER QUA RESTFUL APIS (HTTP POST / GET)
// ======================================================================================

/**
 * Gửi mã OTP lên Server để xác thực danh tính (Shipper hoặc Sinh viên)
 */
void verifyOtpWithServer(String otpCode) {
  enteredOtp = "";
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[FIX04] WiFi offline: OTP not verified, solenoid stays locked.");
    showMessageAndPause("MAT KET NOI WIFI", "CHUA XAC THUC OTP", "VUI LONG THU LAI", "KHI CO WIFI", 3000);
    return;
  }
  lcdPrintLine(0, "   XAC THUC MA...   ", true);
  lcdPrintLine(1, "DANG KET NOI SERVER ", true);
  lcdPrintLine(2, "DANG KIEM TRA...", true);
  lcdPrintLine(3, "XIN VUI LONG CHO... ", true);

  HTTPClient http;
  if (!http.begin(SERVER_BASE_URL + API_VERIFY_OTP)) {
    showMessageAndPause("LOI KET NOI API", "CHUA XAC THUC OTP", "KHONG MO KHOA", "VUI LONG THU LAI", 3000);
    return;
  }
  http.setTimeout(4500);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  StaticJsonDocument<256> request;
  request["otp"] = otpCode;
  String body;
  serializeJson(request, body);
  int code = http.POST(body);
  String response = code > 0 ? http.getString() : "";
  http.end();

  StaticJsonDocument<512> result;
  DeserializationError parseError = deserializeJson(result, response);
  if (code != 200 || parseError || String(result["status"] | "") != "SUCCESS") {
    Serial.printf("[FIX04] OTP rejected / network failure: HTTP %d\n", code);
    showMessageAndPause("XAC THUC THAT BAI", "OTP / MANG / SERVER", "KHONG MO KHOA", "VUI LONG KIEM TRA", 3000);
    return;
  }
  const String role = result["role"] | "";
  const int compId = result["compartment_id"] | 0;
  if ((role != "SHIPPER" && role != "STUDENT") || (compId != 1 && compId != 2)) {
    Serial.println("[FIX04] Invalid OTP response role/compartment: relay remains locked.");
    showMessageAndPause("DU LIEU API LOI", "KHONG MO KHOA", "VUI LONG KIEM TRA", "BACKEND", 3000);
    return;
  }

  currentActiveCompartment = compId;
  fix04DoorCycle.begin(millis());
  triggerSolenoidUnlock(compId); // 800ms pulse unchanged.
  if (role == "SHIPPER") {
    lcdPrintLine(0, " XIN CHAO SHIPPER!  ", true);
    lcdPrintLine(1, "HAY BO HANG VAO NGAN", true);
    lcdPrintLine(2, "SO " + String(compId) + " VA DONG CUA", true);
    lcdPrintLine(3, "====================", true);
    currentState = STATE_WAITING_DEPOSIT;
  } else {
    lcdPrintLine(0, "   XIN CHAO BAN!    ", true);
    lcdPrintLine(1, "HAY LAY MON AN TAI  ", true);
    lcdPrintLine(2, "NGAN " + String(compId) + " & DONG CUA", true);
    lcdPrintLine(3, "====================", true);
    currentState = STATE_WAITING_PICKUP;
  }
  stateTimer = millis();
}

/**
 * Gửi HTTP POST thông báo sự kiện cập nhật trạng thái ngăn tủ (ITEM_STORED / ITEM_PICKED)
 */
// Fix04PostResult is declared in Fix04DoorCycle.h for Arduino prototype generation.
Fix04PostResult updateLockerStatusToServer(int compId, String eventName, String doorState, String itemState) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[FIX04] WiFi offline; retaining pending transition.");
    return FIX04_RETRY;
  }
  HTTPClient http;
  if (!http.begin(SERVER_BASE_URL + API_UPDATE_STATUS)) return FIX04_RETRY;
  http.setTimeout(4500);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  StaticJsonDocument<256> request;
  request["compartment_id"] = compId;
  request["event"] = eventName;
  request["door_state"] = doorState;
  request["item_state"] = itemState;
  String body;
  serializeJson(request, body);
  int code = http.POST(body);
  String response = code > 0 ? http.getString() : "";
  http.end();

  StaticJsonDocument<512> result;
  DeserializationError parseError = deserializeJson(result, response);
  String expected = eventName == "ITEM_STORED" ? "STORED" : "AVAILABLE";
  if (code == 200 && !parseError && (result["success"] | false) &&
      String(result["locker_status"] | "") == expected) {
    Serial.printf("[FIX04] Backend ACK confirms %s for locker %d.\n", eventName.c_str(), compId);
    return FIX04_ACK;
  }
  // Backend may have committed but its ACK was lost. A later 409 is ambiguous:
  // never assume success or send a different event to 'fix' the state.
  if (code >= 400 && code < 500) {
    Serial.printf("[FIX04] Backend rejected transition HTTP %d. Manual check required.\n", code);
    return FIX04_STOP;
  }
  Serial.printf("[FIX04] No confirmed ACK (HTTP %d); retry will be scheduled.\n", code);
  return FIX04_RETRY;
}

/**
 * Đồng bộ trạng thái ngăn tủ từ Server để hiển thị nhãn N1/N2 lên LCD
 */
void syncLockersStateFromServer() {
  if (WiFi.status() != WL_CONNECTED) {
    locker1StateStr = "[???]";
    locker2StateStr = "[???]";
    return;
  }
  HTTPClient http;
  if (!http.begin(SERVER_BASE_URL + API_GET_LOCKERS)) return;
  http.setTimeout(4500);
  int code = http.GET();
  String response = code == 200 ? http.getString() : "";
  http.end();
  StaticJsonDocument<1024> doc;
  if (code != 200 || deserializeJson(doc, response)) {
    locker1StateStr = "[???]";
    locker2StateStr = "[???]";
    return;
  }
  JsonArray lockers = doc["lockers"].as<JsonArray>();
  if (lockers.isNull()) return;
  for (JsonObject locker : lockers) {
    const int id = locker["id"] | 0;
    const String status = locker["status"] | "";
    String label = "[???]";
    if (status == "AVAILABLE") label = "[TRONG]";
    else if (status == "WAITING_DELIVERY") label = "[CHO GIAO]";
    else if (status == "STORED") label = "[CO HANG]";
    else if (status == "ABANDONED") label = "[QUA HAN]";
    if (id == 1) locker1StateStr = label;
    if (id == 2) locker2StateStr = label;
  }
}

// ======================================================================================
// 7. XỬ LÝ NHẬN MÃ OTP (SERIAL MONITOR & BÀN PHÍM I2C PCF8574)
// ======================================================================================

/**
 * Đọc ký tự nhập từ Serial Monitor máy tính (Tốc độ 115200 baud)
 * Cho phép giảng viên / sinh viên dễ dàng gõ mã test trực tiếp từ máy tính.
 */
void handleSerialOtpInput() {
  while (Serial.available() > 0) {
    char c = Serial.read();

    // Bỏ qua ký tự xuống dòng
    if (c == '\r') continue;

    if (c == '\n') {
      // Phím Enter: Nếu đã nhập đủ mã thì xác thực
      if (enteredOtp.length() >= 4) {
        Serial.println("\n[SERIAL] Xac thuc OTP dang nhap.");
        verifyOtpWithServer(enteredOtp);
      } else {
        Serial.println("\n[SERIAL] Ma OTP chua du do dai! (Can 6 so)");
        enteredOtp = "";
        displayIdleScreen();
      }
      return;
    }

    // Phím Backspace / Xóa
    if (c == '\b' || c == 127) {
      if (enteredOtp.length() > 0) {
        enteredOtp.remove(enteredOtp.length() - 1);
        displayIdleScreen();
      }
      continue;
    }

    // Chỉ nhận ký tự số từ '0' đến '9'
    if (isDigit(c)) {
      if (enteredOtp.length() < OTP_LENGTH) {
        enteredOtp += c;
        // Do not output entered OTP digits to Serial Monitor.
        displayIdleScreen();

        // Tự động kiểm tra ngay khi đủ 6 chữ số
        if (enteredOtp.length() == OTP_LENGTH) {
          Serial.println("[OTP] Da du 6 so! Tu dong gui xac thuc len Server...");
          delay(200);
          verifyOtpWithServer(enteredOtp);
        }
      }
    }
  }
}

/**
 * Quét phím ma trận qua bo I2C PCF8574 (Địa chỉ 0x20)
 * Sơ đồ chân chuẩn PCF8574 nối bàn phím 4x4 (Row: P0-P3, Col: P4-P7)
 */
void checkI2CKeypadInput() {
  if (!pcf8574Available) return;

  const char keys[4][4] = {
    {'1', '2', '3', 'A'},
    {'4', '5', '6', 'B'},
    {'7', '8', '9', 'C'},
    {'*', '0', '#', 'D'}
  };

  for (byte r = 0; r < 4; r++) {
    // Kéo hàng r xuống mức LOW, các hàng khác để HIGH
    byte rowMask = ~(1 << r) & 0x0F;
    byte outByte = rowMask | 0xF0; // Giữ 4 chân cột P4-P7 ở mức HIGH PULLUP

    Wire.beginTransmission(PCF8574_I2C_ADDR);
    Wire.write(outByte);
    Wire.endTransmission();

    // Đọc trạng thái các chân cột P4-P7
    Wire.requestFrom(PCF8574_I2C_ADDR, 1);
    if (Wire.available()) {
      byte inByte = Wire.read();
      for (byte c = 0; c < 4; c++) {
        // Nếu chân cột tương ứng bị kéo xuống LOW -> phím được nhấn
        if (!(inByte & (1 << (c + 4)))) {
          char pressedKey = keys[r][c];
          Serial.printf("[KEYPAD] Phim duoc nhan: %c\n", pressedKey);

          // Phím '*' để XÓA mã
          if (pressedKey == '*') {
            enteredOtp = "";
            displayIdleScreen();
            delay(250);
            return;
          }

          // Phím '#' để XÁC NHẬN gửi mã
          if (pressedKey == '#') {
            if (enteredOtp.length() >= 4) {
              verifyOtpWithServer(enteredOtp);
            }
            delay(250);
            return;
          }

          // Phím số
          if (isDigit(pressedKey)) {
            if (enteredOtp.length() < OTP_LENGTH) {
              enteredOtp += pressedKey;
              displayIdleScreen();

              if (enteredOtp.length() == OTP_LENGTH) {
                delay(200);
                verifyOtpWithServer(enteredOtp);
              }
            }
          }

          delay(250); // Chống dội phím cơ bản
          return;
        }
      }
    }
  }
}

// ======================================================================================
// 8. MÁY TRẠNG THÁI GIÁM SÁT CẢM BIẾN (E18-D80NK VÀ MC-38)
// ======================================================================================

/**
 * Xử lý máy trạng thái sau khi đã mở khóa cửa
 */
void handleSensorStateMachine() {
  const int e18Value = digitalRead(PIN_SENSOR_E18);    // LOW = item detected.
  const int mc38Value = digitalRead(PIN_SENSOR_MC38);  // LOW = door closed.
  const unsigned long now = millis();

  if (currentState == STATE_WAITING_DEPOSIT || currentState == STATE_WAITING_PICKUP) {
    const bool isDeposit = currentState == STATE_WAITING_DEPOSIT;
    const bool expectedItem = isDeposit ? e18Value == LOW : e18Value == HIGH;
    if (fix04DoorCycle.observe(mc38Value == HIGH, expectedItem, now)) {
      fix04PendingEvent = isDeposit ? "ITEM_STORED" : "ITEM_PICKED";
      currentState = STATE_PENDING_UPDATE;
      fix04LastPostAttempt = now - FIX04_RETRY_MS; // Trigger first post on next loop.
      lcdPrintLine(0, "DA XAC NHAN DONG CUA", true);
      lcdPrintLine(1, "DANG CHO BACKEND...", true);
      lcdPrintLine(2, "CHUA HOAN TAT DON", true);
      lcdPrintLine(3, "VUI LONG CHO", true);
      Serial.println("[FIX04] Door cycle stable, awaiting Backend ACK.");
    }
  } else if (currentState == STATE_PENDING_UPDATE) {
    const bool isDeposit = fix04PendingEvent == "ITEM_STORED";
    // Never send a previously queued observation if the physical condition changed.
    // If it changed while offline, fail closed; operator must reconcile Backend/door.
    if (mc38Value != LOW || (isDeposit ? e18Value != LOW : e18Value != HIGH)) {
      currentState = STATE_NEEDS_ATTENTION;
      lcdPrintLine(0, "CAN KIEM TRA CAM BIEN", true);
      lcdPrintLine(1, "TRANG THAI DA DOI", true);
      lcdPrintLine(2, "KHONG NHAP OTP MOI", true);
      lcdPrintLine(3, "BAO NGUOI QUAN TRI", true);
      return;
    }
    if (static_cast<unsigned long>(now - fix04LastPostAttempt) < FIX04_RETRY_MS) return;
    fix04LastPostAttempt = now;
    const Fix04PostResult result = updateLockerStatusToServer(
      currentActiveCompartment, fix04PendingEvent, "CLOSED", isDeposit ? "DETECTED" : "EMPTY");
    if (result == FIX04_ACK) {
      fix04PendingEvent = "";
      showMessageAndPause(isDeposit ? "DA LUU TRU AN TOAN" : "DA LAY DO THANH CONG",
        "BACKEND DA XAC NHAN", "TRANG THAI DONG BO", "CAM ON BAN!", 3500);
      syncLockersStateFromServer();
    } else if (result == FIX04_STOP) {
      currentState = STATE_NEEDS_ATTENTION;
      lcdPrintLine(0, "CAN KIEM TRA BACKEND", true);
      lcdPrintLine(1, "API TU CHOI CAP NHAT", true);
      lcdPrintLine(2, "KHONG NHAP OTP MOI", true);
      lcdPrintLine(3, "BAO NGUOI QUAN TRI", true);
    } else if (WiFi.status() != WL_CONNECTED) {
      lcdPrintLine(1, "MAT WIFI - SE THU LAI", true);
    } else {
      lcdPrintLine(1, "CHUA CO ACK - THU LAI", true);
    }
  } else if (currentState == STATE_MESSAGE_PAUSE) {
    if (now - stateTimer >= pauseDuration) {
      currentState = STATE_IDLE;
      currentActiveCompartment = 0;
      enteredOtp = "";
      displayIdleScreen();
    }
  }
}

// ======================================================================================
// 9. QUẢN LÝ KẾT NỐI WI-FI VÀ TỰ ĐỘNG KẾT NỐI LẠI
// ======================================================================================
void checkWiFiConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Mat ket noi; thu reconnect khong xoa su kien dang cho.");
    WiFi.reconnect();
  }
}

// ======================================================================================
// 10. SETUP & MAIN LOOP
// ======================================================================================

void setup() {
  // 1. Khởi tạo Serial Monitor
  Serial.begin(115200);
  delay(500);
  Serial.println("\n\n========================================================");
  Serial.println("  SMART FOOD & PARCEL LOCKER (ESP32 FIRMWARE) KHOI DONG ");
  Serial.println("========================================================");

  // 2. Cấu hình chân GPIO đầu ra Relay (Khóa Solenoid)
  // Mặc định ở mức HIGH (Ngắt relay, khóa chốt)
  pinMode(PIN_RELAY_1, OUTPUT);
  pinMode(PIN_RELAY_2, OUTPUT);
  digitalWrite(PIN_RELAY_1, HIGH);
  digitalWrite(PIN_RELAY_2, HIGH);

  // 3. Cấu hình chân GPIO đầu vào Cảm biến với điện trở kéo lên nội bộ
  pinMode(PIN_SENSOR_E18, INPUT_PULLUP);
  pinMode(PIN_SENSOR_MC38, INPUT_PULLUP);

  // 4. Khởi tạo bus I2C và màn hình LCD 20x4
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  lcd.init();
  lcd.backlight();
  lcd.clear();

  lcdPrintLine(0, "SMART LOCKER FPT", true);
  lcdPrintLine(1, "ESP32 KHOI DONG...", true);
  lcdPrintLine(2, "DANG KET NOI WIFI...", true);
  lcdPrintLine(3, "XIN VUI LONG CHO...", true);

  // 5. Kiểm tra bo mở rộng Keypad PCF8574 (0x20)
  Wire.beginTransmission(PCF8574_I2C_ADDR);
  byte pcfErr = Wire.endTransmission();
  if (pcfErr == 0) {
    pcf8574Available = true;
    Serial.println("[HARDWARE] Tim thay bo Keypad I2C PCF8574 tai dia chi 0x20: SAN SANG!");
  } else {
    pcf8574Available = false;
    Serial.println("[HARDWARE] Khong tim thay PCF8574 tren bus I2C. Chuyen sang dung Serial Monitor de test.");
  }

  // 6. Kết nối Wi-Fi
  Serial.printf("[WIFI] Dang ket noi vao mang: %s ...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int wifiRetries = 0;
  while (WiFi.status() != WL_CONNECTED && wifiRetries < 25) {
    delay(500);
    Serial.print(".");
    wifiRetries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Ket noi thanh cong!");
    Serial.print("[WIFI] Dia chi IP ESP32: ");
    Serial.println(WiFi.localIP());

    lcdPrintLine(1, "WIFI: KET NOI TOT!", true);
    lcdPrintLine(2, "IP: " + WiFi.localIP().toString(), true);
    lcdPrintLine(3, "DONG BO HE THONG...", true);
    delay(1500);

    // Đồng bộ trạng thái ngăn tủ lần đầu
    syncLockersStateFromServer();
  } else {
    Serial.println("\n[WIFI] Khong the ket noi WiFi! Vui long kiem tra lai SSID/Pass.");
    lcdPrintLine(1, "LOI KET NOI WIFI!", true);
    lcdPrintLine(2, "KIEM TRA SSID/PASS", true);
    lcdPrintLine(3, "DUNG CHE DO TEST", true);
    delay(2000);
  }

  // Chuyển sang màn hình IDLE sẵn sàng phục vụ
  currentState = STATE_IDLE;
  displayIdleScreen();

  Serial.println("\n[READY] He thong san sang hoat dong!");
  Serial.println(" -> Go ma OTP (6 so) tren Serial Monitor de mo tu.");
  Serial.println(" -> Server API URL: " + SERVER_BASE_URL);
  Serial.println("========================================================\n");
}

void loop() {
  // 1. Quản lý kiểm tra kết nối WiFi định kỳ mỗi 10 giây
  if (millis() - lastWiFiCheckTimer > 10000) {
    lastWiFiCheckTimer = millis();
    checkWiFiConnection();
  }

  // 2. Định kỳ đồng bộ trạng thái ngăn tủ từ Server mỗi 5 giây khi đang ở trạng thái IDLE
  if (currentState == STATE_IDLE && (millis() - lastStatusSyncTimer > 5000)) {
    lastStatusSyncTimer = millis();
    syncLockersStateFromServer();
    displayIdleScreen();
  }

  // 3. Xử lý nhận mã OTP từ Serial Monitor máy tính
  if (currentState == STATE_IDLE) {
    handleSerialOtpInput();
    checkI2CKeypadInput();
  }

  // 4. Giám sát máy trạng thái cảm biến (E18 và MC-38)
  handleSensorStateMachine();

  // Nhường CPU cho ESP32 xử lý tác vụ ngầm (Wi-Fi stack, Watchdog)
  delay(20);
}
