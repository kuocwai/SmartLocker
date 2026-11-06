/**
 * ======================================================================================
 * DỰ ÁN: SMART FOOD & PARCEL LOCKER PROTOTYPE (2 NGĂN)
 * BẢN CLOUD: FIRMWARE ESP32 KẾT NỐI SERVER RAILWAY (HTTPS)
 * ======================================================================================
 * 
 * Bản này giống firmware gốc (SmartLocker_ESP32.ino) nhưng hỗ trợ HTTPS
 * để giao tiếp với server deploy trên Railway thay vì server LAN nội bộ.
 *
 * THAY ĐỔI SO VỚI BẢN GỐC:
 *  1. Thêm #include <WiFiClientSecure.h>
 *  2. Tất cả HTTPClient::begin() dùng WiFiClientSecure thay vì WiFiClient
 *  3. Dùng client.setInsecure() (bỏ qua verify cert cho prototype)
 *  4. Tăng timeout HTTP lên 8000ms (server cloud chậm hơn LAN)
 *
 * PHẦN CỨNG: Không thay đổi so với bản gốc.
 * ======================================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include "Fix04DoorCycle.h"

// ======================================================================================
// 1. CẤU HÌNH MẠNG WI-FI VÀ ĐỊA CHỈ BACKEND SERVER (RAILWAY CLOUD)
// ======================================================================================
#include "secrets.h"
const char* WIFI_SSID = SMARTLOCKER_WIFI_SSID;
const char* WIFI_PASSWORD = SMARTLOCKER_WIFI_PASSWORD;
const char* DEVICE_API_KEY = SMARTLOCKER_DEVICE_API_KEY;
String SERVER_BASE_URL = SMARTLOCKER_SERVER_URL;

// Các đường dẫn API endpoints
const String API_VERIFY_OTP    = "/api/locker/verify-otp";
const String API_UPDATE_STATUS = "/api/locker/update-status";
const String API_GET_LOCKERS   = "/api/lockers";

// Timeout cao hơn cho cloud server (LAN dùng 4500ms, cloud dùng 8000ms)
const int HTTP_TIMEOUT_MS = 8000;

// ======================================================================================
// 2. KHAI BÁO CHÂN PHẦN CỨNG (GPIO PIN DEFINITIONS) - Giống bản gốc
// ======================================================================================
#define PIN_RELAY_1       18
#define PIN_RELAY_2       19

// Cấu hình mức kích Relay chuẩn Active-LOW: OFF = HIGH (ngắt relay), ON = LOW (kích relay 0.6s)
#define RELAY_TRIGGER_ON     LOW
#define RELAY_TRIGGER_OFF    HIGH
#define PIN_SENSOR_E18    25
#define PIN_SENSOR_MC38   26
#define PIN_SENSOR_E18_2  32
#define PIN_SENSOR_MC38_2 33
#define PIN_BUZZER        27

// Chế độ MC-38 ảo: Đặt true khi không gắn công tắc từ MC-38 (tự động hóa qua cảm biến E18-D80NK)
#define VIRTUAL_MC38_MODE true

#define I2C_SDA_PIN       21
#define I2C_SCL_PIN       22

#define LCD_I2C_ADDR      0x27
#define PCF8574_I2C_ADDR  0x20

const unsigned long SOLENOID_PULSE_MS = 600;

LiquidCrystal_I2C lcd(LCD_I2C_ADDR, 20, 4);

void beep(int ms) {
  digitalWrite(PIN_BUZZER, HIGH);
  delay(ms);
  digitalWrite(PIN_BUZZER, LOW);
}

// ======================================================================================
// 3. MÁY TRẠNG THÁI HỆ THỐNG (FINITE STATE MACHINE)
// ======================================================================================
enum SystemState {
  STATE_IDLE,
  STATE_WAITING_DEPOSIT,
  STATE_WAITING_PICKUP,
  STATE_MESSAGE_PAUSE,
  STATE_PENDING_UPDATE,
  STATE_NEEDS_ATTENTION
};

SystemState currentState = STATE_IDLE;
int currentActiveCompartment = 0;
unsigned long stateTimer = 0;
unsigned long pauseDuration = 0;

String enteredOtp = "";
const int OTP_LENGTH = 6;

int lastE18State = HIGH;
int lastMC38State = LOW;
unsigned long sensorDebounceTimer = 0;
const unsigned long DEBOUNCE_DELAY = 400;
smartlocker::DoorCycle fix04DoorCycle;
String fix04PendingEvent = "";
unsigned long fix04LastPostAttempt = 0;
const unsigned long FIX04_RETRY_MS = 3000;

unsigned long lastWiFiCheckTimer = 0;
unsigned long lastStatusSyncTimer = 0;
bool pcf8574Available = false;
bool manualConfirmRequested = false;

String locker1StateStr = "TRONG";
String locker2StateStr = "TRONG";

// ======================================================================================
// 4. CÁC HÀM TIỆN ÍCH HIỂN THỊ LCD 20x4
// ======================================================================================
void lcdPrintLine(uint8_t row, String text, bool center = false) {
  if (row >= 4) return;
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
  while (output.length() < 20) {
    output += " ";
  }
  lcd.setCursor(0, row);
  lcd.print(output);
}

void displayIdleScreen() {
  lcdPrintLine(0, "TRAM GIU HANG FPT", true);
  lcdPrintLine(1, "N1:" + locker1StateStr + " | N2:" + locker2StateStr, true);
  
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
// 5. ĐIỀU KHIỂN KHÓA SOLENOID QUA RELAY
// ======================================================================================
void triggerSolenoidUnlock(int compartmentId) {
  int relayPin = (compartmentId == 1) ? PIN_RELAY_1 : PIN_RELAY_2;
  Serial.printf("[SOLENOID] >>> KICH MO KHOA NGAN %d (0.6s) <<<\n", compartmentId);
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, LOW);
  delay(SOLENOID_PULSE_MS);
  pinMode(relayPin, INPUT);
  Serial.printf("[SOLENOID] >>> DA KHOA LAI CHOT NGAN %d <<<\n", compartmentId);
}

// ======================================================================================
// 6. GIAO TIẾP HTTPS VỚI BACKEND SERVER RAILWAY
// ======================================================================================

/**
 * Tạo WiFiClientSecure cho kết nối HTTPS.
 * Prototype dùng setInsecure() để bỏ qua xác thực chứng chỉ SSL.
 * Production nên dùng root CA certificate của Railway / Let's Encrypt.
 */
