const express = require('express');
const crypto = require('node:crypto');
const path = require('path');
const os = require('os');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// FIX 01: Fail closed if server credentials are not configured.
const ADMIN_KEY = process.env.SMARTLOCKER_ADMIN_KEY || '';
const DEVICE_KEY = process.env.SMARTLOCKER_DEVICE_KEY || '';
if (ADMIN_KEY.length < 16 || DEVICE_KEY.length < 16 || ADMIN_KEY === DEVICE_KEY) {
  console.error('[SECURITY] Cần 2 khóa ADMIN / DEVICE khác nhau, tối thiểu 16 ký tự mỗi khóa. Xem FIX_01_README.md.');
  process.exit(1);
}
function matchesKey(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function isAdmin(req) { return matchesKey(req.get('X-Admin-Key'), ADMIN_KEY); }
function isDevice(req) { return matchesKey(req.get('X-Device-Key'), DEVICE_KEY); }
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Cần khóa quản trị.' });
  next();
}
function requireDeviceOrAdmin(req, res, next) {
  if (!isDevice(req) && !isAdmin(req)) return res.status(401).json({ success: false, message: 'Cần xác thực thiết bị hoặc quản trị.' });
  next();
}
// Giới hạn OTP theo IP; counters sống trong RAM, reset khi server khởi động lại.
const otpFailures = new Map();
const OTP_MAX_FAILURES = 10;
const OTP_WINDOW_MS = 15 * 60 * 1000;

// FIX 02: OTP verification authorizes exactly one matching delivery/pickup transition.
// An authorization expires to avoid accepting a stale ESP32 event after a long delay.
// Stored in memory: after a server restart, the user must verify the OTP again.
const pendingTransitions = new Map();
const TRANSITION_TTL_MS = 10 * 60 * 1000;
function authorizeTransition(order, role) {
  pendingTransitions.set(order.compartment_id, {
    orderId: order.id,
    role,
    expiresAt: Date.now() + TRANSITION_TTL_MS
  });
}
function hasAuthorizedTransition(compId, order, role) {
  const pending = pendingTransitions.get(compId);
  if (!pending) return false;
  if (Date.now() > pending.expiresAt) {
    pendingTransitions.delete(compId);
    return false;
  }
  return pending.orderId === order.id && pending.role === role;
}
function validCompartmentId(value) {
  return value === 1 || value === 2 || value === '1' || value === '2';
}
function validSensorValue(value, values) {
  return typeof value === 'string' && values.includes(value);
}
function isSensorPayloadValid(doorState, itemState) {
  return (doorState === undefined || validSensorValue(doorState, ['OPEN', 'CLOSED'])) &&
    (itemState === undefined || validSensorValue(itemState, ['DETECTED', 'EMPTY']));
}

function isOtpBlocked(req) {
  const e = otpFailures.get(req.ip);
  if (!e) return false;
  if (Date.now() >= e.until) { otpFailures.delete(req.ip); return false; }
  return e.count >= OTP_MAX_FAILURES;
}
function recordOtpFailure(req) {
  const now = Date.now();
  const prior = otpFailures.get(req.ip);
  const e = !prior || now >= prior.until ? { count: 0, until: now + OTP_WINDOW_MS } : prior;
  e.count++;
  otpFailures.set(req.ip, e);
}

// Middleware: same-origin browser API; don't allow unrestricted CORS.

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Tuyến đường cho Bảng Quản Trị & Giám Sát
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Quản lý SSE Clients (Server-Sent Events) để cập nhật thời gian thực
const sseClients = new Set();

function broadcastUpdate(eventType = 'UPDATE', payload = {}) {
  const data = JSON.stringify({ event: eventType, payload, timestamp: Date.now() });
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (err) {
      // client disconnected
    }
  });
}

// Hàm lấy danh sách địa chỉ IP mạng kèm tên card mạng
function getNetworkInterfacesList() {
  const interfaces = os.networkInterfaces();
  const results = [];
  
  for (const name of Object.keys(interfaces)) {
    const isVirtual = /vmnet|virtual|vbox|wsl|hyper-v|vethernet|loopback/i.test(name);
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        results.push({
          name,
          address: iface.address,
          isVirtual,
          isWifi: /wi-fi|wifi|wireless|wlan/i.test(name)
        });
      }
    }
  }

  // Ưu tiên card Wi-Fi thật lên đầu, sau đó đến Ethernet thật, cuối cùng mới đến card ảo
  results.sort((a, b) => {
    if (a.isWifi && !b.isWifi) return -1;
    if (!a.isWifi && b.isWifi) return 1;
    if (!a.isVirtual && b.isVirtual) return -1;
    if (a.isVirtual && !b.isVirtual) return 1;
    return 0;
  });

  return results;
}

