import { useState, useCallback, useRef, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Environment, ContactShadows } from '@react-three/drei'
import LockerStation from './components/LockerStation'
import BookingModal from './components/BookingModal'
import SimulationPanel from './components/SimulationPanel'

const INITIAL_LOCKERS = [
  { id: 1, status: 'available', label: 'Tủ 1', booking: null },
  { id: 2, status: 'available', label: 'Tủ 2', booking: null },
  { id: 3, status: 'available', label: 'Tủ 3', booking: null },
  { id: 4, status: 'available', label: 'Tủ 4', booking: null },
]

// Danh sách font chữ từ ảnh người dùng cung cấp
const AVAILABLE_FONTS = [
  { name: 'Lexend (Mặc định · Khuyên dùng)', family: "'Lexend', sans-serif" },
  { name: 'Montserrat (Hiện đại, rõ nét)', family: "'Montserrat', sans-serif" },
  { name: 'Nunito (Bo tròn, thân thiện)', family: "'Nunito', sans-serif" },
  { name: 'Roboto (Google Standard)', family: "'Roboto', sans-serif" },
  { name: 'Raleway (Thanh lịch)', family: "'Raleway', sans-serif" },
  { name: 'Comfortaa (Bo góc dễ thương)', family: "'Comfortaa', cursive" },
  { name: 'Caveat (Chữ viết tay)', family: "'Caveat', cursive" },
  { name: 'Pacifico (Nghệ thuật)', family: "'Pacifico', cursive" },
  { name: 'Lobster (Cổ điển nổi bật)', family: "'Lobster', cursive" },
  { name: 'Lora (Serif tinh tế)', family: "'Lora', serif" },
  { name: 'Merriweather (Serif đọc báo)', family: "'Merriweather', serif" },
  { name: 'Playfair Display (Sang trọng)', family: "'Playfair Display', serif" },
  { name: 'Oswald (Mạnh mẽ, cô đọng)', family: "'Oswald', sans-serif" },
  { name: 'Roboto Mono (Đơn cách công nghệ)', family: "'Roboto Mono', monospace" },
  { name: 'Arial (Hệ thống phổ thông)', family: "Arial, sans-serif" },
  { name: 'Calibri (Văn phòng thanh nhã)', family: "Calibri, sans-serif" },
  { name: 'Verdana (Dễ đọc màn hình)', family: "Verdana, sans-serif" },
  { name: 'Georgia (Serif cổ điển)', family: "Georgia, serif" },
  { name: 'Times New Roman (Truyền thống)', family: "'Times New Roman', serif" },
  { name: 'Comic Sans MS (Vui nhộn)', family: "'Comic Sans MS', cursive" },
  { name: 'Courier New (Máy đánh chữ)', family: "'Courier New', monospace" },
  { name: 'Impact (Đậm nét tiêu đề)', family: "Impact, sans-serif" },
  { name: 'Trebuchet MS (Hình học cân đối)', family: "'Trebuchet MS', sans-serif" },
]

