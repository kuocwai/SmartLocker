# Smart Locker - Trạm Giữ Hàng Hóa FPT 🔒📦

Dự án Web App mô phỏng hệ thống Kiosk Tủ Thông Minh (Smart Locker) 3D dành cho sinh viên và shipper, xây dựng bằng React, Three.js (@react-three/fiber, @react-three/drei) và Tailwind CSS v4.

---

## 🌟 Tính năng chính

1. **Mô phỏng Trạm Tủ 3D (Three.js / React Three Fiber)**
   - Mô hình 3D 4 ngăn tủ (2x2) tương tác chân thực.
   - Hỗ trợ xoay góc nhìn, zoom (OrbitControls).
   - Màu sắc theo trạng thái thời gian thực:
     - 🟢 **Available (Trống)**: Tủ sẵn sàng, có thể click để đặt.
     - 🟡 **Reserved (Đã đặt)**: Sinh viên đã đặt, đang chờ shipper giao đồ.
     - 🔴 **Occupied (Có đồ)**: Đã có đồ bên trong, chờ sinh viên lấy.

2. **Form Đặt Tủ & Sinh Mã OTP**
   - Click vào ngăn tủ trống để mở Modal đặt tủ.
   - Nhập thông tin: Họ tên, Số điện thoại, Mã số sinh viên (MSSV), Khung giờ ca học.
   - Sinh tự động 2 mã OTP riêng biệt:
     - 🔑 **Mã Shipper**: Dùng để shipper mở tủ cất đồ.
     - 🔑 **Mã Sinh viên**: Dùng để sinh viên mở tủ lấy đồ.
   - Tính năng sao chép nhanh tin nhắn gửi shipper.

3. **Bảng Điều Khiển Giả Lập (Simulation Control Bar)**
   - Bảng công cụ góc màn hình hỗ trợ thuyết trình / kiểm thử:
     - Giả lập shipper nhập OTP & cất đồ (`Reserved` ➔ `Occupied`).
     - Giả lập sinh viên nhập OTP & nhận đồ (`Occupied` ➔ `Available`).
     - Nút đặt lại (Reset) toàn bộ trạm tủ.

4. **Bộ Chọn Font Chữ Linh Hoạt (Font Selector)**
   - Cho phép thay đổi font chữ toàn bộ giao diện theo thời gian thực (Lexend, Montserrat, Nunito, Roboto, v.v.).

---

## 🚀 Hướng dẫn cài đặt & khởi chạy

### Yêu cầu môi trường
- Node.js >= 18
- npm hoặc yarn / pnpm

### Cài đặt dependencies
```bash
npm install
```

### Chạy môi trường Development
```bash
npm run dev
```
Trình duyệt sẽ mở tại `http://localhost:5173/`.

### Build cho môi trường Production
```bash
npm run build
```

---

## 🛠️ Công nghệ sử dụng
- **React 19** + **Vite 8**
- **Tailwind CSS v4** + `@tailwindcss/vite`
- **Three.js** + **@react-three/fiber** + **@react-three/drei**
- **Design Tokens**: evondevKit UI/UX principles
