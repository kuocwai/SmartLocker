// ========================================================
// SMART FOOD & PARCEL LOCKER - FRONTEND CONTROLLER (app.js)
// ========================================================

let lockersState = [];
let currentBookingCompId = 1;
let currentShipperMessage = '';
let activeTab = 'booking';
let sseSource = null;

// Khởi chạy khi tài liệu sẵn sàng
document.addEventListener('DOMContentLoaded', () => {
  initSystem();
  setupSSE();
  fetchLockerData();
  fetchSystemInfo();
  fetchHistory();

  // Polling dự phòng mỗi 3 giây nếu SSE gặp sự cố
  setInterval(() => {
    fetchLockerData(false);
  }, 3000);

  // Cập nhật nhịp đếm SLA mỗi giây
  setInterval(updateLiveSlaTimers, 1000);
});

// ========================================================
// SYSTEM & REALTIME CONNECTION
// ========================================================

function initSystem() {
  console.log('[App] Khởi tạo hệ thống Smart Locker 2 Ngăn');
}

function setupSSE() {
  const indicator = document.getElementById('sse-indicator');
  const statusTxt = document.getElementById('sse-status');

  if (!!window.EventSource) {
    sseSource = new EventSource('/api/events');

    sseSource.onopen = () => {
      if (indicator) indicator.className = 'h-2 w-2 rounded-full bg-emerald-500';
      if (statusTxt) statusTxt.textContent = 'Realtime';
    };

    sseSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log('[SSE Event]', data.event);
        fetchLockerData(false);
        fetchHistory();
      } catch (err) {
        // Heartbeat or malformed
      }
    };

    sseSource.onerror = () => {
      if (indicator) indicator.className = 'h-2 w-2 rounded-full bg-amber-500';
      if (statusTxt) statusTxt.textContent = 'Polling';
    };
  }
}

async function fetchSystemInfo() {
  try {
    const res = await fetch('/api/system/info');
    const data = await res.json();
    if (data.success && data.local_ips.length > 0) {
      const ip = data.local_ips[0];
      const port = data.server_port || 3000;
      const el = document.getElementById('server-ip-text');
      if (el) el.textContent = `${ip}:${port}`;
    }
  } catch (err) {
    console.warn('[System] Không lấy được thông tin mạng:', err.message);
  }
}

// ========================================================
// DATA FETCHING & RENDERING
// ========================================================

async function fetchLockerData(showToastAlert = false) {
  try {
    const res = await fetch('/api/lockers');
    const data = await res.json();
    if (data.success) {
      lockersState = data.lockers;
      renderBookingTab(lockersState);
      renderDashboardTab(lockersState);
      renderSimulatorTab(lockersState);
      checkGlobalSLAWarnings(lockersState);
    }
  } catch (err) {
    console.error('[API Error] Lỗi tải dữ liệu tủ:', err.message);
  }
}

async function fetchHistory() {
  try {
    const res = await fetch('/api/orders/history');
    const data = await res.json();
    if (data.success) {
      renderHistoryTable(data.history);
    }
  } catch (err) {
    console.warn('[API Error] Lỗi tải lịch sử:', err.message);
  }
}

// ========================================================
// TAB 1: RENDER BOOKING PORTAL
// ========================================================

