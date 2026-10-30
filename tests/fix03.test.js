
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const admin = 'test-admin-key-1234567890';
const device = 'test-device-key-1234567890';

async function getFreePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(t) {
  // Use temporary data, never the real database.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-fix03-'));

  for (const file of ['server.js', 'db.js', 'package.json']) {
    fs.copyFileSync(path.join(root, file), path.join(work, file));
  }

  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(work, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );

  fs.mkdirSync(path.join(work, 'public'));

  const port = await getFreePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: work,
    env: {
      ...process.env,
      PORT: String(port),
      SMARTLOCKER_ADMIN_KEY: admin,
      SMARTLOCKER_DEVICE_KEY: device
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  proc.stdout.on('data', chunk => { logs += chunk.toString(); });
  proc.stderr.on('data', chunk => { logs += chunk.toString(); });

  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      await new Promise(resolve => {
        proc.once('close', resolve);
        proc.kill();
      });
    }
    fs.rmSync(work, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    });
  });

  const url = `http://127.0.0.1:${port}`;

  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) {
      throw new Error('Server exited: ' + logs);
    }
    try {
      const response = await fetch(`${url}/api/system/info`);
      if (response.ok) return url;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 70));
  }

  throw new Error('Server not ready: ' + logs);
}

test('FIX 03: reject invalid booking fields without database changes', async t => {
  const url = await startServer(t);

  const invalidCases = [
    ['customer_name', { invalid: true }],
    ['customer_phone', 901234567],
    ['student_id', { invalid: true }],
    ['order_notes', ['invalid']]
  ];

  for (const [field, value] of invalidCases) {
    const body = {
      compartment_id: 1,
      customer_name: 'Demo',
      customer_phone: '0901234567',
      student_id: 'SV001',
      order_notes: 'Test',
      [field]: value
    };

    const response = await fetch(`${url}/api/lockers/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert.equal(response.status, 400, `${field} must return HTTP 400`);

    const result = await response.json();
    assert.equal(result.success, false);

    const lockerResponse = await fetch(`${url}/api/lockers`, {
      headers: { 'X-Admin-Key': admin }
    });
    const lockerData = await lockerResponse.json();
    const locker = lockerData.lockers.find(l => l.id === 1);

    assert.equal(locker.status, 'AVAILABLE');
  }
});


test('FIX 03: reject invalid phone and oversized booking fields', async t => {
  const url = await startServer(t);

  const invalidCases = [
    ['invalid phone', { customer_phone: '09012abc67' }],
    ['blank phone', { customer_phone: '   ' }],
    ['long phone', { customer_phone: '0'.repeat(30) }],
    ['long name', { customer_name: 'A'.repeat(201) }],
    ['long student ID', { student_id: 'S'.repeat(101) }],
    ['long notes', { order_notes: 'N'.repeat(1001) }]
  ];

  for (const [name, fields] of invalidCases) {
    const body = {
      compartment_id: 1,
      customer_name: 'Demo',
      customer_phone: '0901234567',
      student_id: 'SV001',
      order_notes: 'Test',
      ...fields
    };

    const response = await fetch(`${url}/api/lockers/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    assert.equal(response.status, 400, name + ' must return 400');

    const result = await response.json();
    assert.equal(result.success, false);

    const state = await fetch(`${url}/api/lockers`, {
      headers: { 'X-Admin-Key': admin }
    });

    const data = await state.json();
    const locker = data.lockers.find(l => l.id === 1);
    assert.equal(locker.status, 'AVAILABLE', name + ' must not change locker');
  }
});


test('FIX 03: reject invalid compartment IDs without mutation', async t => {
  const url = await startServer(t);

  const invalidIds = [
    true,
    [1],
    '01',
    '1.0',
    0,
    3,
    1.5,
    null,
    {}
  ];

  for (const id of invalidIds) {
    const response = await fetch(`${url}/api/lockers/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compartment_id: id,
        customer_name: 'Demo',
        customer_phone: '0901234567'
      })
    });

    assert.equal(
      response.status,
      400,
      `Invalid compartment_id ${JSON.stringify(id)} must return 400`
    );

    const state = await fetch(`${url}/api/lockers`, {
      headers: { 'X-Admin-Key': admin }
    });

    const data = await state.json();

    for (const locker of data.lockers) {
      assert.equal(locker.status, 'AVAILABLE');
    }
  }
});


test('FIX 03: sensor-sync rejects invalid input without mutation', async t => {
  const url = await startServer(t);

  const invalidCases = [
    ['invalid compartment', {
      compartment_id: 3,
      door_state: 'CLOSED'
    }],
    ['invalid compartment type', {
      compartment_id: true,
      door_state: 'OPEN'
    }],
    ['invalid door state', {
      compartment_id: 1,
      door_state: 'BROKEN'
    }],
    ['invalid item state', {
      compartment_id: 1,
      item_state: 'UNKNOWN'
    }],
    ['missing sensor values', {
      compartment_id: 1
    }]
  ];

  async function getLocker() {
    const response = await fetch(`${url}/api/lockers`, {
      headers: { 'X-Admin-Key': admin }
    });
    const data = await response.json();
    return data.lockers.find(l => l.id === 1);
  }

  const before = await getLocker();

  for (const [name, body] of invalidCases) {
    const response = await fetch(`${url}/api/locker/sensor-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Key': device
      },
      body: JSON.stringify(body)
    });

    assert.equal(response.status, 400, name + ' must return 400');

    const after = await getLocker();

    assert.equal(after.status, before.status);
    assert.equal(after.door_state, before.door_state);
    assert.equal(after.item_state, before.item_state);
    assert.equal(after.active_order_id, before.active_order_id);
  }
});


test('FIX 03: reject invalid fast-forward minutes without mutation', async t => {
  const url = await startServer(t);

  async function post(endpoint, body, headers = {}) {
    const response = await fetch(url + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body)
    });

    return {
      code: response.status,
      json: await response.json()
    };
  }

  async function getLocker() {
    const response = await fetch(url + '/api/lockers', {
      headers: { 'X-Admin-Key': admin }
    });
    const data = await response.json();
    return data.lockers.find(l => l.id === 1);
  }

  // Create an order and move it to STORED legitimately.
  const booking = await post('/api/lockers/book', {
    compartment_id: 1,
    customer_name: 'Demo',
    customer_phone: '0901234567'
  });

  assert.equal(booking.code, 201);

  const verified = await post('/api/locker/verify-otp', {
    otp: booking.json.otp_shipper
  }, { 'X-Device-Key': device });

  assert.equal(verified.json.status, 'SUCCESS');

  const delivered = await post('/api/locker/update-status', {
    compartment_id: 1,
    event: 'ITEM_STORED',
    door_state: 'CLOSED',
    item_state: 'DETECTED'
  }, { 'X-Device-Key': device });

  assert.equal(delivered.code, 200);

  const before = await getLocker();
  assert.equal(before.status, 'STORED');
  const originalStoredAt = before.active_order.stored_at;

  const invalidMinutes = [
    'abc',
    -5,
    0,
    1.5,
    true,
    {},
    1000000
  ];

  for (const minutes of invalidMinutes) {
    const result = await post('/api/simulate/fast-forward', {
      compartment_id: 1,
      minutes
    }, { 'X-Admin-Key': admin });

    assert.equal(
      result.code,
      400,
      `Invalid minutes ${JSON.stringify(minutes)} must return 400`
    );

    const after = await getLocker();
    assert.equal(after.status, 'STORED');
    assert.equal(after.active_order.stored_at, originalStoredAt);
  }
});