WiFiClientSecure* createSecureClient() {
  WiFiClientSecure* client = new WiFiClientSecure();
  client->setInsecure();  // Bỏ qua verify cert SSL cho prototype
  return client;
}

/**
 * Helper: gọi HTTP POST tới server cloud qua HTTPS
 */
int cloudPost(const String& url, const String& body, String& response) {
  WiFiClientSecure* client = createSecureClient();
  HTTPClient http;
  int code = -1;
  
  if (http.begin(*client, url)) {
    http.setTimeout(HTTP_TIMEOUT_MS);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Key", DEVICE_API_KEY);
    code = http.POST(body);
    response = code > 0 ? http.getString() : "";
    http.end();
  }
  
  delete client;
  return code;
}

/**
 * Helper: gọi HTTP GET tới server cloud qua HTTPS
 */
int cloudGet(const String& url, String& response) {
  WiFiClientSecure* client = createSecureClient();
  HTTPClient http;
  int code = -1;
  
  if (http.begin(*client, url)) {
    http.setTimeout(HTTP_TIMEOUT_MS);
    code = http.GET();
    response = code == 200 ? http.getString() : "";
    http.end();
  }
  
  delete client;
  return code;
}

/**
 * Gửi mã OTP lên Server (Railway) để xác thực
 */