function renderBookingTab(lockers) {
  lockers.forEach(locker => {
    const id = locker.id;
    const card = document.getElementById(`locker-card-${id}`);
    const badge = document.getElementById(`badge-status-${id}`);
    const iconDoor = document.getElementById(`icon-door-${id}`);
    const descState = document.getElementById(`desc-state-${id}`);
    const txtDoor = document.getElementById(`txt-door-${id}`);
    const txtItem = document.getElementById(`txt-item-${id}`);
    const orderBox = document.getElementById(`order-box-${id}`);
    const btnBook = document.getElementById(`btn-book-${id}`);

    if (!card) return;

    // Reset state classes
    card.classList.remove('state-available', 'state-waiting', 'state-stored', 'state-abandoned');

    // Cảm biến
    txtDoor.textContent = locker.door_state === 'OPEN' ? 'Đang mở' : 'Đã đóng';
    txtDoor.className = locker.door_state === 'OPEN' ? 'text-amber-600 font-bold' : 'text-slate-800 font-bold';

    txtItem.textContent = locker.item_state === 'DETECTED' ? 'Có món ăn' : 'Trống';
    txtItem.className = locker.item_state === 'DETECTED' ? 'text-rose-600 font-bold' : 'text-slate-800 font-bold';

    if (locker.status === 'AVAILABLE') {
      card.classList.add('state-available');
      badge.textContent = 'TRỐNG (AVAILABLE)';
      badge.className = 'px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
      
      iconDoor.innerHTML = '<i class="fa-solid fa-door-closed text-emerald-500"></i>';
      descState.textContent = 'Ngăn sẵn sàng để đặt chỗ';
      descState.className = 'text-sm font-semibold text-emerald-800';

      orderBox.classList.add('hidden');
      btnBook.disabled = false;
      btnBook.className = 'w-full py-3.5 px-6 rounded-2xl font-bold text-white text-sm sm:text-base bg-emerald-600 hover:bg-emerald-700 shadow-md shadow-emerald-600/20 active:scale-[0.99] transition cursor-pointer flex items-center justify-center gap-2';
      btnBook.innerHTML = `<i class="fa-solid fa-plus-circle"></i><span>Đặt Ngăn Số ${id}</span>`;

    } else if (locker.status === 'WAITING_DELIVERY') {
      card.classList.add('state-waiting');
      badge.textContent = 'CHỜ SHIPPER (WAITING)';
      badge.className = 'px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-amber-100 text-amber-900 border border-amber-300';

      iconDoor.innerHTML = '<i class="fa-solid fa-motorcycle text-amber-500"></i>';
      descState.textContent = 'Đã đặt chỗ · Chờ Shipper nhập OTP cất món';
      descState.className = 'text-sm font-semibold text-amber-800';

      if (locker.active_order) {
        orderBox.classList.remove('hidden');
        const stId = locker.active_order.student_id ? ` (${escapeHtml(locker.active_order.student_id)})` : '';
        orderBox.innerHTML = `
          <div class="flex justify-between font-semibold text-slate-800">
            <span>Đơn #${locker.active_order.id}: ${escapeHtml(locker.active_order.customer_name)}${stId}</span>
            <span class="text-amber-700">Mã Shipper: <strong class="font-mono text-sm">${locker.active_order.otp_shipper}</strong></span>
          </div>
          <p class="text-slate-500">${escapeHtml(locker.active_order.order_notes || 'Không có ghi chú')}</p>
        `;
      }

      btnBook.disabled = true;
      btnBook.className = 'w-full py-3.5 px-6 rounded-2xl font-bold text-slate-400 text-sm sm:text-base bg-slate-200 cursor-not-allowed flex items-center justify-center gap-2';
      btnBook.innerHTML = `<i class="fa-solid fa-hourglass-half"></i><span>Đang Chờ Giao Hàng</span>`;

    } else if (locker.status === 'STORED') {
      card.classList.add('state-stored');
      badge.textContent = 'ĐÃ CÓ MÓN (STORED)';
      badge.className = 'px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-rose-100 text-rose-800 border border-rose-300';

      iconDoor.innerHTML = '<i class="fa-solid fa-bowl-food text-rose-500"></i>';
      descState.textContent = 'Món ăn đã được lưu trữ an toàn trong tủ';
      descState.className = 'text-sm font-semibold text-rose-800';

      if (locker.active_order) {
        orderBox.classList.remove('hidden');
        const stId = locker.active_order.student_id ? ` [${escapeHtml(locker.active_order.student_id)}]` : '';
        orderBox.innerHTML = `
          <div class="flex justify-between font-semibold text-slate-800">
            <span>Người nhận: ${escapeHtml(locker.active_order.customer_name)}${stId} (${locker.active_order.customer_phone})</span>
            <span class="text-emerald-700">Mã SV: <strong class="font-mono text-sm">${locker.active_order.otp_student}</strong></span>
          </div>
          <div class="flex justify-between items-center pt-1 border-t border-slate-200/60 mt-1">
            <span class="text-slate-500">Trạng thái an toàn SLA:</span>
            <span class="font-bold text-rose-600">${locker.sla ? locker.sla.message : 'Đang lưu trữ'}</span>
          </div>
        `;
      }

      btnBook.disabled = true;
      btnBook.className = 'w-full py-3.5 px-6 rounded-2xl font-bold text-slate-400 text-sm sm:text-base bg-slate-200 cursor-not-allowed flex items-center justify-center gap-2';
      btnBook.innerHTML = `<i class="fa-solid fa-lock"></i><span>Ngăn Đang Chứa Hàng</span>`;

    } else if (locker.status === 'ABANDONED') {
      card.classList.add('state-abandoned');
      badge.textContent = 'QUÁ HẠN (ABANDONED)';
      badge.className = 'px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-purple-100 text-purple-800 border border-purple-300';

      iconDoor.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-purple-600"></i>';
      descState.textContent = 'Quá hạn 120 phút · Tủ đã khóa để đảm bảo an toàn!';
      descState.className = 'text-sm font-semibold text-purple-800';

      orderBox.classList.remove('hidden');
      orderBox.innerHTML = `
        <div class="font-bold text-purple-900">MÓN ĂN BỊ QUÁ HẠN LƯU TRỮ</div>
        <p class="text-purple-700">Mã nhận hàng của sinh viên đã bị vô hiệu hóa để bảo đảm an toàn thực phẩm.</p>
      `;

      btnBook.disabled = true;
      btnBook.className = 'w-full py-3.5 px-6 rounded-2xl font-bold text-purple-700 text-sm sm:text-base bg-purple-100 border border-purple-300 cursor-not-allowed flex items-center justify-center gap-2';
      btnBook.innerHTML = `<i class="fa-solid fa-ban"></i><span>Đơn Bị Bỏ Quên</span>`;
    }
  });
}

