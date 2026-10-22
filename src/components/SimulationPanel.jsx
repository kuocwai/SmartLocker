import { useState } from 'react'

export default function SimulationPanel({
  lockers = [],
  onSimulateShipper,
  onSimulateStudent,
  onResetAll,
}) {
  const [isOpen, setIsOpen] = useState(false)

  const getStatusBadge = (status) => {
    switch (status) {
      case 'available':
        return (
          <span 
            className="inline-flex items-center text-xs sm:text-[13px] font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
            style={{ padding: '6px 18px' }}
          >
            Trống
          </span>
        )
      case 'reserved':
        return (
          <span 
            className="inline-flex items-center text-xs sm:text-[13px] font-semibold rounded-full bg-amber-50 text-amber-700 border border-amber-200"
            style={{ padding: '6px 18px' }}
          >
            Đã đặt (Chờ bỏ đồ)
          </span>
        )
      case 'occupied':
        return (
          <span 
            className="inline-flex items-center text-xs sm:text-[13px] font-semibold rounded-full bg-rose-50 text-rose-700 border border-rose-200"
            style={{ padding: '6px 18px' }}
          >
            Có đồ ăn
          </span>
        )
      default:
        return (
          <span className="px-2.5 py-1 text-xs rounded-full bg-slate-100 text-slate-600">
            {status}
          </span>
        )
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end">
      {/* Expanded Control Box */}
      {isOpen && (
        <div className="mb-3.5 w-[380px] sm:w-[420px] rounded-3xl border border-slate-200/90 bg-white p-5 shadow-2xl text-slate-800 animate-in fade-in duration-150">
          {/* Header */}
          <div className="flex items-center justify-between pb-3.5 border-b border-slate-100">
            <div className="flex items-center gap-2.5">
              <span className="text-xl">🎮</span>
              <h3 className="text-base font-bold text-slate-900">
                Bảng Giả Lập Kiosk
              </h3>
            </div>
            <button
              type="button"
              onClick={onResetAll}
              className="inline-flex items-center gap-1.5 text-xs sm:text-[13px] font-medium text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 transition cursor-pointer"
              title="Đặt lại toàn bộ 4 ngăn tủ về trạng thái trống"
            >
              <span>↺</span>
              <span>Reset tất cả</span>
            </button>
          </div>

          {/* Locker items list */}
          <div className="py-3 space-y-3 max-h-[62vh] overflow-y-auto">
            {lockers.map((locker) => (
              <div
                key={locker.id}
                className="rounded-2xl border border-slate-200/90 bg-slate-50/60 p-3.5 space-y-2.5"
              >
                {/* Status line */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-slate-900 text-white font-extrabold text-xs">
                      #{locker.id}
                    </span>
                    <span className="text-sm font-bold text-slate-800">
                      {locker.label}
                    </span>
                  </div>
                  {getStatusBadge(locker.status)}
                </div>

                {/* Booking details if reserved/occupied */}
                {locker.booking && (
                  <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs sm:text-[13px] text-slate-600 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Sinh viên:</span>
                      <span className="font-semibold text-slate-800">
                        {locker.booking.name} ({locker.booking.studentId})
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5 pt-1.5 border-t border-slate-100">
                      <div className="rounded-lg bg-amber-50 p-2 text-center border border-amber-200/60">
                        <span className="block text-[11px] font-semibold text-amber-800">Mã Shipper</span>
                        <span className="font-mono font-black text-amber-700 text-sm sm:text-base tabular-nums">
                          {locker.booking.shipperOtp}
                        </span>
                      </div>
                      <div className="rounded-lg bg-emerald-50 p-2 text-center border border-emerald-200/60">
                        <span className="block text-[11px] font-semibold text-emerald-800">Mã SV</span>
                        <span className="font-mono font-black text-emerald-700 text-sm sm:text-base tabular-nums">
                          {locker.booking.studentOtp}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Action simulation trigger buttons */}
                <div>
                  {locker.status === 'reserved' && (
                    <button
                      type="button"
                      onClick={() => onSimulateShipper(locker.id)}
                      className="w-full flex items-center justify-center gap-2 h-10 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs sm:text-sm font-bold transition cursor-pointer shadow-xs active:scale-98"
                    >
                      <span>📦</span>
                      <span>Giả lập: Shipper nhập mã & cất đồ</span>
                    </button>
                  )}

                  {locker.status === 'occupied' && (
                    <button
                      type="button"
                      onClick={() => onSimulateStudent(locker.id)}
                      className="w-full flex items-center justify-center gap-2 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm font-bold transition cursor-pointer shadow-xs active:scale-98"
                    >
                      <span>🎒</span>
                      <span>Giả lập: Sinh viên nhập mã lấy đồ</span>
                    </button>
                  )}

                  {locker.status === 'available' && (
                    <div className="text-center py-1 text-xs text-slate-400 italic">
                      Tủ đang trống · Bấm trực tiếp vào ngăn 3D để đặt
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Footer note */}
          <div className="pt-2.5 border-t border-slate-100 text-xs text-slate-400 text-center">
            Công cụ hỗ trợ thuyết trình & kiểm thử nhanh các ca sử dụng
          </div>
        </div>
      )}

      {/* Floating Toggle Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2.5 h-12 px-5 rounded-full border border-slate-300 bg-white text-slate-800 text-sm font-bold shadow-xl hover:bg-slate-50 active:scale-98 transition cursor-pointer"
        aria-expanded={isOpen}
      >
        <span className="text-base">🎮</span>
        <span>{isOpen ? 'Thu gọn điều khiển' : 'Giả lập Kiosk'}</span>
        <span className="text-xs text-slate-400">
          {isOpen ? '▼' : '▲'}
        </span>
      </button>
    </div>
  )
}