void verifyOtpWithServer(String otpCode) {
  enteredOtp = "";
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CLOUD] WiFi offline: OTP not verified, solenoid stays locked.");
    showMessageAndPause("MAT KET NOI WIFI", "CHUA XAC THUC OTP", "VUI LONG THU LAI", "KHI CO WIFI", 3000);
    return;
  }
  lcdPrintLine(0, "   XAC THUC MA...   ", true);
  lcdPrintLine(1, "KET NOI CLOUD SERVER", true);
  lcdPrintLine(2, "DANG KIEM TRA...", true);
  lcdPrintLine(3, "XIN VUI LONG CHO... ", true);

  StaticJsonDocument<256> request;
  request["otp"] = otpCode;
  String body;
  serializeJson(request, body);
  
  String response;
  int code = cloudPost(SERVER_BASE_URL + API_VERIFY_OTP, body, response);

  StaticJsonDocument<512> result;
  DeserializationError parseError = deserializeJson(result, response);
  if (code != 200 || parseError || String(result["status"] | "") != "SUCCESS") {
    beep(250); delay(100); beep(250); delay(100); beep(250);
    Serial.printf("[CLOUD] OTP rejected / network failure: HTTP %d\n", code);
    showMessageAndPause("XAC THUC THAT BAI", "OTP / MANG / SERVER", "KHONG MO KHOA", "VUI LONG KIEM TRA", 3000);
    return;
  }
  const String role = result["role"] | "";
  const int compId = result["compartment_id"] | 0;
  if ((role != "SHIPPER" && role != "STUDENT") || (compId != 1 && compId != 2)) {
    beep(250); delay(100); beep(250);
    Serial.println("[CLOUD] Invalid OTP response role/compartment: relay remains locked.");
    showMessageAndPause("DU LIEU API LOI", "KHONG MO KHOA", "VUI LONG KIEM TRA", "BACKEND", 3000);
    return;
  }

  beep(100); delay(50); beep(150);

  currentActiveCompartment = compId;
  fix04DoorCycle.begin(millis());
  triggerSolenoidUnlock(compId);
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
 * Gửi HTTP POST cập nhật trạng thái ngăn tủ (ITEM_STORED / ITEM_PICKED)
 */
Fix04PostResult updateLockerStatusToServer(int compId, String eventName, String doorState, String itemState) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[CLOUD] WiFi offline; retaining pending transition.");
    return FIX04_RETRY;
  }
  StaticJsonDocument<256> request;
  request["compartment_id"] = compId;
  request["event"] = eventName;
  request["door_state"] = doorState;
  request["item_state"] = itemState;
  String body;
  serializeJson(request, body);
  
  String response;
  int code = cloudPost(SERVER_BASE_URL + API_UPDATE_STATUS, body, response);

  StaticJsonDocument<512> result;
  DeserializationError parseError = deserializeJson(result, response);
  String expected = eventName == "ITEM_STORED" ? "STORED" : "AVAILABLE";
  if (code == 200 && !parseError && (result["success"] | false) &&
      String(result["locker_status"] | "") == expected) {
    Serial.printf("[CLOUD] Backend ACK confirms %s for locker %d.\n", eventName.c_str(), compId);
    return FIX04_ACK;
  }
  if (code >= 400 && code < 500) {
    Serial.printf("[CLOUD] Backend rejected transition HTTP %d. Manual check required.\n", code);
    return FIX04_STOP;
  }
  Serial.printf("[CLOUD] No confirmed ACK (HTTP %d); retry will be scheduled.\n", code);
  return FIX04_RETRY;
}

/**
 * Đồng bộ trạng thái ngăn tủ từ Server Railway
 */
void syncLockersStateFromServer() {
  if (WiFi.status() != WL_CONNECTED) {
    locker1StateStr = "[???]";
    locker2StateStr = "[???]";
    return;
  }
  String response;
  int code = cloudGet(SERVER_BASE_URL + API_GET_LOCKERS, response);
  
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
    String label = "???";
    if (status == "AVAILABLE") label = "TRONG";
    else if (status == "WAITING_DELIVERY") label = "CHO  ";
    else if (status == "STORED") label = "CO DO";
    else if (status == "ABANDONED") label = "QUA H";
    if (id == 1) locker1StateStr = label;
    if (id == 2) locker2StateStr = label;
  }
}

// ======================================================================================
// 7. XỬ LÝ NHẬN MÃ OTP (SERIAL MONITOR & BÀN PHÍM I2C PCF8574)
// ======================================================================================

