#ifndef SMARTLOCKER_FIX04_DOOR_CYCLE_H
#define SMARTLOCKER_FIX04_DOOR_CYCLE_H

// Hardware-independent sensor policy, testable with a desktop C++ compiler.
// Only the ESP32 sketch knows which GPIO maps to door/item observations.
#include <stdint.h>

namespace smartlocker {
class DoorCycle {
 public:
  static const uint32_t kStableMs = 400;

  DoorCycle() { begin(0); }

  void begin(uint32_t /*now*/) {
    phase_ = WaitForOpen;
    hasOpenCandidate_ = false;
    hasClosedCandidate_ = false;
    openSince_ = 0;
    closedSince_ = 0;
  }

  // A completion requires: door OPEN stable for 400 ms, then door CLOSED
  // and correct item observation stable together for 400 ms.
  bool observe(bool doorOpen, bool expectedItemSeen, uint32_t now) {
    if (phase_ == Ready) return true;
    if (phase_ == WaitForOpen) {
      if (!doorOpen) {
        hasOpenCandidate_ = false;
        return false;
      }
      if (!hasOpenCandidate_) {
        hasOpenCandidate_ = true;
        openSince_ = now;
        return false;
      }
      if (static_cast<uint32_t>(now - openSince_) >= kStableMs) {
        phase_ = WaitForClose;
      }
      return false;
    }
    if (doorOpen || !expectedItemSeen) {
      hasClosedCandidate_ = false;
      return false;
    }
    if (!hasClosedCandidate_) {
      hasClosedCandidate_ = true;
      closedSince_ = now;
      return false;
    }
    if (static_cast<uint32_t>(now - closedSince_) >= kStableMs) {
      phase_ = Ready;
      return true;
    }
    return false;
  }

 private:
  enum Phase { WaitForOpen, WaitForClose, Ready };
  Phase phase_;
  bool hasOpenCandidate_;
  bool hasClosedCandidate_;
  uint32_t openSince_;
  uint32_t closedSince_;
};
}  // namespace smartlocker

#endif
