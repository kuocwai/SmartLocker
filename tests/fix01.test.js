const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const admin = 'local-test-admin-key-long-enough';
const device = 'local-test-device-key-long-enough';
const adminHeaders = { 'X-Admin-Key': admin };
const deviceHeaders = { 'X-Device-Key': device };

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-fix01-'));
  for (const file of ['server.js', 'db.js', 'package.json']) fs.copyFileSync(path.join(root, file), path.join(work, file));
fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(work, 'public'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: work, env: { ...process.env, PORT: String(port), SMARTLOCKER_ADMIN_KEY: admin, SMARTLOCKER_DEVICE_KEY: device },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  proc.stdout.on('data', v => { logs += v.toString(); });
  proc.stderr.on('data', v => { logs += v.toString(); });
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
    if (proc.exitCode !== null) throw new Error('server exit: ' + logs);
    try {
      const r = await fetch(url + '/api/system/info');
      if (r.ok) return { url, getLog: () => logs };
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error('Server not ready: ' + logs);
}

async function jsonRequest(url, endpoint, opts = {}) {
  const res = await fetch(url + endpoint, {
    ...opts,
    headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  return { code: res.status, json: await res.json() };
}

test('Fix01: public responses redact OTP, admin/device authorization works', async t => {
  const { url, getLog } = await startServer(t);
  const created = await jsonRequest(url, '/api/lockers/book', {
    method: 'POST', body: { compartment_id: 1, customer_name: 'Demo Tester', customer_phone: '0901234567', order_notes: 'secret note' }
  });
  assert.equal(created.code, 201);
  const otp = created.json.otp_shipper;
  const { json: publicLockers } = await jsonRequest(url, '/api/lockers');
  const leaked = JSON.stringify(publicLockers);
  assert.equal(publicLockers.lockers[0].status, 'WAITING_DELIVERY');
  for (const field of [otp, created.json.otp_student, '0901234567', 'secret note', 'Demo Tester']) {
    assert.equal(leaked.includes(field), false, 'Public endpoint leaked ' + field);
  }
  const privateLockers = await jsonRequest(url, '/api/lockers', { headers: adminHeaders });
  assert.equal(privateLockers.json.lockers[0].active_order.otp_shipper, otp);
  assert.equal((await jsonRequest(url, '/api/orders/history')).code, 401);
  assert.equal((await jsonRequest(url, '/api/orders/history', { headers: adminHeaders })).code, 200);
  assert.equal((await jsonRequest(url, '/api/admin/check', { headers: { 'X-Admin-Key': 'wrong-key' } })).code, 401);
  assert.equal((await jsonRequest(url, '/api/admin/check', { headers: adminHeaders })).code, 200);

  for (const endpoint of ['/api/locker/update-status', '/api/locker/sensor-sync', '/api/locker/verify-otp']) {
    assert.equal((await jsonRequest(url, endpoint, { method: 'POST', body: { otp } })).code, 401, endpoint);
  }
  for (const endpoint of ['/api/lockers/reset', '/api/simulate/fast-forward']) {
    assert.equal((await jsonRequest(url, endpoint, { method: 'POST', body: { compartment_id: 1 } })).code, 401, endpoint);
  }
  const valid = await jsonRequest(url, '/api/locker/verify-otp', { method: 'POST', headers: deviceHeaders, body: { otp } });
  assert.equal(valid.json.status, 'SUCCESS');
  assert.equal(valid.json.role, 'SHIPPER');
  const master = await jsonRequest(url, '/api/locker/verify-otp', { method: 'POST', headers: deviceHeaders, body: { otp: '999999' } });
  assert.notEqual(master.json.status, 'SUCCESS');
  assert.equal(master.json.role, undefined);
  assert.equal(getLog().includes(otp), false, 'OTP must not be logged');
});

test('Fix01: SSE booking event never includes OTP/customer info', async t => {
  const { url } = await startServer(t);
  const stream = await fetch(url + '/api/events');
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const created = await jsonRequest(url, '/api/lockers/book', {
    method: 'POST', body: { compartment_id: 2, customer_name: 'Sensitive Name', customer_phone: '0900000000', order_notes: 'Private Notes' }
  });
  let buffer = '';
  for (let i = 0; i < 3; i++) {
    const result = await Promise.race([
      reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 1500))
    ]);
    buffer += Buffer.from(result.value || []).toString();
    if (buffer.includes('LOCKER_BOOKED')) break;
  }
  assert.ok(buffer.includes('LOCKER_BOOKED'));
  for (const secret of [created.json.otp_shipper, created.json.otp_student, 'Sensitive Name', '0900000000', 'Private Notes']) {
    assert.equal(buffer.includes(secret), false);
  }
  await reader.cancel();
});

test('Fix01: invalid OTP is rate-limited per IP', async t => {
  const { url } = await startServer(t);
  for (let n = 0; n < 10; n++) {
    const r = await jsonRequest(url, '/api/locker/verify-otp', {
      method: 'POST', headers: deviceHeaders, body: { otp: '000000' }
    });
    assert.equal(r.json.status, 'INVALID');
  }
  const blocked = await jsonRequest(url, '/api/locker/verify-otp', {
    method: 'POST', headers: deviceHeaders, body: { otp: '000000' }
  });
  assert.equal(blocked.code, 429);
});