void handleSerialOtpInput() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (enteredOtp.length() >= 4) {
        Serial.println("\n[SERIAL] Xac thuc OTP dang nhap.");
        String code = enteredOtp;
        enteredOtp = "";
        verifyOtpWithServer(code);
      } else if (enteredOtp.length() > 0) {
        Serial.println("\n[SERIAL] Ma OTP chua du do dai! (Can 6 so)");
        enteredOtp = "";
        displayIdleScreen();
      }
      return;
    }
    if (c == '\b' || c == 127) {
      if (enteredOtp.length() > 0) {
        enteredOtp.remove(enteredOtp.length() - 1);
        displayIdleScreen();
      }
      continue;
    }
    if (isDigit(c)) {
      beep(40);
      if (enteredOtp.length() < OTP_LENGTH) {
        enteredOtp += c;
        displayIdleScreen();
        if (enteredOtp.length() == OTP_LENGTH) {
          Serial.println("[OTP] Da du 6 so! Tu dong gui xac thuc len Cloud Server...");
          String code = enteredOtp;
          enteredOtp = "";
          delay(200);
          verifyOtpWithServer(code);
          while (Serial.available() > 0) Serial.read();
          return;
        }
      }
    }
  }
}

void checkI2CKeypadInput() {
  if (!pcf8574Available) return;
  const char keys[4][4] = {
    {'1', '4', '7', '*'},
    {'2', '5', '8', '0'},
    {'3', '6', '9', '#'},
    {'A', 'B', 'C', 'D'}
  };
  for (byte r = 0; r < 4; r++) {
    byte rowMask = ~(1 << r) & 0x0F;
    byte outByte = rowMask | 0xF0;
    Wire.beginTransmission(PCF8574_I2C_ADDR);
    Wire.write(outByte);
    Wire.endTransmission();
    Wire.requestFrom(PCF8574_I2C_ADDR, 1);
    if (Wire.available()) {
      byte inByte = Wire.read();
      for (byte c = 0; c < 4; c++) {
        if (!(inByte & (1 << (c + 4)))) {
          char pressedKey = keys[r][c];
          Serial.printf("[KEYPAD] Phim duoc nhan: %c\n", pressedKey);
          if (currentState == STATE_WAITING_DEPOSIT || currentState == STATE_WAITING_PICKUP) {
            beep(80); delay(40); beep(80);
            manualConfirmRequested = true;
            Serial.printf("[KEYPAD] Bam phim '%c' xac nhan hoan tat chu trinh thu cong!\n", pressedKey);
            delay(300);
            return;
          }
          if (pressedKey == 'A' || pressedKey == 'B' || pressedKey == 'C' || pressedKey == 'D') {
            beep(40);
            Serial.printf("[KEYPAD] Phim chuc nang: %c\n", pressedKey);
            delay(200);
            return;
          }
          if (pressedKey == '*') {
            beep(60);
            enteredOtp = "";
            displayIdleScreen();
            delay(250);
            return;
          }
          if (pressedKey == '#') {
            beep(60);
            if (enteredOtp.length() >= 4) {
              verifyOtpWithServer(enteredOtp);
            }
            delay(250);
            return;
          }
          if (isDigit(pressedKey)) {
            beep(40);
            if (enteredOtp.length() < OTP_LENGTH) {
              enteredOtp += pressedKey;
              displayIdleScreen();
              if (enteredOtp.length() == OTP_LENGTH) {
                delay(200);
                verifyOtpWithServer(enteredOtp);
              }
            }
          }
          delay(250);
          return;
        }
      }
    }
  }
}