// Hàm lấy danh sách mảng chuỗi địa chỉ IP (tương thích ngược)
function getLocalIpAddresses() {
  return getNetworkInterfacesList().map(i => i.address);
}

// Bổ sung thông tin SLA vào danh sách ngăn tủ
function enrichLockerWithSLA(locker) {
  const SLA_WARN_MIN = 45;
  const SLA_TIMEOUT_MIN = 120;
  const SLA_WARN_MS = SLA_WARN_MIN * 60 * 1000;
  const SLA_TIMEOUT_MS = SLA_TIMEOUT_MIN * 60 * 1000;

  let sla = {
    is_tracking: false,
    elapsed_seconds: 0,
    remaining_seconds: 0,
    percent: 0,
    stage: 'NONE', // 'SAFE', 'WARNING', 'ABANDONED'
    message: ''
  };

  if (locker.status === 'STORED' && locker.active_order && locker.active_order.stored_at) {
    const elapsedMs = Math.max(0, Date.now() - locker.active_order.stored_at);
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const remainingSec = Math.max(0, Math.floor((SLA_TIMEOUT_MS - elapsedMs) / 1000));
    const percent = Math.min(100, Math.round((elapsedMs / SLA_TIMEOUT_MS) * 100));

    let stage = 'SAFE';
    let message = 'An toàn: Đồ ăn đang tươi nóng';

    if (elapsedMs >= SLA_TIMEOUT_MS) {
      stage = 'ABANDONED';
      message = 'QUÁ HẠN LƯU TRỮ (120 phút)! Cần kiểm tra và xử lý hàng trong ngăn.';
    } else if (elapsedMs >= SLA_WARN_MS) {
      stage = 'WARNING';
      message = 'CẢNH BÁO CẤP 1 (45 phút): Đồ ăn sắp nguội, sinh viên cần lấy gấp!';
    }

    sla = {
      is_tracking: true,
      elapsed_seconds: elapsedSec,
      remaining_seconds: remainingSec,
      total_limit_seconds: SLA_TIMEOUT_MIN * 60,
      percent,
      stage,
      message
    };
  } else if (locker.status === 'ABANDONED') {
    sla = {
      is_tracking: false,
      elapsed_seconds: SLA_TIMEOUT_MIN * 60,
      remaining_seconds: 0,
      total_limit_seconds: SLA_TIMEOUT_MIN * 60,
      percent: 100,
      stage: 'ABANDONED',
      message: 'QUÁ HẠN LƯU TRỮ! Ngăn chưa được giải phóng; cần xử lý thủ công.'
    };
  }

  return { ...locker, sla };
}

// ==========================================
// VÒNG LẶP THEO DÕI AN TOÀN THỰC PHẨM (SLA)
// ==========================================
setInterval(() => {
  try {
  const storedOrders = db.getActiveStoredOrders();
  const now = Date.now();
  let hasChange = false;

  storedOrders.forEach(order => {
    if (!order.stored_at) return;
    const elapsedMs = now - order.stored_at;
    const SLA_WARN_MS = 45 * 60 * 1000;
    const SLA_TIMEOUT_MS = 120 * 60 * 1000;

    // Cảnh báo mốc 45 phút
    if (elapsedMs >= SLA_WARN_MS && !order.warning_45m_sent && elapsedMs < SLA_TIMEOUT_MS) {
      db.updateOrder(order.id, { warning_45m_sent: 1 });
      console.log(`[SLA] Ngăn ${order.compartment_id} đạt mốc 45 phút! Cảnh báo đồ ăn sắp nguội.`);
      hasChange = true;
    }

    // Mốc 120 phút: Quá hạn lưu trữ -> ABANDONED
    if (elapsedMs >= SLA_TIMEOUT_MS) {
      console.log(`[SLA] Ngăn ${order.compartment_id} vượt mốc 120 phút! Chuyển trạng thái sang ABANDONED.`);
      db.transitionOrderAndLocker(order.id, { status: 'ABANDONED', abandoned_at: now }, order.compartment_id, { status: 'ABANDONED' });
      hasChange = true;
    }
  });

  if (hasChange) {
    broadcastUpdate('SLA_TICK', { timestamp: now });
  }
  } catch (err) { console.error('[SLA] Tick failed; no partial state should be committed:', err); }
}, 5000);

