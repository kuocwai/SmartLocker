const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Tuyến đường cho Bảng Quản Trị & Giám Sát
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Quản lý SSE Clients (Server-Sent Events) để cập nhật thời gian thực
let sseClients = [];

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
      message = 'QUÁ HẠN LƯU TRỮ (120 phút)! Đơn hàng bị hủy để an toàn.';
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
      message: 'QUÁ HẠN LƯU TRỮ! Tủ đã khóa hủy đơn.'
    };
  }

  return { ...locker, sla };
}

// ==========================================
// VÒNG LẶP THEO DÕI AN TOÀN THỰC PHẨM (SLA)
// ==========================================
setInterval(() => {
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
      db.updateOrder(order.id, {
        status: 'ABANDONED',
        abandoned_at: now
      });
      db.updateLocker(order.compartment_id, {
        status: 'ABANDONED'
      });
      hasChange = true;
    }
  });

  if (hasChange) {
    broadcastUpdate('SLA_TICK', { timestamp: now });
  }
}, 5000);

// ==========================================
// RESTFUL APIS
// ==========================================

// 1. Lấy trạng thái 2 ngăn tủ & đơn hàng hiện tại
app.get('/api/lockers', (req, res) => {
  const lockers = db.getLockers().map(enrichLockerWithSLA);
  res.json({ success: true, lockers });
});