// ======================================================================================
// 8. MÁY TRẠNG THÁI GIÁM SÁT CẢM BIẾN
// ======================================================================================
void handleSensorStateMachine() {
  const int activeE18Pin = (currentActiveCompartment == 2) ? PIN_SENSOR_E18_2 : PIN_SENSOR_E18;
  const int activeMC38Pin = (currentActiveCompartment == 2) ? PIN_SENSOR_MC38_2 : PIN_SENSOR_MC38;
  const int e18Value = digitalRead(activeE18Pin);
  int mc38Value = digitalRead(activeMC38Pin);
  const unsigned long now = millis();

#if VIRTUAL_MC38_MODE
  // Chế độ MC-38 ảo: Tự động hóa qua E18 (500ms) + Phím [#] xác nhận thủ công dự phòng
  static unsigned long e18StableSince = 0;
  static int lastFeedback = -1;
  if (currentState == STATE_WAITING_DEPOSIT || currentState == STATE_WAITING_PICKUP) {
    const bool isDeposit = (currentState == STATE_WAITING_DEPOSIT);
    const bool expectedItem = isDeposit ? (e18Value == LOW) : (e18Value == HIGH);

    // Phản hồi trực tiếp trên Dòng 3 LCD để người dùng biết mắt thần có bắt được đồ chưa
    int currentFb = expectedItem ? 1 : 0;
    if (currentFb != lastFeedback) {
      lastFeedback = currentFb;
      if (expectedItem) {
        lcdPrintLine(3, isDeposit ? ">> DA THAY DO AN! <<" : ">> DA LAY HET DO! <<", true);
      } else {
        lcdPrintLine(3, "BAM PHIM BAT KY XONG", true);
      }
    }

    if (now - stateTimer < 600) {
      mc38Value = HIGH; // Vừa bung khóa: Cửa mở
      e18StableSince = 0;
    } else {
      if (manualConfirmRequested) {
        manualConfirmRequested = false;
        mc38Value = LOW; // Xác nhận tức thì qua phím [#]
        Serial.println("[SENSOR] Hoan tat chu trinh qua phim [#]");
      } else if (expectedItem) {
        if (e18StableSince == 0) e18StableSince = now;
        if (now - e18StableSince >= 500) {
          mc38Value = LOW; // Nhận diện vật thể ổn định 0.5 giây -> Tự động xác nhận đóng cửa
        } else {
          mc38Value = HIGH;
        }
      } else {
        e18StableSince = 0;
        mc38Value = HIGH;
      }
    }
  } else {
    lastFeedback = -1;
    if (currentState == STATE_PENDING_UPDATE) {
      mc38Value = LOW;
    }
  }
#endif

  static int lastLoggedE18 = -1, lastLoggedMC38 = -1;
  if ((currentState == STATE_WAITING_DEPOSIT || currentState == STATE_WAITING_PICKUP) &&
      (e18Value != lastLoggedE18 || mc38Value != lastLoggedMC38)) {
    lastLoggedE18 = e18Value;
    lastLoggedMC38 = mc38Value;
    Serial.printf("[SENSOR-LIVE] E18(Do an): %s | MC38(Cua): %s\n",
                  e18Value == LOW ? "CO DO (LOW)" : "TRONG (HIGH)",
                  mc38Value == LOW ? "DONG (LOW)" : "MO (HIGH)");
  }

  if (currentState == STATE_WAITING_DEPOSIT || currentState == STATE_WAITING_PICKUP) {
    const bool isDeposit = currentState == STATE_WAITING_DEPOSIT;
    const bool expectedItem = isDeposit ? e18Value == LOW : e18Value == HIGH;
    if (fix04DoorCycle.observe(mc38Value == HIGH, expectedItem, now)) {
      fix04PendingEvent = isDeposit ? "ITEM_STORED" : "ITEM_PICKED";
      currentState = STATE_PENDING_UPDATE;
      fix04LastPostAttempt = now - FIX04_RETRY_MS;
      lcdPrintLine(0, "DA XAC NHAN DONG CUA", true);
      lcdPrintLine(1, "DANG CHO CLOUD...", true);
      lcdPrintLine(2, "CHUA HOAN TAT DON", true);
      lcdPrintLine(3, "VUI LONG CHO", true);
      Serial.println("[CLOUD] Door cycle stable, awaiting Cloud Backend ACK.");
    }
  } else if (currentState == STATE_PENDING_UPDATE) {
    const bool isDeposit = fix04PendingEvent == "ITEM_STORED";
#if !VIRTUAL_MC38_MODE
    if (mc38Value != LOW || (isDeposit ? e18Value != LOW : e18Value != HIGH)) {
      currentState = STATE_NEEDS_ATTENTION;
      lcdPrintLine(0, "LOI CAM BIEN!", true);
      lcdPrintLine(1, "TRANG THAI DA DOI", true);
      lcdPrintLine(2, "KHONG NHAP OTP MOI", true);
      lcdPrintLine(3, "BAO NGUOI QUAN TRI", true);
      return;
    }
#endif
    if (static_cast<unsigned long>(now - fix04LastPostAttempt) < FIX04_RETRY_MS) return;
    fix04LastPostAttempt = now;
    const Fix04PostResult result = updateLockerStatusToServer(
      currentActiveCompartment, fix04PendingEvent, "CLOSED", isDeposit ? "DETECTED" : "EMPTY");
    if (result == FIX04_ACK) {
      beep(100); delay(50); beep(150);
      fix04PendingEvent = "";
      showMessageAndPause(isDeposit ? "DA LUU TRU AN TOAN" : "DA LAY DO THANH CONG",
        "CLOUD DA XAC NHAN", "TRANG THAI DONG BO", "CAM ON BAN!", 3500);
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
// 9. QUẢN LÝ KẾT NỐI WI-FI
// ======================================================================================
void checkWiFiConnection() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Mat ket noi; thu reconnect.");
    WiFi.reconnect();
  }
}

// ======================================================================================
// 10. SETUP & MAIN LOOP
// ======================================================================================
void setup() {
  // Che do Tro khang cao (INPUT / Hi-Z): Mo mach hoan toan nhu khi rut day ra -> Relay NGAT 100%
  pinMode(PIN_RELAY_1, INPUT);
  pinMode(PIN_RELAY_2, INPUT);

  Serial.begin(115200);
  delay(100);
  Serial.println("\n\n========================================================");
  Serial.println("  SMART LOCKER (CLOUD / RAILWAY) FIRMWARE KHOI DONG");
  Serial.println("========================================================");

  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  beep(80);

  pinMode(PIN_SENSOR_E18, INPUT_PULLUP);
  pinMode(PIN_SENSOR_MC38, INPUT_PULLUP);
  pinMode(PIN_SENSOR_E18_2, INPUT_PULLUP);
  pinMode(PIN_SENSOR_MC38_2, INPUT_PULLUP);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  lcd.init();
  lcd.backlight();
  lcd.clear();

  lcdPrintLine(0, "SMART LOCKER CLOUD", true);
  lcdPrintLine(1, "ESP32 KHOI DONG...", true);
  lcdPrintLine(2, "DANG KET NOI WIFI...", true);
  lcdPrintLine(3, "XIN VUI LONG CHO...", true);

  Wire.beginTransmission(PCF8574_I2C_ADDR);
  byte pcfErr = Wire.endTransmission();
  if (pcfErr == 0) {
    pcf8574Available = true;
    Serial.println("[HARDWARE] Tim thay bo Keypad I2C PCF8574 tai dia chi 0x20: SAN SANG!");
  } else {
    pcf8574Available = false;
    Serial.println("[HARDWARE] Khong tim thay PCF8574. Dung Serial Monitor de test.");
  }

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
    lcdPrintLine(3, "DONG BO CLOUD...", true);
    delay(1500);

    syncLockersStateFromServer();
  } else {
    Serial.println("\n[WIFI] Khong the ket noi WiFi!");
    lcdPrintLine(1, "LOI KET NOI WIFI!", true);
    lcdPrintLine(2, "KIEM TRA SSID/PASS", true);
    lcdPrintLine(3, "DUNG CHE DO TEST", true);
    delay(2000);
  }

  currentState = STATE_IDLE;
  displayIdleScreen();

  Serial.println("\n[READY] He thong Cloud san sang hoat dong!");
  Serial.println(" -> Go ma OTP (6 so) tren Serial Monitor de mo tu.");
  Serial.println(" -> Cloud Server URL: " + SERVER_BASE_URL);
  Serial.println("========================================================\n");
}

void loop() {
  if (millis() - lastWiFiCheckTimer > 10000) {
    lastWiFiCheckTimer = millis();
    checkWiFiConnection();
  }

  // Đồng bộ trạng thái mỗi 8 giây (chậm hơn LAN do latency cloud)
  if (currentState == STATE_IDLE && (millis() - lastStatusSyncTimer > 8000)) {
    lastStatusSyncTimer = millis();
    syncLockersStateFromServer();
    displayIdleScreen();
  }

  if (currentState == STATE_IDLE) {
    handleSerialOtpInput();
    checkI2CKeypadInput();
  } else if (currentState == STATE_WAITING_DEPOSIT || currentState == STATE_WAITING_PICKUP) {
    checkI2CKeypadInput();
  }

  handleSensorStateMachine();
  delay(20);
}
