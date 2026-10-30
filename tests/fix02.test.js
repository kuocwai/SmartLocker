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
const deviceHeaders = { 'X-Device-Key': device };
const adminHeaders = { 'X-Admin-Key': admin };

async function getFreePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(t) {
  // Isolated data directory: tests never modify the user's real locker data.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-fix02-'));
  for (const file of ['server.js', 'db.js', 'package.json']) {
    fs.copyFileSync(path.join(root, file), path.join(work, file));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(work, 'public'));
  const port = await getFreePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: work,
    env: { ...process.env, PORT: String(port), SMARTLOCKER_ADMIN_KEY: admin, SMARTLOCKER_DEVICE_KEY: device },
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
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error('Server exited: ' + logs);
    try {
      const response = await fetch(`${url}/api/system/info`);
      if (response.ok) return url;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error('Server not ready: ' + logs);
}

async function request(url, endpoint, body, headers = deviceHeaders) {
  const response = await fetch(url + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { code: response.status, json: await response.json() };
}
const event = (compartment_id, name, door_state, item_state) => ({ compartment_id, event: name, door_state, item_state });
const stored = id => event(id, 'ITEM_STORED', 'CLOSED', 'DETECTED');
const picked = id => event(id, 'ITEM_PICKED', 'CLOSED', 'EMPTY');

async function locker(url, id = 1) {
  const state = await request(url, '/api/lockers', undefined, adminHeaders);
  return state.json.lockers.find(l => l.id === id);
}

test('FIX 02: deny fabricated, wrong-role and duplicate events; allow correct OTP workflow', async t => {
  const url = await startServer(t);
  const invalidDeposit = await request(url, '/api/locker/update-status', stored(1));
  assert.equal(invalidDeposit.code, 409);
  assert.equal((await locker(url)).status, 'AVAILABLE');

  const created = await request(url, '/api/lockers/book', {
    compartment_id: 1, customer_name: 'Demo', customer_phone: '0901234567'
  }, {});
  assert.equal(created.code, 201);
  assert.equal((await request(url, '/api/locker/update-status', stored(1))).code, 403);
  assert.equal((await request(url, '/api/locker/update-status', picked(1))).code, 409);
  assert.equal((await locker(url)).status, 'WAITING_DELIVERY');

  const shipper = await request(url, '/api/locker/verify-otp', { otp: created.json.otp_shipper });
  assert.equal(shipper.json.role, 'SHIPPER');
  assert.equal((await request(url, '/api/locker/update-status', picked(1))).code, 409);
  assert.equal((await request(url, '/api/locker/update-status', stored(2))).code, 409);
  assert.equal((await request(url, '/api/locker/update-status', event(1, 'ITEM_STORED', 'OPEN', 'DETECTED'))).code, 400);
  assert.equal((await request(url, '/api/locker/update-status', event(1, 'ITEM_STORED', 'CLOSED', 'EMPTY'))).code, 400);
  assert.equal((await locker(url)).status, 'WAITING_DELIVERY');

  assert.equal((await request(url, '/api/locker/update-status', stored(1))).code, 200);
  assert.equal((await locker(url)).status, 'STORED');
  assert.equal((await request(url, '/api/locker/update-status', stored(1))).code, 409);
  assert.equal((await request(url, '/api/locker/update-status', picked(1))).code, 403);
  assert.equal((await locker(url)).status, 'STORED');

  const student = await request(url, '/api/locker/verify-otp', { otp: created.json.otp_student });
  assert.equal(student.json.role, 'STUDENT');
  assert.equal((await request(url, '/api/locker/update-status', stored(1))).code, 409);
  assert.equal((await request(url, '/api/locker/update-status', picked(1))).code, 200);
  const finalLocker = await locker(url);
  assert.equal(finalLocker.status, 'AVAILABLE');
  assert.equal(finalLocker.active_order_id, null);
  assert.equal((await request(url, '/api/locker/update-status', picked(1))).code, 409);
});

test('FIX 02: reject invalid event, compartment and sensor state without mutation', async t => {
  const url = await startServer(t);
  assert.equal((await request(url, '/api/locker/update-status', { compartment_id: 99, event: 'SENSOR_SYNC' })).code, 400);
  assert.equal((await request(url, '/api/locker/sensor-sync', { compartment_id: 99, door_state: 'OPEN' })).code, 400);
  assert.equal((await request(url, '/api/locker/update-status', { compartment_id: 1, event: 'SOMETHING_ELSE' })).code, 400);
  assert.equal((await request(url, '/api/locker/update-status', { compartment_id: 1, event: 'SENSOR_SYNC', door_state: 'WRONG' })).code, 400);
  assert.equal((await request(url, '/api/locker/sensor-sync', { compartment_id: 1, item_state: 'WRONG' })).code, 400);
  assert.equal((await locker(url)).status, 'AVAILABLE');
  assert.equal((await request(url, '/api/locker/sensor-sync', { compartment_id: 1, door_state: 'OPEN' })).code, 200);
  assert.equal((await locker(url)).door_state, 'OPEN');
});