// ==========================================
// RESTFUL APIS
// ==========================================

// Verify admin key without exposing the key itself.
app.get('/api/admin/check', requireAdmin, (req, res) => res.json({ success: true }));

// 1. Lấy trạng thái 2 ngăn tủ & đơn hàng hiện tại
app.get('/api/lockers', (req, res) => {
  const lockers = db.getLockers().map(enrichLockerWithSLA);
  // Never send order details / OTPs to anonymous clients (including ESP32 display sync).
  res.json({
    success: true,
    lockers: isAdmin(req) ? lockers : lockers.map(l => ({ ...l, active_order: null, active_order_id: null }))
  });
});

// 2. Sinh viên đặt ngăn tủ
app.post('/api/lockers/book', (req, res) => {

  // FIX 03: Strict compartment ID validation.
  if (!validCompartmentId(req.body?.compartment_id)) {
    return res.status(400).json({
      success: false,
      message: 'Số ngăn tủ không hợp lệ (phải là 1 hoặc 2)!'
    });
  }

  const compartment_id = Number(req.body.compartment_id);
  const customer_phone = req.body.customer_phone || req.body.student_phone || req.body.phone;
  const customer_name = req.body.customer_name || req.body.student_name || req.body.name || customer_phone;
  const student_id = req.body.student_id || req.body.mssv || '';
  const order_notes = req.body.order_notes || req.body.notes || '';
  
  // FIX 03: Validate input types before using string methods.
  const fieldsToValidate = {
    customer_name,
    customer_phone,
    student_id,
    order_notes
  };

  for (const [field, value] of Object.entries(fieldsToValidate)) {
    if (typeof value !== 'string') {
      return res.status(400).json({
        success: false,
        message: `${field} must be a string.`
      });
    }
  }
  
  // FIX 03: Validate phone format and input lengths.
  const cleanPhone = customer_phone.trim();
  const cleanName = customer_name.trim();
  const cleanStudentId = student_id.trim();
  const cleanNotes = order_notes.trim();

  // Accept Vietnamese mobile numbers: 0xxxxxxxxx or +84xxxxxxxxx.
  if (!/^(?:0[35789]\d{8}|\+84[35789]\d{8})$/.test(cleanPhone)) {
    return res.status(400).json({
      success: false,
      message: 'Số điện thoại không hợp lệ!'
    });
  }

  if (!cleanName || cleanName.length > 200) {
    return res.status(400).json({
      success: false,
      message: 'Tên khách hàng không hợp lệ hoặc quá 200 ký tự!'
    });
  }

  if (cleanStudentId.length > 100) {
    return res.status(400).json({
      success: false,
      message: 'Mã sinh viên không được vượt quá 100 ký tự!'
    });
  }

  if (cleanNotes.length > 1000) {
    return res.status(400).json({
      success: false,
      message: 'Ghi chú không được vượt quá 1000 ký tự!'
    });
  }


  if (!compartment_id || ![1, 2].includes(Number(compartment_id))) {
    return res.status(400).json({ success: false, message: 'Số ngăn tủ không hợp lệ (Phải là 1 hoặc 2)!' });
  }

  if (!customer_phone) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập Số điện thoại nhận hàng!' });
  }

  const locker = db.getLocker(compartment_id);
  if (!locker) {
    return res.status(404).json({ success: false, message: 'Không tìm thấy ngăn tủ!' });
  }

  if (locker.status !== 'AVAILABLE') {
    return res.status(400).json({
      success: false,
      message: `Ngăn ${compartment_id} hiện không khả dụng (Trạng thái: ${locker.status})!`
    });
  }

  // Tự động sinh ngẫu nhiên 2 mã OTP 6 số khác nhau
  const genOtp = () => Math.floor(100000 + Math.random() * 900000).toString();
  let otp_shipper = genOtp();
  let otp_student = genOtp();
  while (otp_student === otp_shipper) {
    otp_student = genOtp();
  }

  const order = db.createOrder({
    compartment_id: Number(compartment_id),
    customer_name: customer_name.trim(),
    customer_phone: customer_phone.trim(),
    student_id: student_id.trim().toUpperCase(),
    order_notes: (order_notes || '').trim(),
    otp_shipper,
    otp_student
  });

  console.log(`[BOOKING] Đặt thành công Ngăn ${compartment_id} - Đơn #${order.id} - SĐT: ${order.customer_phone}`);
  // The OTP is only returned in the booking HTTP response; never log or broadcast it.
  broadcastUpdate('LOCKER_BOOKED', { compartment_id });

  res.status(201).json({
    success: true,
    message: 'Đặt tủ thành công!',
    compartment_id: Number(compartment_id),
    order_id: order.id,
    otp_shipper,
    otp_student,
    order
  });
});

