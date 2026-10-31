'use strict';
// FIX04: inspect integration of ESP32 firmware and execute the standalone C++
// sensor policy on host if a C++ compiler is available. NOT ESP32 hardware tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const fwDir = path.join(__dirname, '..', 'firmware', 'SmartLocker_ESP32');
const firmware = fs.readFileSync(path.join(fwDir, 'SmartLocker_ESP32.ino'), 'utf8');
const header = fs.readFileSync(path.join(fwDir, 'Fix04DoorCycle.h'), 'utf8');

function functionBody(name) {
  const regex = new RegExp(`(?:void|Fix04PostResult)\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const match = regex.exec(firmware);
  assert.ok(match, `Missing function ${name}`);
  return firmware.slice(match.index, firmware.indexOf('\n}', match.index) + 2);
}

test('FIX04: OTP success requires HTTP 200, role 1/2 and valid role before unlock', () => {
  const f = functionBody('verifyOtpWithServer');
  assert.match(f, /code != 200 \|\| parseError/);
  assert.match(f, /role != "SHIPPER" && role != "STUDENT"/);
  assert.match(f, /compId != 1 && compId != 2/);
  assert.ok(f.indexOf('const int compId') < f.indexOf('triggerSolenoidUnlock(compId)'));
  assert.ok(f.indexOf('fix04DoorCycle.begin(millis())') < f.indexOf('triggerSolenoidUnlock(compId)'));
});

test('FIX04: event POST checks true JSON success and expected locker_status', () => {
  const f = functionBody('updateLockerStatusToServer');
  assert.match(f, /code == 200 && !parseError && \(result\["success"\] \| false\)/);
  assert.match(f, /result\["locker_status"\]/);
  assert.match(f, /code >= 400 && code < 500/);
  assert.match(f, /FIX04_STOP/);
  assert.match(f, /FIX04_RETRY/);
  assert.doesNotMatch(f, /code > 0\)\s*\{\s*Serial\.printf\("\[API\] Cap nhat thanh cong/);
});

test('FIX04: door cycle and ACK-gated state machine, never success on failed send', () => {
  const f = functionBody('handleSensorStateMachine');
  assert.match(f, /fix04DoorCycle\.observe\(mc38Value == HIGH, expectedItem, now\)/);
  assert.match(f, /currentState = STATE_PENDING_UPDATE/);
  assert.match(f, /result == FIX04_ACK/);
  assert.match(f, /result == FIX04_STOP/);
  assert.match(f, /mc38Value != LOW \|\| \(isDeposit \? e18Value != LOW : e18Value != HIGH\)/);
  assert.match(f, /currentState = STATE_NEEDS_ATTENTION/);
  assert.ok(f.indexOf('result == FIX04_ACK') < f.indexOf('showMessageAndPause(isDeposit'));
  assert.match(f, /now - fix04LastPostAttempt/);
});

test('FIX04: WiFi reconnect retains pending transition and relay pin mapping is unchanged', () => {
  assert.match(functionBody('checkWiFiConnection'), /WiFi\.reconnect\(\)/);
  assert.doesNotMatch(functionBody('checkWiFiConnection'), /WiFi\.disconnect\(/);
  assert.match(firmware, /#define PIN_RELAY_1\s+18/);
  assert.match(firmware, /#define PIN_RELAY_2\s+19/);
  assert.match(firmware, /#define PIN_SENSOR_E18\s+25/);
  assert.match(firmware, /#define PIN_SENSOR_MC38\s+26/);
  assert.match(firmware, /const unsigned long SOLENOID_PULSE_MS = 800/);
  assert.match(functionBody('triggerSolenoidUnlock'), /delay\(SOLENOID_PULSE_MS\)/);
  assert.match(header, /class DoorCycle/);
});

const cppSource = String.raw`
#include <cassert>
#include <cstdint>
#include "Fix04DoorCycle.h"
using smartlocker::DoorCycle;
int main() {
  DoorCycle cycle;
  cycle.begin(0);
  assert(!cycle.observe(false, true, 0));
  assert(!cycle.observe(false, true, 5000));   // closed + item never enough
  assert(!cycle.observe(true, true, 5001));
  assert(!cycle.observe(true, true, 5300));
  assert(!cycle.observe(false, true, 5310));  // open bounced under 400ms
  assert(!cycle.observe(true, true, 6000));
  assert(!cycle.observe(true, true, 6400));   // open confirmed
  assert(!cycle.observe(false, false, 6500)); // expected item wrong
  assert(!cycle.observe(false, true, 6600));
  assert(!cycle.observe(false, true, 6999));
  assert(cycle.observe(false, true, 7000));    // closed + correct item 400ms

  cycle.begin(10000);                          // new OTP resets debounce
  assert(!cycle.observe(false, true, 10000));
  assert(!cycle.observe(true, true, 10001));
  assert(!cycle.observe(true, true, 10401));
  assert(!cycle.observe(false, true, 10402));
  assert(!cycle.observe(true, true, 10500));  // reopen cancels close debounce
  assert(!cycle.observe(false, true, 10600));
  assert(cycle.observe(false, true, 11000));

  cycle.begin(UINT32_MAX - 200);
  assert(!cycle.observe(true, false, UINT32_MAX - 200));
  assert(!cycle.observe(true, false, 199));    // handles millis overflow (400ms)
  assert(!cycle.observe(false, true, 200));
  assert(cycle.observe(false, true, 600));

  cycle.begin(0);
  assert(!cycle.observe(true, true, 10));
  assert(!cycle.observe(true, true, 410));
  assert(!cycle.observe(false, true, 420));
  assert(!cycle.observe(false, false, 800)); // item bounced -> timer resets
  assert(!cycle.observe(false, true, 900));
  assert(!cycle.observe(false, true, 1299));
  assert(cycle.observe(false, true, 1300));
  return 0;
}
`;

test('FIX04: native C++ debounce policy handles door, item bounce, reset and millis overflow', (t) => {
  const compiler = cp.spawnSync('g++', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (compiler.error || compiler.status !== 0) {
    t.skip('g++ not installed; native policy not compiled here (ESP32 hardware still untested).');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartlocker-fix04-'));
  try {
    const source = path.join(dir, 'test.cpp');
    const binary = path.join(dir, process.platform === 'win32' ? 'test.exe' : 'test');
    fs.writeFileSync(source, cppSource);
    const build = cp.spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', '-I', fwDir, source, '-o', binary], { encoding: 'utf8', timeout: 20000 });
    assert.equal(build.status, 0, build.stderr || build.error?.message);
    const run = cp.spawnSync(binary, [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
