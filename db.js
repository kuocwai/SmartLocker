const fs = require('fs');
const path = require('path');

// Đảm bảo thư mục data/ tồn tại
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let dbInstance = null;
let useSqlite = false;

// Thử nạp better-sqlite3, nếu không có sẽ tự động dùng JSON store
try {
  const Database = require('better-sqlite3');
  const dbPath = path.join(dataDir, 'smartlocker.db');
  dbInstance = new Database(dbPath);
  dbInstance.pragma('journal_mode = WAL');
  useSqlite = true;
  console.log('[DB] Kết nối SQLite thành công:', dbPath);

  // Tạo bảng Lockers
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS lockers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE',
      door_state TEXT NOT NULL DEFAULT 'CLOSED',
      item_state TEXT NOT NULL DEFAULT 'EMPTY',
      active_order_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compartment_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      order_notes TEXT,
      otp_shipper TEXT NOT NULL,
      otp_student TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'WAITING_DELIVERY',
      created_at INTEGER NOT NULL,
      stored_at INTEGER,
      completed_at INTEGER,
      abandoned_at INTEGER,
      warning_45m_sent INTEGER DEFAULT 0
    );
  `);

  // Khởi tạo 2 ngăn tủ nếu chưa có
  const checkLocker = dbInstance.prepare('SELECT COUNT(*) as count FROM lockers').get();
  if (checkLocker.count === 0) {
    const insertLocker = dbInstance.prepare(`
      INSERT INTO lockers (id, name, status, door_state, item_state, active_order_id)
      VALUES (?, ?, 'AVAILABLE', 'CLOSED', 'EMPTY', NULL)
    `);
    insertLocker.run(1, 'Ngăn 1 (Tầng trên)');
    insertLocker.run(2, 'Ngăn 2 (Tầng dưới)');
    console.log('[DB] Đã khởi tạo 2 ngăn tủ mẫu (Ngăn 1 & Ngăn 2).');
  }

} catch (err) {
  // Khi chạy trên máy tính không có C++ Build Tools (hoặc phiên bản Node.js mới như v24),
  // hệ thống sẽ tự động kích hoạt cơ chế JSON File Store để đảm bảo 100% không bao giờ bị lỗi.
  console.log('[DB] Cơ chế lưu trữ: JSON File Database (Bền vững, tương thích mọi môi trường)');
  useSqlite = false;
}

// ==========================================
// FALLBACK JSON STORE (Nếu không dùng SQLite)
// ==========================================
const jsonFile = path.join(dataDir, 'smartlocker.json');
let jsonData = {
  lockers: [
    { id: 1, name: 'Ngăn 1 (Tầng trên)', status: 'AVAILABLE', door_state: 'CLOSED', item_state: 'EMPTY', active_order_id: null },
    { id: 2, name: 'Ngăn 2 (Tầng dưới)', status: 'AVAILABLE', door_state: 'CLOSED', item_state: 'EMPTY', active_order_id: null }
  ],
  orders: []
};

if (!useSqlite) {
  if (fs.existsSync(jsonFile)) {
    try {
      jsonData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    } catch (e) {
      console.error('[DB] Lỗi đọc JSON data, dùng dữ liệu mặc định');
    }
  } else {
    fs.writeFileSync(jsonFile, JSON.stringify(jsonData, null, 2), 'utf8');
  }
}

function saveJson() {
  if (!useSqlite) {
    fs.writeFileSync(jsonFile, JSON.stringify(jsonData, null, 2), 'utf8');
  }
}

// ==========================================
// UNIFIED DATABASE INTERFACE
// ==========================================

const db = {
  isSqlite() {
    return useSqlite;
  },

  getLockers() {
    if (useSqlite) {
      const lockers = dbInstance.prepare('SELECT * FROM lockers ORDER BY id ASC').all();
      return lockers.map(locker => {
        let activeOrder = null;
        if (locker.active_order_id) {
          activeOrder = dbInstance.prepare('SELECT * FROM orders WHERE id = ?').get(locker.active_order_id);
        }
        return { ...locker, active_order: activeOrder };
      });
    } else {
      return jsonData.lockers.map(locker => {
        const activeOrder = locker.active_order_id 
          ? jsonData.orders.find(o => o.id === locker.active_order_id) 
          : null;
        return { ...locker, active_order: activeOrder || null };
      });
    }
  },

  getLocker(id) {
    id = Number(id);
    if (useSqlite) {
      const locker = dbInstance.prepare('SELECT * FROM lockers WHERE id = ?').get(id);
      if (!locker) return null;
      let activeOrder = null;
      if (locker.active_order_id) {
        activeOrder = dbInstance.prepare('SELECT * FROM orders WHERE id = ?').get(locker.active_order_id);
      }
      return { ...locker, active_order: activeOrder };
    } else {
      const locker = jsonData.lockers.find(l => l.id === id);
      if (!locker) return null;
      const activeOrder = locker.active_order_id 
        ? jsonData.orders.find(o => o.id === locker.active_order_id) 
        : null;
      return { ...locker, active_order: activeOrder || null };
    }
  },

  updateLocker(id, fields) {
    id = Number(id);
    if (useSqlite) {
      const keys = Object.keys(fields);
      if (keys.length === 0) return;
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => fields[k]);
      dbInstance.prepare(`UPDATE lockers SET ${setClause} WHERE id = ?`).run(...values, id);
    } else {
      const locker = jsonData.lockers.find(l => l.id === id);
      if (locker) {
        Object.assign(locker, fields);
        saveJson();
      }
    }
    return this.getLocker(id);
  },

  createOrder({ compartment_id, customer_name, customer_phone, order_notes, otp_shipper, otp_student }) {
    compartment_id = Number(compartment_id);
    const now = Date.now();
    if (useSqlite) {
      const stmt = dbInstance.prepare(`
        INSERT INTO orders (compartment_id, customer_name, customer_phone, order_notes, otp_shipper, otp_student, status, created_at, warning_45m_sent)
        VALUES (?, ?, ?, ?, ?, ?, 'WAITING_DELIVERY', ?, 0)
      `);
      const info = stmt.run(compartment_id, customer_name, customer_phone, order_notes || '', otp_shipper, otp_student, now);
      const orderId = Number(info.lastInsertRowid);

      // Cập nhật ngăn tủ
      this.updateLocker(compartment_id, {
        status: 'WAITING_DELIVERY',
        active_order_id: orderId
      });

      return dbInstance.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    } else {
      const nextId = jsonData.orders.length > 0 ? Math.max(...jsonData.orders.map(o => o.id)) + 1 : 1;
      const order = {
        id: nextId,
        compartment_id,
        customer_name,
        customer_phone,
        order_notes: order_notes || '',
        otp_shipper,
        otp_student,
        status: 'WAITING_DELIVERY',
        created_at: now,
        stored_at: null,
        completed_at: null,
        abandoned_at: null,
        warning_45m_sent: 0
      };
      jsonData.orders.push(order);
      this.updateLocker(compartment_id, {
        status: 'WAITING_DELIVERY',
        active_order_id: order.id
      });
      saveJson();
      return order;
    }
  },

  getOrderById(id) {
    id = Number(id);
    if (useSqlite) {
      return dbInstance.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
    } else {
      return jsonData.orders.find(o => o.id === id) || null;
    }
  },

  getActiveOrder(compartment_id) {
    compartment_id = Number(compartment_id);
    if (useSqlite) {
      return dbInstance.prepare(`
        SELECT * FROM orders 
        WHERE compartment_id = ? AND status IN ('WAITING_DELIVERY', 'STORED')
        ORDER BY id DESC LIMIT 1
      `).get(compartment_id) || null;
    } else {
      return jsonData.orders
        .filter(o => o.compartment_id === compartment_id && ['WAITING_DELIVERY', 'STORED'].includes(o.status))
        .sort((a, b) => b.id - a.id)[0] || null;
    }
  },

  findOrderByOtp(otp) {
    const cleanOtp = String(otp).trim();
    if (useSqlite) {
      // 1. Kiểm tra OTP Shipper trước (Đơn đang WAITING_DELIVERY)
      let order = dbInstance.prepare(`
        SELECT *, 'SHIPPER' as role FROM orders 
        WHERE otp_shipper = ? AND status = 'WAITING_DELIVERY'
        LIMIT 1
      `).get(cleanOtp);

      if (order) return { order, role: 'SHIPPER' };

      // 2. Kiểm tra OTP Sinh viên (Đơn đang STORED)
      order = dbInstance.prepare(`
        SELECT *, 'STUDENT' as role FROM orders 
        WHERE otp_student = ? AND status = 'STORED'
        LIMIT 1
      `).get(cleanOtp);

      if (order) return { order, role: 'STUDENT' };

      return null;
    } else {
      const shipperOrder = jsonData.orders.find(o => o.otp_shipper === cleanOtp && o.status === 'WAITING_DELIVERY');
      if (shipperOrder) return { order: shipperOrder, role: 'SHIPPER' };

      const studentOrder = jsonData.orders.find(o => o.otp_student === cleanOtp && o.status === 'STORED');
      if (studentOrder) return { order: studentOrder, role: 'STUDENT' };

      return null;
    }
  },

  updateOrder(id, fields) {
    id = Number(id);
    if (useSqlite) {
      const keys = Object.keys(fields);
      if (keys.length === 0) return;
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = keys.map(k => fields[k]);
      dbInstance.prepare(`UPDATE orders SET ${setClause} WHERE id = ?`).run(...values, id);
      return this.getOrderById(id);
    } else {
      const order = jsonData.orders.find(o => o.id === id);
      if (order) {
        Object.assign(order, fields);
        saveJson();
      }
      return order;
    }
  },

  getActiveStoredOrders() {
    if (useSqlite) {
      return dbInstance.prepare("SELECT * FROM orders WHERE status = 'STORED'").all();
    } else {
      return jsonData.orders.filter(o => o.status === 'STORED');
    }
  },

  getOrderHistory(limit = 30) {
    if (useSqlite) {
      return dbInstance.prepare(`
        SELECT * FROM orders 
        WHERE status IN ('COMPLETED', 'ABANDONED', 'STORED', 'WAITING_DELIVERY')
        ORDER BY id DESC LIMIT ?
      `).all(limit);
    } else {
      return [...jsonData.orders]
        .reverse()
        .slice(0, limit);
    }
  },

  resetAllLockers() {
    const now = Date.now();
    if (useSqlite) {
      dbInstance.prepare(`
        UPDATE orders SET status = 'CANCELLED', completed_at = ?
        WHERE status IN ('WAITING_DELIVERY', 'STORED')
      `).run(now);

      dbInstance.prepare(`
        UPDATE lockers SET status = 'AVAILABLE', door_state = 'CLOSED', item_state = 'EMPTY', active_order_id = NULL
      `).run();
    } else {
      jsonData.orders.forEach(o => {
        if (['WAITING_DELIVERY', 'STORED'].includes(o.status)) {
          o.status = 'CANCELLED';
          o.completed_at = now;
        }
      });
      jsonData.lockers.forEach(l => {
        l.status = 'AVAILABLE';
        l.door_state = 'CLOSED';
        l.item_state = 'EMPTY';
        l.active_order_id = null;
      });
      saveJson();
    }
    return this.getLockers();
  }
};

module.exports = db;