// ==========================================
// TAB 2: RENDER LIVE DASHBOARD & SLA
// ==========================================

function renderDashboardTab(lockers) {
  lockers.forEach(locker => {
    const id = locker.id;
    const statusTxt = document.getElementById(`dash-status-${id}`);
    const badgeSla = document.getElementById(`dash-badge-sla-${id}`);
    const valDoor = document.getElementById(`dash-val-door-${id}`);
    const iconDoor = document.getElementById(`dash-icon-door-${id}`);
    const valItem = document.getElementById(`dash-val-item-${id}`);
    const iconItem = document.getElementById(`dash-icon-item-${id}`);
    const timeElapsed = document.getElementById(`dash-time-elapsed-${id}`);
    const timeRemaining = document.getElementById(`dash-time-remaining-${id}`);
    const progress = document.getElementById(`dash-progress-${id}`);
    const msgSla = document.getElementById(`dash-msg-sla-${id}`);
    const orderInfo = document.getElementById(`dash-order-info-${id}`);

    if (!statusTxt) return;

    statusTxt.textContent = locker.status;

    // Door sensor
    if (locker.door_state === 'OPEN') {
      valDoor.textContent = 'Đang mở cửa';
      valDoor.className = 'text-amber-600';
      iconDoor.className = 'fa-solid fa-door-open text-amber-500';
    } else {
      valDoor.textContent = 'Đã đóng kín';
      valDoor.className = 'text-slate-800';
      iconDoor.className = 'fa-solid fa-door-closed text-emerald-600';
    }

    // Item sensor
    if (locker.item_state === 'DETECTED') {
      valItem.textContent = 'Phát hiện có đồ';
      valItem.className = 'text-rose-600 font-bold';
      iconItem.className = 'fa-solid fa-box text-rose-500';
    } else {
      valItem.textContent = 'Ngăn trống';
      valItem.className = 'text-slate-600';
      iconItem.className = 'fa-solid fa-box-open text-slate-400';
    }

    // SLA Details
    const sla = locker.sla;
    if (sla && sla.is_tracking) {
      timeElapsed.textContent = formatDuration(sla.elapsed_seconds);
      timeRemaining.textContent = formatDuration(sla.remaining_seconds);
      progress.style.width = `${sla.percent}%`;
      msgSla.textContent = sla.message;

      if (sla.stage === 'SAFE') {
        badgeSla.textContent = 'AN TOÀN (0 - 45p)';
        badgeSla.className = 'px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800';
        progress.className = 'h-full bg-emerald-500 transition-all duration-500';
        msgSla.className = 'text-xs text-emerald-700 font-medium';
      } else if (sla.stage === 'WARNING') {
        badgeSla.textContent = 'CẢNH BÁO (45 - 120p)';
        badgeSla.className = 'px-3 py-1 rounded-full text-xs font-bold bg-amber-100 text-amber-800 animate-pulse';
        progress.className = 'h-full bg-amber-500 transition-all duration-500';
        msgSla.className = 'text-xs text-amber-800 font-bold';
      } else if (sla.stage === 'ABANDONED') {
        badgeSla.textContent = 'QUÁ HẠN (> 120p)';
        badgeSla.className = 'px-3 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-800';
        progress.className = 'h-full bg-rose-600 transition-all duration-500';
        msgSla.className = 'text-xs text-rose-800 font-bold';
      }
    } else if (locker.status === 'ABANDONED') {
      timeElapsed.textContent = '>= 02:00:00';
      timeRemaining.textContent = '00:00';
      progress.style.width = '100%';
      progress.className = 'h-full bg-purple-600';
      badgeSla.textContent = 'ĐÃ HỦY ĐƠN (120p)';
      badgeSla.className = 'px-3 py-1 rounded-full text-xs font-bold bg-purple-100 text-purple-800';
      msgSla.textContent = 'Món ăn đã quá hạn an toàn. Đã khóa tủ & vô hiệu hóa OTP.';
      msgSla.className = 'text-xs text-purple-800 font-semibold';
    } else {
      timeElapsed.textContent = '00:00:00';
      timeRemaining.textContent = '--:--';
      progress.style.width = '0%';
      badgeSla.textContent = 'Không theo dõi';
      badgeSla.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-500';
      msgSla.textContent = 'Chưa kích hoạt timer (Chờ Shipper bỏ đồ vào tủ)';
      msgSla.className = 'text-xs text-slate-400 italic';
    }

    // Order Info Box
    if (locker.active_order) {
      const o = locker.active_order;
      const stId = o.student_id ? ` [${escapeHtml(o.student_id)}]` : '';
      orderInfo.innerHTML = `
        <div class="flex justify-between items-center font-bold text-slate-800">
          <span>Đơn hàng #${o.id}</span>
          <span class="text-xs text-slate-400">${new Date(o.created_at).toLocaleTimeString('vi-VN')}</span>
        </div>
        <div><strong>Người nhận:</strong> ${escapeHtml(o.customer_name)}${stId} - ${escapeHtml(o.customer_phone)}</div>
        ${o.order_notes ? `<div><strong>Ghi chú:</strong> ${escapeHtml(o.order_notes)}</div>` : ''}
        <div class="pt-1.5 flex gap-2 font-mono text-[11px]">
          <span class="bg-amber-100 text-amber-900 px-2 py-0.5 rounded">Mã Shipper: <b>${o.otp_shipper}</b></span>
          <span class="bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded">Mã SV: <b>${o.otp_student}</b></span>
        </div>
      `;
    } else {
      orderInfo.innerHTML = '<em>Không có đơn hàng nào đang hoạt động.</em>';
    }
  });
}