// 3. ESP32 Gửi mã OTP xác thực (Shipper giao hoặc Sinh viên nhận)
app.post('/api/locker/verify-otp', requireDeviceOrAdmin, (req, res) => {
  if (isOtpBlocked(req)) return res.status(429).json({ status: 'RATE_LIMITED', message: 'Thử lại sau 15 phút.' });
  const { otp } = req.body;

  if (!otp) {
    return res.status(400).json({ status: 'INVALID', message: 'Vui lòng cung cấp mã OTP!' });
  }

  const cleanOtp = String(otp).trim();
  // Never log an entered OTP.

  const result = db.findOrderByOtp(cleanOtp);

  if (!result) {
    recordOtpFailure(req);
    console.warn('[VERIFY-OTP] Mã không hợp lệ hoặc hết hạn.');
    return res.json({
      status: 'INVALID',
      message: 'MA OTP KHONG HOP LE HOAC DA HET HAN!'
    });
  }

  const { order, role } = result;
  otpFailures.delete(req.ip);
  authorizeTransition(order, role);

  console.log(`[VERIFY-OTP] Thành công! Vai trò: ${role} | Ngăn: ${order.compartment_id} | Đơn #${order.id}`);

  let lcdMessage = '';
  if (role === 'SHIPPER') {
    lcdMessage = `XIN CHAO SHIPPER!\nHAY BO HANG VA DONG CUA`;
  } else {
    lcdMessage = `XIN CHAO BAN!\nHAY LAY DO VA DONG CUA`;
  }

  broadcastUpdate('OTP_VERIFIED', {
    role,
    compartment_id: order.compartment_id,
    order_id: order.id
  });

  return res.json({
    status: 'SUCCESS',
    role,
    compartment_id: order.compartment_id,
    order_id: order.id,
    customer_name: order.customer_name,
    message: lcdMessage
  });
});

// 4. ESP32 Cập nhật trạng thái sự kiện khi cửa đóng
app.post('/api/locker/update-status', requireDeviceOrAdmin, (req, res) => {
  const { compartment_id, event, door_state, item_state } = req.body;
  if (!validCompartmentId(compartment_id)) {
    return res.status(400).json({ success: false, message: 'Số ngăn tủ không hợp lệ!' });
  }
  if (typeof event !== 'string' || !['ITEM_STORED', 'ITEM_PICKED', 'SENSOR_SYNC'].includes(event)) {
    return res.status(400).json({ success: false, message: 'Sự kiện không được hỗ trợ.' });
  }
  if (!isSensorPayloadValid(door_state, item_state)) {
    return res.status(400).json({ success: false, message: 'Giá trị cảm biến không hợp lệ.' });
  }

  const compId = Number(compartment_id);
  const locker = db.getLocker(compId);
  if (!locker) return res.status(404).json({ success: false, message: 'Không tìm thấy ngăn tủ.' });

  if (event === 'SENSOR_SYNC') {
    const fieldsToUpdate = {};
    if (door_state !== undefined) fieldsToUpdate.door_state = door_state;
    if (item_state !== undefined) fieldsToUpdate.item_state = item_state;
    db.updateLocker(compId, fieldsToUpdate);
    broadcastUpdate('SENSOR_SYNC', { compartment_id: compId, door_state, item_state });
    return res.json({ success: true, message: 'Đã đồng bộ trạng thái cảm biến.' });
  }

  const isDeposit = event === 'ITEM_STORED';
  const expectedOrderStatus = isDeposit ? 'WAITING_DELIVERY' : 'STORED';
  const expectedRole = isDeposit ? 'SHIPPER' : 'STUDENT';
  const expectedItemState = isDeposit ? 'DETECTED' : 'EMPTY';
  const expectedLockerStatus = expectedOrderStatus;
  const activeOrder = db.getActiveOrder(compId);

  // Reject stale/duplicate/out-of-sequence events. Never change locker status
  // unless its active order and its status agree with the intended transition.
  if (!activeOrder || !locker.active_order_id || locker.active_order_id !== activeOrder.id ||
      activeOrder.status !== expectedOrderStatus || locker.status !== expectedLockerStatus) {
    return res.status(409).json({ success: false, message: 'Không có đơn hàng hợp lệ ở trạng thái yêu cầu.' });
  }
  if (!hasAuthorizedTransition(compId, activeOrder, expectedRole)) {
    return res.status(403).json({ success: false, message: 'Chưa xác thực OTP tương ứng hoặc phiên xác thực đã hết hạn.' });
  }
  // Firmware currently reports these sensor observations when it closes the door.
  // This is API-level validation, NOT physical proof that the door actually opened.
  if (door_state !== 'CLOSED' || item_state !== expectedItemState) {
    return res.status(400).json({ success: false, message: 'Chưa xác nhận cửa đóng và trạng thái hàng phù hợp.' });
  }

  const now = Date.now();
  if (isDeposit) {
    db.transitionOrderAndLocker(activeOrder.id, { status: 'STORED', stored_at: now }, compId, { status: 'STORED', door_state: 'CLOSED', item_state: 'DETECTED' });
    pendingTransitions.delete(compId);
    broadcastUpdate('ITEM_STORED', { compartment_id: compId });
    return res.json({ success: true, locker_status: 'STORED', message: `Ngăn ${compId} đã có hàng. Bắt đầu đếm giờ lưu trữ.` });
  }

  db.transitionOrderAndLocker(activeOrder.id, { status: 'COMPLETED', completed_at: now }, compId, { status: 'AVAILABLE', door_state: 'CLOSED', item_state: 'EMPTY', active_order_id: null });
  pendingTransitions.delete(compId);
  broadcastUpdate('ITEM_PICKED', { compartment_id: compId });
  return res.json({ success: true, locker_status: 'AVAILABLE', message: `Đơn hàng hoàn tất. Ngăn ${compId} đã sẵn sàng.` });
});