// 2. Sinh viên đặt ngăn tủ
app.post('/api/lockers/book', (req, res) => {
  const compartment_id = Number(req.body.compartment_id);
  const customer_name = req.body.customer_name || req.body.student_name || req.body.name;
  const customer_phone = req.body.customer_phone || req.body.student_phone || req.body.phone;
  const student_id = req.body.student_id || req.body.mssv || '';
  const order_notes = req.body.order_notes || req.body.notes || '';

  if (!compartment_id || ![1, 2].includes(Number(compartment_id))) {
    return res.status(400).json({ success: false, message: 'Số ngăn tủ không hợp lệ (Phải là 1 hoặc 2)!' });
  }

  if (!customer_name || !customer_phone || !student_id) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ Họ tên, MSSV và Số điện thoại!' });
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

  console.log(`[BOOKING] Đặt thành công Ngăn ${compartment_id} - Đơn #${order.id} - ${order.customer_name} (${order.student_id})`);
  console.log(`  -> Mã Shipper: ${otp_shipper} | Mã Sinh viên: ${otp_student}`);

  broadcastUpdate('LOCKER_BOOKED', { compartment_id, order });

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
app.post('/api/locker/verify-otp', (req, res) => {
  const { otp } = req.body;

  if (!otp) {
    return res.status(400).json({ status: 'INVALID', message: 'Vui lòng cung cấp mã OTP!' });
  }

  const cleanOtp = String(otp).trim();
  console.log(`[VERIFY-OTP] Nhận yêu cầu kiểm tra mã: "${cleanOtp}"`);

  const result = db.findOrderByOtp(cleanOtp);

  if (!result) {
    console.log(`[VERIFY-OTP] Thất bại: Mã "${cleanOtp}" không đúng hoặc đã hết hạn.`);
    return res.json({
      status: 'INVALID',
      message: 'MA OTP KHONG HOP LE HOAC DA HET HAN!'
    });
  }

  const { order, role } = result;

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
app.post('/api/locker/update-status', (req, res) => {
  const { compartment_id, event, door_state, item_state } = req.body;

  if (!compartment_id || ![1, 2].includes(Number(compartment_id))) {
    return res.status(400).json({ success: false, message: 'Số ngăn tủ không hợp lệ!' });
  }

  const compId = Number(compartment_id);
  const now = Date.now();
  console.log(`[UPDATE-STATUS] Nhận sự kiện từ ESP32: Ngăn ${compId} - Event: ${event}`);

  if (event === 'ITEM_STORED') {
    // Shipper đã bỏ đồ vào và đóng cửa
    const activeOrder = db.getActiveOrder(compId);
    if (activeOrder) {
      db.updateOrder(activeOrder.id, {
        status: 'STORED',
        stored_at: now
      });
    }

    db.updateLocker(compId, {
      status: 'STORED',
      door_state: door_state || 'CLOSED',
      item_state: item_state || 'DETECTED'
    });

    console.log(`[UPDATE-STATUS] Ngăn ${compId} đã chuyển sang STORED. Kích hoạt đồng hồ SLA.`);
    broadcastUpdate('ITEM_STORED', { compartment_id: compId });

    return res.json({
      success: true,
      locker_status: 'STORED',
      message: `Ngăn ${compId} đã có hàng. Bắt đầu đếm giờ lưu trữ an toàn thực phẩm.`
    });

  } else if (event === 'ITEM_PICKED') {
    // Sinh viên đã lấy đồ ra và đóng cửa
    const activeOrder = db.getActiveOrder(compId);
    if (activeOrder) {
      db.updateOrder(activeOrder.id, {
        status: 'COMPLETED',
        completed_at: now
      });
    }

    db.updateLocker(compId, {
      status: 'AVAILABLE',
      door_state: door_state || 'CLOSED',
      item_state: item_state || 'EMPTY',
      active_order_id: null
    });

    console.log(`[UPDATE-STATUS] Ngăn ${compId} hoàn tất đơn hàng. Đã giải phóng về AVAILABLE.`);
    broadcastUpdate('ITEM_PICKED', { compartment_id: compId });

    return res.json({
      success: true,
      locker_status: 'AVAILABLE',
      message: `Đơn hàng hoàn tất. Ngăn ${compId} đã sẵn sàng nhận đơn mới.`
    });

  } else {
    // Cập nhật trạng thái cảm biến thông thường
    const fieldsToUpdate = {};
    if (door_state) fieldsToUpdate.door_state = door_state;
    if (item_state) fieldsToUpdate.item_state = item_state;

    db.updateLocker(compId, fieldsToUpdate);
    broadcastUpdate('SENSOR_SYNC', { compartment_id: compId, door_state, item_state });

    return res.json({ success: true, message: 'Đã đồng bộ trạng thái cảm biến.' });
  }
});

// 5. Đồng bộ cảm biến trực tiếp từ ESP32
app.post('/api/locker/sensor-sync', (req, res) => {
  const { compartment_id, door_state, item_state } = req.body;
  if (!compartment_id) {
    return res.status(400).json({ success: false, message: 'Thiếu compartment_id' });
  }
  const compId = Number(compartment_id);
  db.updateLocker(compId, {
    door_state: door_state || 'CLOSED',
    item_state: item_state || 'EMPTY'
  });
  broadcastUpdate('SENSOR_SYNC', { compartment_id: compId, door_state, item_state });
  res.json({ success: true });
});

// 6. Lấy lịch sử đơn hàng
app.get('/api/orders/history', (req, res) => {
  const history = db.getOrderHistory(20);
  res.json({ success: true, history });
});

// 7. Reset toàn bộ 2 ngăn tủ về AVAILABLE (Dành cho demo / thuyết trình)
app.post('/api/lockers/reset', (req, res) => {
  const resetLockers = db.resetAllLockers().map(enrichLockerWithSLA);
  console.log('[RESET] Đã đặt lại toàn bộ ngăn tủ về AVAILABLE.');
  broadcastUpdate('LOCKERS_RESET', { lockers: resetLockers });
  res.json({ success: true, message: 'Đã đặt lại 2 ngăn tủ về trạng thái trống!', lockers: resetLockers });
});

// 8. Tua nhanh thời gian SLA (Dành cho Giảng viên / Thuyết trình kiểm thử)
app.post('/api/simulate/fast-forward', (req, res) => {
  const { compartment_id, minutes } = req.body;
  const compId = Number(compartment_id || 1);
  const addMinutes = Number(minutes || 45);

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

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  // Gửi heartbeat định kỳ
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Chạy server
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
