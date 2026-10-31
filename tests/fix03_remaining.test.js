const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const admin = 'test-admin-key-1234567890';
const device = 'test-device-key-1234567890';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startServer(t, triggerInternalError = false) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'locker-fix03-rest-'));
  for (const filename of ['server.js', 'db.js', 'package.json']) {
    fs.copyFileSync(path.join(root, filename), path.join(work, filename));
  }
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(work, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(work, 'public'));

  if (triggerInternalError) {
    const serverFile = path.join(work, 'server.js');
    const anchor = "app.listen(PORT, '0.0.0.0', () => {";
    const source = fs.readFileSync(serverFile, 'utf8');
    assert.ok(source.includes(anchor), 'Cannot install test-only fault injection');
    // Modify ONLY the temporary copy to trigger an unexpected server error.
    // The real server.js and real database remain untouched.
    fs.writeFileSync(serverFile, source.replace(anchor,
      "db.getLockers = () => { throw new Error('PRIVATE_INTERNAL_ERROR_TOKEN'); };\n" + anchor));
  }

  const port = await freePort();
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
      await new Promise(resolve => { proc.once('close', resolve); proc.kill(); });
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error('Server exited: ' + logs);
    try {
      const response = await fetch(url + '/api/system/info');
      if (response.ok) return url;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error('Server not ready: ' + logs);
}

async function expectJsonResponse(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') || '', /application\/json/i);
  const data = await response.json();
  assert.equal(data.success, false);
  assert.equal(typeof data.message, 'string');
  return data;
}

test('FIX 03 remaining: invalid and oversized JSON yield JSON errors without mutation', async t => {
  const url = await startServer(t);
  const invalid = await fetch(url + '/api/lockers/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"compartment_id":1,'
  });
  await expectJsonResponse(invalid, 400);

  const oversized = await fetch(url + '/api/lockers/book', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compartment_id: 1, order_notes: 'X'.repeat(150000) })
  });
  await expectJsonResponse(oversized, 413);

  const stateResponse = await fetch(url + '/api/lockers', {
    headers: { 'X-Admin-Key': admin }
  });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.ok(state.lockers.every(l => l.status === 'AVAILABLE'));
});

test('FIX 03 remaining: unexpected server error is JSON and does not disclose internals', async t => {
  const url = await startServer(t, true);
  const response = await fetch(url + '/api/lockers', {
    headers: { 'X-Admin-Key': admin }
  });
  const result = await expectJsonResponse(response, 500);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INTERNAL_ERROR_TOKEN|stack|node_modules/i);
});

test('FIX 03 remaining: dashboard safely escapes interpolated HTML values', () => {
  const elements = new Map();
  function getElement(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        innerHTML: '', textContent: '', className: '', style: {},
        classList: { add() {}, remove() {}, replace() {} }
      });
    }
    return elements.get(id);
  }
  const sandbox = {
    window: { location: { pathname: '/admin' } },
    document: { addEventListener() {}, getElementById: getElement },
    console, setInterval() {}, setTimeout() {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8'), sandbox,
    { filename: 'public/app.js' });

  const payload = '<img src=x onerror=alert(1)>';
  const order = {
    id: payload, compartment_id: payload, customer_name: payload,
    customer_phone: payload, student_id: payload, order_notes: payload,
    otp_shipper: payload, otp_student: payload, status: 'COMPLETED',
    created_at: Date.now(), completed_at: Date.now()
  };
  sandbox.renderHistoryTable([order]);
  const historyHtml = getElement('history-table-body').innerHTML;
  assert.ok(historyHtml.includes('&lt;img'), 'Escaped history payload missing');
  assert.ok(!historyHtml.includes(payload), 'Unescaped payload in history table');

  const locker = {
    id: 1, status: 'STORED', door_state: 'CLOSED', item_state: 'DETECTED',
    active_order: order,
    sla: {
      is_tracking: true, elapsed_seconds: 30, remaining_seconds: 60,
      percent: 12, stage: 'SAFE', message: payload
    }
  };
  sandbox.renderDashboardTab([locker]);
  const dashboardHtml = getElement('dash-order-info-1').innerHTML;
  assert.ok(dashboardHtml.includes('&lt;img'), 'Escaped dashboard payload missing');
  assert.ok(!dashboardHtml.includes(payload), 'Unescaped payload in dashboard');

  sandbox.renderBookingTab([{ ...locker, status: 'WAITING_DELIVERY' }]);
  const waitingHtml = getElement('order-box-1').innerHTML;
  assert.ok(!waitingHtml.includes(payload), 'Unescaped payload in booking waiting state');

  sandbox.renderBookingTab([locker]);
  const storedHtml = getElement('order-box-1').innerHTML;
  assert.ok(!storedHtml.includes(payload), 'Unescaped payload in booking stored state');
});