export default function App() {
  const [lockers, setLockers] = useState(INITIAL_LOCKERS)
  const [selectedLocker, setSelectedLocker] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [currentFont, setCurrentFont] = useState(AVAILABLE_FONTS[0].family)
  const controlsRef = useRef()

  // Áp dụng font chữ được chọn vào toàn bộ website
  useEffect(() => {
    document.documentElement.style.setProperty('--app-font', currentFont)
    document.body.style.fontFamily = currentFont
  }, [currentFont])

  // Xử lý khi sinh viên click vào tủ Available
  const handleLockerClick = useCallback((lockerId) => {
    const locker = lockers.find((l) => l.id === lockerId)
    if (locker && locker.status === 'available') {
      setSelectedLocker(lockerId)
      setModalOpen(true)
    }
  }, [lockers])

  // Xác nhận đặt tủ
  const handleBookingConfirm = useCallback((bookingData) => {
    setLockers((prev) =>
      prev.map((l) =>
        l.id === bookingData.lockerId
          ? {
              ...l,
              status: 'reserved',
              booking: {
                name: bookingData.name,
                phone: bookingData.phone,
                studentId: bookingData.studentId,
                timeSlot: bookingData.timeSlot,
                shipperOtp: bookingData.shipperOtp,
                studentOtp: bookingData.studentOtp,
              },
            }
          : l
      )
    )
    setModalOpen(false)
    setSelectedLocker(null)
  }, [])

  // Giả lập Shipper nhập mã bỏ đồ: Reserved -> Occupied
  const handleSimulateShipper = useCallback((lockerId) => {
    setLockers((prev) =>
      prev.map((l) =>
        l.id === lockerId && l.status === 'reserved'
          ? { ...l, status: 'occupied' }
          : l
      )
    )
  }, [])

  // Giả lập Sinh viên nhập mã lấy đồ: Occupied -> Available
  const handleSimulateStudent = useCallback((lockerId) => {
    setLockers((prev) =>
      prev.map((l) =>
        l.id === lockerId && l.status === 'occupied'
          ? { ...l, status: 'available', booking: null }
          : l
      )
    )
  }, [])

  // Reset toàn bộ trạm tủ
  const handleResetAll = useCallback(() => {
    setLockers(INITIAL_LOCKERS)
  }, [])

  // Thống kê nhanh trạng thái
  const counts = {
    available: lockers.filter((l) => l.status === 'available').length,
    reserved: lockers.filter((l) => l.status === 'reserved').length,
    occupied: lockers.filter((l) => l.status === 'occupied').length,
  }

  return (
    <div 
      className="relative w-screen h-screen overflow-hidden bg-slate-950 select-none"
      style={{ fontFamily: currentFont }}
    >
      {/* Top Header Bar: Rộng rãi, không bị sát mép, phân tách rõ ràng */}
      <header className="absolute top-6 inset-x-6 sm:inset-x-10 z-20 flex flex-wrap items-center justify-between gap-4 pointer-events-none">
        
        {/* [Vị trí 1 - Ảnh 2 sửa lỗi sát mép]: Khung thương hiệu rộng rãi */}
        <div 
          className="pointer-events-auto flex items-center gap-4 rounded-3xl border border-slate-800 bg-slate-900/90 backdrop-blur-md shadow-2xl transition hover:border-slate-700"
          style={{ padding: '16px 24px' }}
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-orange-600 via-orange-500 to-amber-500 text-white font-black text-lg shadow-md tracking-wider">
            FPT
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white">
                TRẠM GIỮ HÀNG HÓA FPT
              </h1>
              <span 
                className="inline-flex items-center rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 tracking-wide"
                style={{ padding: '6px 18px' }}
              >
                Hoạt động
              </span>
            </div>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              Kiosk Cổng Trường Đại Học FPT · Giữ đồ ăn & Hàng hóa 24/7
            </p>
          </div>
        </div>

        {/* Khối bên phải: Bộ đếm trạng thái + Bộ chọn Font chữ */}
        <div className="pointer-events-auto flex flex-wrap items-center gap-3.5">
          
          {/* Bộ chọn Font chữ theo yêu cầu */}
          <div 
            className="flex items-center gap-2.5 rounded-2xl border border-slate-800 bg-slate-900/90 backdrop-blur-md shadow-2xl text-white text-xs sm:text-sm"
            style={{ padding: '10px 18px' }}
          >
            <span className="text-base">🔤</span>
            <span className="text-slate-400 font-medium hidden md:inline">Font chữ:</span>
            <select
              value={currentFont}
              onChange={(e) => setCurrentFont(e.target.value)}
              className="bg-slate-800 text-white font-semibold text-xs sm:text-sm rounded-xl px-3 py-1.5 border border-slate-700 outline-none focus:border-orange-500 cursor-pointer"
            >
              {AVAILABLE_FONTS.map((font) => (
                <option key={font.name} value={font.family}>
                  {font.name}
                </option>
              ))}
            </select>
          </div>

          {/* [Vị trí 3]: Bộ đếm số lượng ngăn tủ (Nới rộng padding 8px 22px chuẩn format, không ôm sát chữ) */}
          <div 
            className="flex items-center gap-3.5 rounded-2xl border border-slate-800 bg-slate-900/90 backdrop-blur-md shadow-2xl"
            style={{ padding: '10px 20px' }}
          >
            {/* Trống */}
            <div 
              className="flex items-center gap-2.5 rounded-full bg-emerald-950/70 border border-emerald-700/60 text-emerald-300"
              style={{ padding: '8px 22px' }}
            >
              <span className="font-extrabold text-base tabular-nums">{counts.available}</span>
              <span className="text-sm font-semibold text-emerald-200">Trống</span>
            </div>

            {/* Đã đặt */}
            <div 
              className="flex items-center gap-2.5 rounded-full bg-amber-950/70 border border-amber-700/60 text-amber-300"
              style={{ padding: '8px 22px' }}
            >
              <span className="font-extrabold text-base tabular-nums">{counts.reserved}</span>
              <span className="text-sm font-semibold text-amber-200">Đã đặt</span>
            </div>

            {/* Có đồ */}
            <div 
              className="flex items-center gap-2.5 rounded-full bg-rose-950/70 border border-rose-700/60 text-rose-300"
              style={{ padding: '8px 22px' }}
            >
              <span className="font-extrabold text-base tabular-nums">{counts.occupied}</span>
              <span className="text-sm font-semibold text-rose-200">Có đồ</span>
            </div>
          </div>

        </div>
      </header>

      {/* 3D Canvas Space */}
      <Canvas
        camera={{ position: [0, 1.25, 5.2], fov: 48 }}
        shadows
        gl={{ antialias: true }}
        className="w-full h-full"
      >
        {/* Ánh sáng */}
        <ambientLight intensity={0.5} />
        <directionalLight
          position={[6, 9, 6]}
          intensity={1.4}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <pointLight position={[-4, 3, -2]} intensity={0.6} color="#6366f1" />
        <spotLight
          position={[0, 7, 3]}
          angle={0.45}
          penumbra={0.6}
          intensity={1.2}
          castShadow
        />

        {/* Environment map */}
        <Environment preset="city" />

        {/* [Vị trí 2] Mô hình 3D Locker Station với biển hiệu TRẠM GIỮ HÀNG HÓA FPT */}
        <LockerStation lockers={lockers} onLockerClick={handleLockerClick} />

        {/* Contact Shadows & Ground */}
        <ContactShadows
          position={[0, -1.56, 0]}
          opacity={0.65}
          scale={12}
          blur={2.4}
          far={4.5}
        />
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -1.56, 0]}
          receiveShadow
        >
          <planeGeometry args={[60, 60]} />
          <meshStandardMaterial color="#090d16" roughness={0.9} />
        </mesh>

        {/* Orbit Controls */}
        <OrbitControls
          ref={controlsRef}
          enablePan={false}
          minPolarAngle={Math.PI / 6}
          maxPolarAngle={Math.PI / 2.15}
          minDistance={3.2}
          maxDistance={9.5}
          enableDamping
          dampingFactor={0.06}
        />
      </Canvas>

      {/* [Vị trí 4] Interaction Instruction Pill at bottom center: Rộng rãi, dễ nhìn */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none w-auto max-w-[90vw]">
        <div 
          className="flex items-center gap-3 rounded-full border border-slate-700/80 bg-slate-900/90 backdrop-blur-md shadow-2xl text-xs sm:text-sm font-medium text-slate-200 tracking-wide text-center"
          style={{ padding: '12px 28px' }}
        >
          <span className="text-base sm:text-lg">🖱️</span>
          <span>Bấm tủ màu xanh để đặt tủ • Giữ & kéo chuột để xoay 3D • Cuộn chuột để zoom</span>
        </div>
      </div>

      {/* Modal Điền Thông Tin (Đã sửa lỗi ôm sát viền, chuẩn padding 36px, chữ to rõ) */}
      <BookingModal
        lockerId={selectedLocker}
        isOpen={modalOpen}
        onClose={() => {
          setModalOpen(false)
          setSelectedLocker(null)
        }}
        onConfirm={handleBookingConfirm}
      />

      {/* Bảng Giả Lập Điều Khiển Kiosk */}
      <SimulationPanel
        lockers={lockers}
        onSimulateShipper={handleSimulateShipper}
        onSimulateStudent={handleSimulateStudent}
        onResetAll={handleResetAll}
      />
    </div>
  )
}