// 5. Đồng bộ cảm biến trực tiếp từ ESP32

app.post('/api/locker/sensor-sync', requireDeviceOrAdmin, (req, res) => {
  const { compartment_id, door_state, item_state } = req.body;

  // FIX 03: Require at least one sensor value.
  if (door_state === undefined && item_state === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Phải cung cấp ít nhất một trạng thái cảm biến!'
    });
  }

  if (!validCompartmentId(compartment_id)) {
    return res.status(400).json({
      success: false,
      message: 'Số ngăn tủ không hợp lệ!'
    });
  }

  if (!validCompartmentId(compartment_id)) {
    return res.status(400).json({ success: false, message: 'Số ngăn tủ không hợp lệ!' });
  }
  if (!isSensorPayloadValid(door_state, item_state)) {
    return res.status(400).json({ success: false, message: 'Giá trị cảm biến không hợp lệ.' });
  }
  const compId = Number(compartment_id);
  const fields = {};
  if (door_state !== undefined) fields.door_state = door_state;
  if (item_state !== undefined) fields.item_state = item_state;
  db.updateLocker(compId, fields);
  broadcastUpdate('SENSOR_SYNC', { compartment_id: compId, door_state, item_state });
  return res.json({ success: true });
});

// 6. Lấy lịch sử đơn hàng
app.get('/api/orders/history', requireAdmin, (req, res) => {
  const history = db.getOrderHistory(20);
  res.json({ success: true, history });
});

// 7. Reset toàn bộ 2 ngăn tủ về AVAILABLE (Dành cho demo / thuyết trình)
app.post('/api/lockers/reset', requireAdmin, (req, res) => {
  if (db.getLockers().some(l => l.item_state === 'DETECTED' || l.status === 'STORED' || l.status === 'ABANDONED')) {
    return res.status(409).json({ success: false, message: 'Tủ còn hàng hoặc đơn quá hạn; cần kiểm tra và xử lý thủ công trước khi reset.' });
  }
  const resetLockers = db.resetAllLockers().map(enrichLockerWithSLA);
  console.log('[RESET] Đã đặt lại toàn bộ ngăn tủ về AVAILABLE.');
  broadcastUpdate('LOCKERS_RESET');
  res.json({ success: true, message: 'Đã đặt lại 2 ngăn tủ về trạng thái trống!', lockers: resetLockers });
});