function renderHistoryTable(orders) {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;

  if (!orders || orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center py-6 text-slate-400 italic">Chưa có lịch sử đơn hàng nào.</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(order => {
    let statusBadge = '';
    if (order.status === 'COMPLETED') {
      statusBadge = '<span class="px-2.5 py-1 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">HOÀN TẤT</span>';
    } else if (order.status === 'ABANDONED') {
      statusBadge = '<span class="px-2.5 py-1 rounded-lg text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200">QUÁ HẠN (HỦY)</span>';
    } else if (order.status === 'STORED') {
      statusBadge = '<span class="px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">ĐANG LƯU</span>';
    } else {
      statusBadge = '<span class="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200">CHỜ SHIPPER</span>';
    }

    const timeStr = new Date(order.created_at).toLocaleString('vi-VN');

    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="py-3 px-4 font-mono font-bold text-slate-900">#${order.id}</td>
        <td class="py-3 px-4 font-semibold text-slate-800">Ngăn ${order.compartment_id}</td>
        <td class="py-3 px-4 font-medium">${escapeHtml(order.customer_name)}</td>
        <td class="py-3 px-4 font-mono font-semibold text-slate-700">${escapeHtml(order.student_id || '-')}</td>
        <td class="py-3 px-4 text-slate-500 font-mono">${escapeHtml(order.customer_phone)}</td>
        <td class="py-3 px-4">${statusBadge}</td>
        <td class="py-3 px-4 text-slate-400 text-xs">${timeStr}</td>
      </tr>
    `;
  }).join('');
}

// ==========================================
// TAB 3: RENDER SIMULATOR TAB
// ==========================================

function renderSimulatorTab(lockers) {
  lockers.forEach(l => {
    const el = document.getElementById(`sim-status-${l.id}`);
    if (el) {
      el.textContent = l.status;
      if (l.status === 'AVAILABLE') el.className = 'text-xs font-bold text-emerald-600';
      else if (l.status === 'WAITING_DELIVERY') el.className = 'text-xs font-bold text-amber-600';
      else if (l.status === 'STORED') el.className = 'text-xs font-bold text-rose-600';
      else el.className = 'text-xs font-bold text-purple-600';
    }
  });
}

function checkGlobalSLAWarnings(lockers) {
  const alertBox = document.getElementById('sla-global-alert');
  const alertTxt = document.getElementById('sla-global-alert-text');
  
  const warnedLocker = lockers.find(l => l.sla && (l.sla.stage === 'WARNING' || l.sla.stage === 'ABANDONED'));
  
  if (warnedLocker) {
    alertBox.classList.remove('hidden');
    if (warnedLocker.sla.stage === 'ABANDONED') {
      alertBox.className = 'rounded-2xl p-4 bg-rose-50 border border-rose-300 text-rose-900 shadow-sm flex items-start gap-3.5 transition-all';
      alertTxt.textContent = `Ngăn ${warnedLocker.id} đã lưu trữ vượt quá 120 phút! Món ăn đã bị hủy để đảm bảo an toàn thực phẩm.`;
    } else {
      alertBox.className = 'rounded-2xl p-4 bg-amber-50 border border-amber-300 text-amber-900 shadow-sm flex items-start gap-3.5 transition-all';
      alertTxt.textContent = `Ngăn ${warnedLocker.id} đã lưu trữ hơn 45 phút! Đồ ăn sắp nguội, vui lòng nhắc nhở sinh viên đến nhận.`;
    }
  } else {
    alertBox.classList.add('hidden');
  }
}

function updateLiveSlaTimers() {
  lockersState.forEach(locker => {
    if (locker.status === 'STORED' && locker.active_order && locker.active_order.stored_at) {
      const elapsedSec = Math.floor((Date.now() - locker.active_order.stored_at) / 1000);
      const remainingSec = Math.max(0, (120 * 60) - elapsedSec);
      
      const elElapsed = document.getElementById(`dash-time-elapsed-${locker.id}`);
      const elRemaining = document.getElementById(`dash-time-remaining-${locker.id}`);
      
      if (elElapsed) elElapsed.textContent = formatDuration(elapsedSec);
      if (elRemaining) elRemaining.textContent = formatDuration(remainingSec);
    }
  });
}

// ========================================================
// BOOKING MODAL ACTIONS
// ========================================================

function openBookingModal(compartmentId) {
  const locker = lockersState.find(l => l.id === compartmentId);
  if (locker && locker.status !== 'AVAILABLE') {
    showToast(`Ngăn ${compartmentId} hiện không trống (${locker.status})!`, 'error');
    return;
  }

  currentBookingCompId = compartmentId;
  document.getElementById('modal-compartment-id').textContent = compartmentId;
  document.getElementById('modal-title-comp').textContent = compartmentId;
  document.getElementById('form-booking').reset();
  document.getElementById('booking-modal').classList.remove('hidden');
}

function closeBookingModal() {
  document.getElementById('booking-modal').classList.add('hidden');
}

async function handleBookingSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('input-name').value.trim();
  const studentId = (document.getElementById('input-student-id').value || '').trim().toUpperCase();
  const phone = document.getElementById('input-phone').value.trim();
  const notes = document.getElementById('input-notes').value.trim();
  const btnSubmit = document.getElementById('btn-submit-booking');

  if (!name || !studentId || !phone) {
    showToast('Vui lòng nhập đầy đủ Họ tên, MSSV và Số điện thoại!', 'error');
    return;
  }

  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i><span>Đang xử lý...</span>';

  try {
    const res = await fetch('/api/lockers/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compartment_id: currentBookingCompId,
        customer_name: name,
        student_id: studentId,
        customer_phone: phone,
        order_notes: notes
      })
    });

    const data = await res.json();
    if (data.success) {
      closeBookingModal();
      showOtpResultModal(data);
      fetchLockerData();
      showToast('Đặt tủ thành công! Đã sinh mã OTP.', 'success');
    } else {
      showToast(data.message || 'Lỗi đặt tủ!', 'error');
    }
  } catch (err) {
    showToast('Lỗi kết nối tới máy chủ!', 'error');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = '<span>Xác nhận đặt tủ</span><i class="fa-solid fa-arrow-right"></i>';
  }
}

function showOtpResultModal(data) {
  document.getElementById('res-compartment-id').textContent = data.compartment_id;
  document.getElementById('res-otp-shipper').textContent = data.otp_shipper;
  document.getElementById('res-otp-student').textContent = data.otp_student;

  const stName = (data.order && data.order.customer_name) ? data.order.customer_name : '';
  const stId = (data.order && data.order.student_id) ? ` (${data.order.student_id})` : '';
  const prefix = stName ? `Em ${stName}${stId}` : 'Em';

  currentShipperMessage = `${prefix} gửi đồ ở Tủ SmartLocker cổng trường - Ngăn ${data.compartment_id}, mã mở tủ của anh là ${data.otp_shipper} nhé anh.`;
  document.getElementById('preview-shipper-msg').textContent = currentShipperMessage;

  document.getElementById('otp-result-modal').classList.remove('hidden');
}

function closeOtpResultModal() {
  document.getElementById('otp-result-modal').classList.add('hidden');
}

async function copyShipperMessage() {
  if (!currentShipperMessage) return;
  const btn = document.getElementById('btn-copy-shipper');

  try {
    await navigator.clipboard.writeText(currentShipperMessage);
    btn.innerHTML = '<i class="fa-solid fa-check"></i><span>Đã sao chép tin nhắn!</span>';
    btn.classList.replace('from-fpt-orange', 'from-emerald-600');
    btn.classList.replace('to-amber-500', 'to-emerald-700');
    showToast('Đã copy tin nhắn gửi shipper vào bộ nhớ tạm!', 'success');

    setTimeout(() => {
      btn.innerHTML = '<i class="fa-regular fa-copy"></i><span>Sao chép tin nhắn gửi Shipper</span>';
      btn.classList.replace('from-emerald-600', 'from-fpt-orange');
      btn.classList.replace('to-emerald-700', 'to-amber-500');
    }, 2500);
  } catch (err) {
    showToast('Vui lòng chọn và sao chép thủ công đoạn tin nhắn!', 'info');
  }
}

// ==========================================
// SIMULATOR ACTIONS
// ==========================================

async function simVerifyShipper(compId) {
  const locker = lockersState.find(l => l.id === compId);
  if (!locker || !locker.active_order) {
    showToast(`Ngăn ${compId} chưa có đơn hàng nào để Shipper bỏ đồ! Hãy bấm Đặt Tủ trước.`, 'error');
    return;
  }

  const otp = locker.active_order.otp_shipper;
  showToast(`[SIM] Đang gửi mã Shipper OTP "${otp}" lên server...`, 'info');

  try {
    // 1. ESP32 Gửi verify OTP
    const resVerify = await fetch('/api/locker/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp })
    });
    const dataVerify = await resVerify.json();

    if (dataVerify.status === 'SUCCESS') {
      showToast(`[SIM ESP32] Mã đúng! Rơ-le Ngăn ${compId} bung khóa 0.8s!`, 'success');
      
      // 2. Giả lập sau khi mở cửa, bỏ đồ vào và đóng cửa lại (Cảm biến E18 LOW + MC-38 LOW)
      setTimeout(async () => {
        await fetch('/api/locker/update-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            compartment_id: compId,
            event: 'ITEM_STORED',
            door_state: 'CLOSED',
            item_state: 'DETECTED'
          })
        });
        showToast(`[SIM ESP32] Cửa Ngăn ${compId} đã đóng, cảm biến phát hiện món -> Chuyển STORED!`, 'success');
        fetchLockerData();
      }, 1200);

    } else {
      showToast(`[SIM ESP32] Xác thực thất bại: ${dataVerify.message}`, 'error');
    }
  } catch (err) {
    showToast('Lỗi khi giả lập Shipper!', 'error');
  }
}

async function simVerifyStudent(compId) {
  const locker = lockersState.find(l => l.id === compId);
  if (!locker || !locker.active_order) {
    showToast(`Ngăn ${compId} hiện không có đồ để lấy!`, 'error');
    return;
  }

  if (locker.status !== 'STORED') {
    showToast(`Ngăn ${compId} chưa ở trạng thái STORED (Đã có món)!`, 'error');
    return;
  }

  const otp = locker.active_order.otp_student;
  showToast(`[SIM] Đang gửi mã Sinh viên OTP "${otp}" lên server...`, 'info');

  try {
    // 1. ESP32 Gửi verify OTP
    const resVerify = await fetch('/api/locker/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp })
    });
    const dataVerify = await resVerify.json();

    if (dataVerify.status === 'SUCCESS') {
      showToast(`[SIM ESP32] Mã đúng! Rơ-le Ngăn ${compId} bung khóa 0.8s!`, 'success');

      // 2. Giả lập sinh viên lấy đồ ra và đóng cửa lại (E18 HIGH + MC-38 LOW)
      setTimeout(async () => {
        await fetch('/api/locker/update-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            compartment_id: compId,
            event: 'ITEM_PICKED',
            door_state: 'CLOSED',
            item_state: 'EMPTY'
          })
        });
        showToast(`[SIM ESP32] Đã lấy đồ & đóng cửa -> Đơn hoàn tất, Ngăn ${compId} AVAILABLE!`, 'success');
        fetchLockerData();
        fetchHistory();
      }, 1200);

    } else {
      showToast(`[SIM ESP32] Xác thực thất bại: ${dataVerify.message}`, 'error');
    }
  } catch (err) {
    showToast('Lỗi khi giả lập Sinh viên!', 'error');
  }
}

async function simFastForward(compId, minutes) {
  try {
    const res = await fetch('/api/simulate/fast-forward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ compartment_id: compId, minutes })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message, 'success');
      fetchLockerData();
    } else {
      showToast(data.message, 'error');
    }
  } catch (err) {
    showToast('Lỗi tua nhanh thời gian!', 'error');
  }
}

async function simResetAllLockers() {
  if (!confirm('Bạn có chắc chắn muốn đặt lại cả 2 ngăn tủ về trạng thái trống (AVAILABLE)?')) return;
  try {
    const res = await fetch('/api/lockers/reset', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Đã đặt lại toàn bộ ngăn tủ thành công!', 'success');
      fetchLockerData();
      fetchHistory();
    }
  } catch (err) {
    showToast('Lỗi khi đặt lại tủ!', 'error');
  }
}

// ==========================================
// TABS SWITCHER & UTILITIES
// ==========================================

function switchTab(tabName) {
  activeTab = tabName;
  ['booking', 'dashboard', 'simulator'].forEach(t => {
    const section = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (section) {
      if (t === tabName) {
        section.classList.remove('hidden');
      } else {
        section.classList.add('hidden');
      }
    }
    if (btn) {
      if (t === tabName) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });

  if (tabName === 'dashboard') {
    fetchHistory();
  }
}

function formatDuration(totalSeconds) {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  const msgEl = document.getElementById('toast-message');
  const iconEl = document.getElementById('toast-icon');

  msgEl.textContent = message;

  if (type === 'success') {
    toast.className = 'fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl p-4 text-white shadow-2xl transition-all transform translate-y-0 opacity-100 flex items-center gap-3 bg-emerald-600';
    iconEl.className = 'fa-solid fa-circle-check text-xl';
  } else if (type === 'error') {
    toast.className = 'fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl p-4 text-white shadow-2xl transition-all transform translate-y-0 opacity-100 flex items-center gap-3 bg-rose-600';
    iconEl.className = 'fa-solid fa-circle-xmark text-xl';
  } else {
    toast.className = 'fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl p-4 text-white shadow-2xl transition-all transform translate-y-0 opacity-100 flex items-center gap-3 bg-slate-900';
    iconEl.className = 'fa-solid fa-circle-info text-xl text-fpt-orange';
  }

  setTimeout(() => {
    toast.classList.add('translate-y-20', 'opacity-0', 'pointer-events-none');
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
