import { useState, useEffect } from 'react'

export default function BookingModal({ lockerId, isOpen, onClose, onConfirm }) {
  const [step, setStep] = useState(1)
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    studentId: '',
    timeSlot: 'Ca 2: 09:30 - 12:00 (Buổi trưa)',
  })
  const [otps, setOtps] = useState({
    shipperOtp: '',
    studentOtp: '',
  })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setStep(1)
      setFormData({
        name: '',
        phone: '',
        studentId: '',
        timeSlot: 'Ca 2: 09:30 - 12:00 (Buổi trưa)',
      })
      setOtps({ shipperOtp: '', studentOtp: '' })
      setCopied(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    const genOtp = () => Math.floor(1000 + Math.random() * 9000).toString()
    setOtps({
      shipperOtp: genOtp(),
      studentOtp: genOtp(),
    })
    setStep(2)
  }

  const shipperMessage = `Em gửi đồ ở Tủ số ${lockerId} cổng trường, mã mở tủ là ${otps.shipperOtp} nhé anh`

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(shipperMessage)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    }
  }

  const handleFinish = () => {
    onConfirm({ lockerId, ...formData, ...otps })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8 bg-slate-950/80 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
    >
      {/* Modal Box: Kích thước chuẩn, padding 36px-40px rộng rãi, không bị sát mép */}
      <div 
        className="relative w-full max-w-xl sm:max-w-2xl rounded-3xl border border-slate-200 bg-white shadow-2xl text-slate-800 transition-all my-auto"
        style={{ padding: '36px' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between pb-6 mb-6 border-b border-slate-100">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-orange-600 via-orange-500 to-amber-500 text-white font-black text-2xl shadow-md">
              #{lockerId}
            </div>
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
                {step === 1 ? `Đặt Ngăn Tủ Số ${lockerId}` : 'Đặt Tủ Thành Công!'}
              </h2>
              <p className="text-sm sm:text-base text-slate-500 mt-1">
                {step === 1
                  ? 'Điền thông tin đặt chỗ để nhận mã bỏ đồ & lấy đồ'
                  : 'Vui lòng lưu lại mã mở tủ bên dưới hoặc gửi tin nhắn cho Shipper'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition text-2xl cursor-pointer"
            aria-label="Đóng cửa sổ"
          >
            ✕
          </button>
        </div>

        {/* Modal Content */}
        <div>
          {step === 1 ? (
            <form onSubmit={handleSubmit} className="space-y-5">
              {/* Họ tên */}
              <div>
                <label className="block text-sm sm:text-base font-semibold text-slate-800 mb-1.5">
                  Họ và tên sinh viên <span className="text-rose-500 font-bold">*</span>
                </label>
                <input
                  type="text"
                  name="name"
                  value={formData.name}
                  onChange={handleChange}
                  required
                  placeholder="Ex: Nguyễn Văn An"
                  style={{ paddingLeft: '20px', paddingRight: '20px' }}
                  className="w-full h-12 rounded-xl border border-slate-300 bg-slate-50/60 text-base text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition"
                />
              </div>

              {/* Grid 2 cột: SĐT & MSSV */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm sm:text-base font-semibold text-slate-800 mb-1.5">
                    Số điện thoại <span className="text-rose-500 font-bold">*</span>
                  </label>
                  <input
                    type="tel"
                    name="phone"
                    value={formData.phone}
                    onChange={handleChange}
                    required
                    pattern="[0-9]{10,11}"
                    placeholder="Ex: 0912 345 678"
                    style={{ paddingLeft: '20px', paddingRight: '20px' }}
                    className="w-full h-12 rounded-xl border border-slate-300 bg-slate-50/60 text-base text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition"
                  />
                </div>

                <div>
                  <label className="block text-sm sm:text-base font-semibold text-slate-800 mb-1.5">
                    Mã số sinh viên (MSSV) <span className="text-rose-500 font-bold">*</span>
                  </label>
                  <input
                    type="text"
                    name="studentId"
                    value={formData.studentId}
                    onChange={handleChange}
                    required
                    placeholder="EX: SE170123"
                    style={{ paddingLeft: '20px', paddingRight: '20px' }}
                    className="w-full h-12 rounded-xl border border-slate-300 bg-slate-50/60 text-base text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition uppercase"
                  />
                </div>
              </div>

              {/* Khung giờ lấy đồ */}
              <div>
                <label className="block text-sm sm:text-base font-semibold text-slate-800 mb-1.5">
                  Khung giờ dự kiến lấy đồ (Ca học)
                </label>
                <div className="relative">
                  <select
                    name="timeSlot"
                    value={formData.timeSlot}
                    onChange={handleChange}
                    style={{ paddingLeft: '20px', paddingRight: '44px' }}
                    className="w-full h-12 appearance-none rounded-xl border border-slate-300 bg-slate-50/60 text-base text-slate-900 focus:bg-white focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none transition cursor-pointer"
                  >
                    <option value="Ca 1: 07:00 - 09:15 (Buổi sáng)">Ca 1: 07:00 - 09:15 (Buổi sáng)</option>
                    <option value="Ca 2: 09:30 - 11:45 (Buổi trưa)">Ca 2: 09:30 - 11:45 (Buổi trưa)</option>
                    <option value="Ca 3: 13:00 - 15:15 (Buổi chiều)">Ca 3: 13:00 - 15:15 (Buổi chiều)</option>
                    <option value="Ca 4: 15:30 - 17:45 (Chiều muộn)">Ca 4: 15:30 - 17:45 (Chiều muộn)</option>
                    <option value="Ca 5: 18:00 - 20:15 (Buổi tối)">Ca 5: 18:00 - 20:15 (Buổi tối)</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-slate-500 text-sm">
                    ▼
                  </div>
                </div>
              </div>

              {/* Action Buttons: Kích thước vừa vặn chuẩn tỉ lệ */}
              <div className="flex items-center justify-end gap-3 pt-5 border-t border-slate-100">
                <button
                  type="button"
                  onClick={onClose}
                  style={{ padding: '10px 22px' }}
                  className="rounded-xl border border-slate-300 bg-white text-sm sm:text-base font-semibold text-slate-700 hover:bg-slate-50 transition cursor-pointer"
                >
                  Hủy bỏ
                </button>
                <button
                  type="submit"
                  style={{ padding: '10px 24px' }}
                  className="rounded-xl bg-orange-600 hover:bg-orange-700 text-white text-sm sm:text-base font-bold shadow-md shadow-orange-500/20 active:scale-98 transition flex items-center justify-center gap-2 cursor-pointer"
                >
                  <span>Xác nhận đặt tủ</span>
                </button>
              </div>
            </form>
          ) : (
            <div className="space-y-6">
              {/* Banner Success */}
              <div className="flex items-center gap-4 rounded-2xl border-2 border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white font-bold text-xl shadow-sm">
                  ✓
                </div>
                <div>
                  <p className="font-bold text-lg text-emerald-900">Đặt tủ thành công!</p>
                  <p className="text-sm sm:text-base text-emerald-800 mt-0.5">
                    Ngăn tủ #{lockerId} đã được giữ chỗ và chuyển sang màu cam (Reserved).
                  </p>
                </div>
              </div>

              {/* Tóm tắt thông tin đặt chỗ */}
              <div className="rounded-2xl border-2 border-slate-200 bg-slate-50 p-5 sm:p-6 text-base space-y-3 text-slate-700">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Sinh viên:</span>
                  <span className="font-bold text-slate-900">{formData.name} ({formData.studentId})</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Số điện thoại:</span>
                  <span className="font-semibold text-slate-900">{formData.phone}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Khung giờ nhận:</span>
                  <span className="font-semibold text-slate-900">{formData.timeSlot}</span>
                </div>
              </div>

              {/* Hai Khối OTP Nổi Bật */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* OTP Shipper */}
                <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-5 sm:p-6 text-center shadow-xs">
                  <div className="text-xs sm:text-sm font-bold uppercase tracking-wider text-amber-900">
                    🔑 Mã Mở Tủ Shipper
                  </div>
                  <div className="my-2.5 text-4xl sm:text-5xl font-mono font-black tracking-widest text-amber-600">
                    {otps.shipperOtp}
                  </div>
                  <div className="text-xs sm:text-sm text-amber-800 leading-snug">
                    Gửi mã này cho Shipper để mở tủ bỏ thức ăn
                  </div>
                </div>

                {/* OTP Sinh Viên */}
                <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-5 sm:p-6 text-center shadow-xs">
                  <div className="text-xs sm:text-sm font-bold uppercase tracking-wider text-emerald-900">
                    🔑 Mã Nhận Đồ Sinh Viên
                  </div>
                  <div className="my-2.5 text-4xl sm:text-5xl font-mono font-black tracking-widest text-emerald-600">
                    {otps.studentOtp}
                  </div>
                  <div className="text-xs sm:text-sm text-emerald-800 leading-snug">
                    Dùng mã này tại trạm để mở tủ lấy đồ
                  </div>
                </div>
              </div>

              {/* Nút copy tin nhắn */}
              <div className="space-y-3 pt-2">
                <button
                  type="button"
                  onClick={handleCopyMessage}
                  className="w-full flex items-center justify-center gap-3 h-14 rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white font-bold text-base sm:text-lg shadow-lg shadow-orange-500/25 hover:from-amber-600 hover:to-orange-700 active:scale-98 transition cursor-pointer"
                >
                  {copied ? (
                    <>
                      <span className="text-2xl">✓</span>
                      <span>Đã copy tin nhắn vào bộ nhớ tạm!</span>
                    </>
                  ) : (
                    <>
                      <span className="text-2xl">📋</span>
                      <span>Copy tin nhắn gửi cho Shipper</span>
                    </>
                  )}
                </button>
                <div className="p-3.5 rounded-xl bg-slate-100 text-sm text-slate-600 text-center italic border border-slate-200">
                  &ldquo;{shipperMessage}&rdquo;
                </div>
              </div>

              {/* Nút hoàn tất */}
              <div className="pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handleFinish}
                  className="w-full h-13 rounded-2xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-base transition cursor-pointer shadow-md"
                >
                  Hoàn tất & Đóng
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