// 8. Tua nhanh thời gian SLA (Dành cho Giảng viên / Thuyết trình kiểm thử)
app.post('/api/simulate/fast-forward', requireAdmin, (req, res) => {
  const { compartment_id, minutes } = req.body;
  const compId = Number(compartment_id || 1);
  
  // FIX 03: Validate fast-forward minutes.
  // Keep the default of 45 minutes when omitted.
  const rawMinutes = minutes === undefined ? 45 : minutes;

  if (
    (typeof rawMinutes !== 'number' &&
      typeof rawMinutes !== 'string') ||
    (typeof rawMinutes === 'string' &&
      !/^[0-9]+$/.test(rawMinutes)) ||
    !Number.isSafeInteger(Number(rawMinutes)) ||
    Number(rawMinutes) < 1 ||
    Number(rawMinutes) > 1440
  ) {
    return res.status(400).json({
      success: false,
      message: 'Số phút không hợp lệ (phải từ 1 đến 1440)!'
    });
  }

  const addMinutes = Number(rawMinutes);


  const activeOrder = db.getActiveOrder(compId);
  if (!activeOrder || activeOrder.status !== 'STORED') {
    return res.status(400).json({
      success: false,
      message: `Ngăn ${compId} hiện không có đồ đang lưu trữ (STORED) để tua thời gian!`
    });
  }

  // Lùi thời điểm stored_at về trước đó
  const newStoredAt = (activeOrder.stored_at || Date.now()) - (addMinutes * 60 * 1000);
  db.updateOrder(activeOrder.id, { stored_at: newStoredAt });

  console.log(`[SIMULATION] Đã tua nhanh thời gian lưu trữ Ngăn ${compId} thêm ${addMinutes} phút!`);
  broadcastUpdate('SLA_TICK', { compartment_id: compId });

  res.json({
    success: true,
    message: `Đã tua nhanh ${addMinutes} phút cho Ngăn ${compId}. Kiểm tra đồng hồ đếm ngược trên Dashboard!`
  });
});

// 9. Lấy thông tin hệ thống mạng (IP LAN để cấu hình ESP32)
app.get('/api/system/info', (req, res) => {
  const localIps = getLocalIpAddresses();
  res.json({
    success: true,
    server_port: PORT,
    local_ips: localIps,
    esp32_api_url: localIps.length > 0 ? `http://${localIps[0]}:${PORT}` : `http://localhost:${PORT}`,
    db_type: db.isSqlite() ? 'SQLite (data/smartlocker.db)' : 'JSON Store (data/smartlocker.json)',
    uptime_seconds: Math.floor(process.uptime())
  });
});

// 10. Server-Sent Events (SSE) để Dashboard nhận cập nhật ngay lập tức
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const newClient = { res };
  sseClients.add(newClient);

  // Gửi heartbeat định kỳ
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(newClient);
  });
});

// Chạy server
// FIX 03: Centralized JSON error responses (never leak stack traces to clients).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: 'Dữ liệu JSON không hợp lệ.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Dữ liệu gửi lên quá lớn.' });
  }
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500
    ? err.status : 500;
  if (code === 500) console.error('[SERVER ERROR]', err);
  return res.status(code).json({
    success: false,
    message: code === 500 ? 'Lỗi máy chủ nội bộ.' : 'Yêu cầu không hợp lệ.'
  });
});
app.listen(PORT, '0.0.0.0', () => {
  const ifaces = getNetworkInterfacesList();
  console.log('\n======================================================');
  console.log('🚀 SMART FOOD & PARCEL LOCKER - BACKEND SERVER RUNNING');
  console.log('======================================================');
  console.log(`* Local Web (Trình duyệt máy tính): http://localhost:${PORT}`);
  
  const realIfaces = ifaces.filter(i => !i.isVirtual);
  const virtualIfaces = ifaces.filter(i => i.isVirtual);

  if (realIfaces.length > 0) {
    realIfaces.forEach(i => {
      console.log(`* IP Mạng LAN [${i.name}] (Dành cho ESP32 & Điện thoại): http://${i.address}:${PORT}`);
    });
  }
  
  if (virtualIfaces.length > 0) {
    // In gọn các card ảo nếu có máy ảo VMware/WSL
    console.log(`* (Card mạng ảo VMware/WSL: ${virtualIfaces.map(v => v.address).join(', ')})`);
  }

  console.log(`* Database:   ${db.isSqlite() ? 'SQLite File (better-sqlite3)' : 'JSON File Store'}`);
  console.log('======================================================\n');
});
