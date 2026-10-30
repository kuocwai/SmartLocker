const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

// Persistent storage selection is sticky: never silently move an existing data set.
// In production, an ambiguous or unreadable store fails closed (no automatic reset).
const dataDir = path.resolve(process.env.SMARTLOCKER_DATA_DIR || path.join(__dirname, 'data'));
const requestedMode = String(process.env.SMARTLOCKER_DB_MODE || 'auto').toLowerCase();
if (!['auto', 'sqlite', 'json'].includes(requestedMode)) throw Error('[DB] Invalid SMARTLOCKER_DB_MODE');
fs.mkdirSync(dataDir, { recursive: true });
const sqliteFile = path.join(dataDir, 'smartlocker.db');
const jsonFile = path.join(dataDir, 'smartlocker.json');
const sqliteExists = fs.existsSync(sqliteFile);
const jsonExists = fs.existsSync(jsonFile);
if (requestedMode === 'auto' && sqliteExists && jsonExists) {
  throw Error('[DB] Both SQLite and JSON data stores exist. Select SMARTLOCKER_DB_MODE explicitly after manual verification; no automatic migration.');
}
if (requestedMode === 'json' && sqliteExists && !jsonExists) throw Error('[DB] Existing SQLite database cannot be silently replaced with a new JSON store');
if (requestedMode === 'sqlite' && jsonExists && !sqliteExists) throw Error('[DB] Existing JSON database cannot be silently replaced with a new SQLite store');
let Database = null;
let sqliteUnavailable = null;
try { Database = require('better-sqlite3'); } catch (err) { sqliteUnavailable = err; }
const useSqlite = requestedMode === 'sqlite' || (requestedMode === 'auto' && (sqliteExists || (!jsonExists && Boolean(Database))));
if (useSqlite && !Database) throw Error('[DB] SQLite data selected but better-sqlite3 unavailable: '+ sqliteUnavailable?.message);
let dbInstance = null;
if (useSqlite) {
  // Do not fall back to JSON on SQLite corruption/permission/initialization errors.
  dbInstance = new Database(sqliteFile);
  dbInstance.pragma('journal_mode = WAL');
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
      student_id TEXT,
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
  const columns = dbInstance.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
  if (!columns.includes('student_id')) dbInstance.exec('ALTER TABLE orders ADD COLUMN student_id TEXT');
  if (!columns.includes('warning_45m_sent')) dbInstance.exec('ALTER TABLE orders ADD COLUMN warning_45m_sent INTEGER DEFAULT 0');
  const count = dbInstance.prepare('SELECT COUNT(*) AS count FROM lockers').get().count;
  if (count === 0) {
    dbInstance.transaction(() => {
      const insert = dbInstance.prepare("INSERT INTO lockers (id, name, status, door_state, item_state, active_order_id) VALUES (?, ?, 'AVAILABLE', 'CLOSED', 'EMPTY', NULL)");
      insert.run(1, 'Ngăn 1 (Tầng trên)');
      insert.run(2, 'Ngăn 2 (Tầng dưới)');
    })();
  }
  // Existing data must be reviewed, never silently rewritten.
  const lockerIds = dbInstance.prepare('SELECT id FROM lockers ORDER BY id').all().map(row => row.id);
  if (lockerIds.length !== 2 || lockerIds[0] !== 1 || lockerIds[1] !== 2) throw Error('[DB] SQLite must have exactly lockers 1 and 2');
  const invalid = dbInstance.prepare("SELECT l.id FROM lockers l LEFT JOIN orders o ON o.id=l.active_order_id WHERE (l.active_order_id IS NULL AND l.status != 'AVAILABLE') OR (l.active_order_id IS NOT NULL AND (l.status = 'AVAILABLE' OR o.id IS NULL OR o.compartment_id != l.id OR o.status != l.status)) LIMIT 1").get();
  if (invalid) throw Error('[DB] Inconsistent SQLite locker/order references; manual recovery required');
  console.log('[DB] SQLite:', sqliteFile);
} else {
  console.log('[DB] JSON:', jsonFile);
}
const initialJson = () => ({
  lockers: [
    { id: 1, name: 'Ngăn 1 (Tầng trên)', status: 'AVAILABLE', door_state: 'CLOSED', item_state: 'EMPTY', active_order_id: null },
    { id: 2, name: 'Ngăn 2 (Tầng dưới)', status: 'AVAILABLE', door_state: 'CLOSED', item_state: 'EMPTY', active_order_id: null }
  ],
  orders: []
});
function validateJson(value) {
  if (!value || !Array.isArray(value.lockers) || !Array.isArray(value.orders)) throw Error('[DB] Invalid JSON store structure');
  if (value.lockers.length !== 2 || ![1,2].every(id => value.lockers.some(l => l && l.id === id))) throw Error('[DB] JSON must contain lockers 1 and 2');
  const ids = new Set();
  for (const order of value.orders) {
    if (!order || !Number.isSafeInteger(order.id) || order.id < 1 || ids.has(order.id) || ![1,2].includes(order.compartment_id) || !['WAITING_DELIVERY','STORED','COMPLETED','ABANDONED','CANCELLED'].includes(order.status) || !Number.isFinite(order.created_at) || typeof order.otp_shipper !== 'string' || typeof order.otp_student !== 'string') throw Error('[DB] Invalid JSON order record');
    ids.add(order.id);
  }
  for (const locker of value.lockers) {
    if (!['AVAILABLE','WAITING_DELIVERY','STORED','ABANDONED'].includes(locker.status) || !['OPEN','CLOSED'].includes(locker.door_state) || !['EMPTY','DETECTED'].includes(locker.item_state)) throw Error('[DB] Invalid JSON locker state');
    const active = locker.active_order_id;
    if (active == null) { if (locker.status !== 'AVAILABLE') throw Error('[DB] Active locker missing order'); continue; }
    const order = value.orders.find(o => o.id === active);
    if (locker.status === 'AVAILABLE' || !order || order.compartment_id !== locker.id || order.status !== locker.status) throw Error('[DB] Inconsistent JSON locker/order references');
  }
}
let jsonData = initialJson();
if (!useSqlite) {
  if (jsonExists) {
    // Corruption is fatal; NEVER fall back to an empty store on a parse error.
    jsonData = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    validateJson(jsonData);
  } else {
    saveJsonSnapshot(jsonData);
  }
}
function saveJsonSnapshot(next) {
  validateJson(next);
  const temp = path.join(dataDir, '.smartlocker-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', flush: true });
    fs.renameSync(temp, jsonFile);
  } catch (err) {
    try { fs.unlinkSync(temp); } catch (_) {}
    throw err;
  }
}
function commitJson(mutate) {
  const next = structuredClone(jsonData);
  const result = mutate(next);
  saveJsonSnapshot(next);
  jsonData = next;
  return result;
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
    const allowed = new Set(['status', 'door_state', 'item_state', 'active_order_id']);
    const keys = Object.keys(fields);
    if (keys.some(k => !allowed.has(k))) throw Error('[DB] Invalid locker update field');
    if (keys.length === 0) return this.getLocker(id);
    if (useSqlite) {
      const clause = keys.map(k => k + ' = ?').join(', ');
      const values = keys.map(k => fields[k]);
      dbInstance.prepare('UPDATE lockers SET ' + clause + ' WHERE id = ?').run(...values, id);
    } else {
      commitJson(next => {
        const locker = next.lockers.find(l => l.id === id);
        if (!locker) throw Error('[DB] Locker not found');
        Object.assign(locker, fields);
      });
    }
    return this.getLocker(id);
  },

  createOrder({ compartment_id, customer_name, customer_phone, student_id, order_notes, otp_shipper, otp_student }) {
    compartment_id = Number(compartment_id);
    const now = Date.now();
    const cleanStudentId = (student_id || '').trim().toUpperCase();
    const cleanCustomerName = (customer_name || 'Khách hàng ' + customer_phone).trim();
    if (useSqlite) {
      return dbInstance.transaction(() => {
        const current = dbInstance.prepare('SELECT status FROM lockers WHERE id=?').get(compartment_id);
        if (!current || current.status !== 'AVAILABLE') throw Error('[DB] Locker is not available');
        const info = dbInstance.prepare(`INSERT INTO orders (compartment_id, customer_name, customer_phone, student_id, order_notes, otp_shipper, otp_student, status, created_at, warning_45m_sent) VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING_DELIVERY', ?, 0)`).run(compartment_id, cleanCustomerName, customer_phone, cleanStudentId, order_notes || '', otp_shipper, otp_student, now);
        const orderId = Number(info.lastInsertRowid);
        dbInstance.prepare("UPDATE lockers SET status='WAITING_DELIVERY', active_order_id=? WHERE id=?").run(orderId, compartment_id);
        return dbInstance.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      })();
    }
    return commitJson(next => {
      const locker = next.lockers.find(l => l.id === compartment_id);
      if (!locker || locker.status !== 'AVAILABLE') throw Error('[DB] Locker is not available');
      const nextId = next.orders.reduce((max, o) => Math.max(max, o.id), 0) + 1;
      const order = { id: nextId, compartment_id, customer_name: cleanCustomerName, customer_phone, student_id: cleanStudentId, order_notes: order_notes || '', otp_shipper, otp_student, status: 'WAITING_DELIVERY', created_at: now, stored_at: null, completed_at: null, abandoned_at: null, warning_45m_sent: 0 };
      next.orders.push(order);
      locker.status = 'WAITING_DELIVERY';
      locker.active_order_id = order.id;
      return order;
    });
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
    const allowed = new Set(['status','created_at','stored_at','completed_at','abandoned_at','warning_45m_sent']);
    const keys = Object.keys(fields);
    if (keys.some(k => !allowed.has(k))) throw Error('[DB] Invalid order update field');
    if (keys.length === 0) return this.getOrderById(id);
    if (useSqlite) {
      const clause = keys.map(k => k + ' = ?').join(', ');
      dbInstance.prepare('UPDATE orders SET ' + clause + ' WHERE id = ?').run(...keys.map(k => fields[k]), id);
    } else {
      commitJson(next => {
        const order = next.orders.find(o => o.id === id);
        if (!order) throw Error('[DB] Order not found');
        Object.assign(order, fields);
      });
    }
    return this.getOrderById(id);
  },

  transitionOrderAndLocker(orderId, orderFields, compartmentId, lockerFields) {
    orderId = Number(orderId); compartmentId = Number(compartmentId);
    const orderKeys = Object.keys(orderFields), lockerKeys = Object.keys(lockerFields);
    const allowedOrder = new Set(['status','stored_at','completed_at','abandoned_at','warning_45m_sent']);
    const allowedLocker = new Set(['status','door_state','item_state','active_order_id']);
    if (orderKeys.some(k => !allowedOrder.has(k)) || lockerKeys.some(k => !allowedLocker.has(k))) throw Error('[DB] Invalid transition fields');
    if (useSqlite) {
      dbInstance.transaction(() => {
        const current = dbInstance.prepare('SELECT active_order_id FROM lockers WHERE id=?').get(compartmentId);
        if (!current || current.active_order_id !== orderId) throw Error('[DB] Active order mismatch');
        if (orderKeys.length) {
          const clause = orderKeys.map(k => k + ' = ?').join(', ');
          dbInstance.prepare('UPDATE orders SET ' + clause + ' WHERE id=?').run(...orderKeys.map(k => orderFields[k]), orderId);
        }
        if (lockerKeys.length) {
          const clause = lockerKeys.map(k => k + ' = ?').join(', ');
          dbInstance.prepare('UPDATE lockers SET ' + clause + ' WHERE id=?').run(...lockerKeys.map(k => lockerFields[k]), compartmentId);
        }
      })();
    } else {
      commitJson(next => {
        const locker = next.lockers.find(l => l.id === compartmentId);
        const order = next.orders.find(o => o.id === orderId);
        if (!locker || !order || locker.active_order_id !== orderId) throw Error('[DB] Active order mismatch');
        Object.assign(order, orderFields);
        Object.assign(locker, lockerFields);
      });
    }
  },

  getActiveStoredOrders() {
    if (useSqlite) {
      return dbInstance.prepare("SELECT o.* FROM orders o JOIN lockers l ON l.active_order_id=o.id AND l.id=o.compartment_id AND l.status='STORED' WHERE o.status='STORED'").all();
    } else {
      return jsonData.orders.filter(o => o.status === 'STORED' && jsonData.lockers.some(l => l.id === o.compartment_id && l.status === 'STORED' && l.active_order_id === o.id));
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
      dbInstance.transaction(() => {
        dbInstance.prepare("UPDATE orders SET status='CANCELLED', completed_at=? WHERE status IN ('WAITING_DELIVERY','STORED','ABANDONED')").run(now);
        dbInstance.prepare("UPDATE lockers SET status='AVAILABLE', door_state='CLOSED', item_state='EMPTY', active_order_id=NULL").run();
      })();
    } else {
      commitJson(next => {
        for (const order of next.orders) if (['WAITING_DELIVERY','STORED','ABANDONED'].includes(order.status)) { order.status = 'CANCELLED'; order.completed_at = now; }
        for (const locker of next.lockers) Object.assign(locker, { status: 'AVAILABLE', door_state: 'CLOSED', item_state: 'EMPTY', active_order_id: null });
      });
    }
    return this.getLockers();
  }
};

module.exports = db;
