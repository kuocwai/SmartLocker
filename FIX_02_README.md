# FIX 02 — Bảo vệ quy trình giao và nhận hàng

Nền áp dụng: `main` sau khi merge FIX 01 (`d3a9583`). Chỉ sửa `server.js` và thêm `tests/fix02.test.js` cùng hướng dẫn này.

## Thay đổi

- Khi OTP Shipper được xác minh, Backend cấp một quyền chuyển trạng thái tạm thời cho **đúng đơn + đúng ngăn + vai trò SHIPPER**.
- Khi OTP Sinh viên được xác minh, cấp quyền tương tự cho **vai trò STUDENT**.
- Quyền chỉ dùng được **một lần**, hết hạn sau **10 phút** hoặc mất khi khởi động lại Backend.
- `ITEM_STORED` chỉ chuyển `WAITING_DELIVERY` sang `STORED` khi đã xác minh Shipper, đúng đơn, ngăn, và ESP32 báo `door_state=CLOSED`, `item_state=DETECTED`.
- `ITEM_PICKED` chỉ chuyển `STORED` sang `COMPLETED`, giải phóng ngăn, khi đã xác minh Sinh viên và báo `CLOSED` + `EMPTY`.
- Từ chối các sự kiện không có đơn, sai thứ tự, trùng lặp, sai vai trò, sai ngăn, sai giá trị cảm biến; kiểm tra `compartment_id` cho API `sensor-sync`.

## Kiểm tra

```powershell
node --test tests/fix01.test.js tests/fix02.test.js
```

## Giới hạn cần lưu ý

- Xác thực sự kiện trên Backend **không chứng minh cửa thật đã mở rồi đóng**. Phần cứng đang dùng chung cảm biến E18/MC38 cho hai ngăn; cần xử lý riêng ở FIX firmware sau.
- Nếu ESP32 mất Wi-Fi sau khi gửi OTP hoặc quá 10 phút chưa đóng cửa, cần nhập lại OTP. Firmware hiện chưa xử lý retry xác nhận giao/nhận khi HTTP thất bại; sẽ sửa ở đợt firmware.
- Quyền xác nhận được lưu trong RAM, nên server restart sẽ yêu cầu nhập lại OTP.
- Các thay đổi về DB atomic transaction và SLA là đợt khác.

Không commit file `.patch`, mật khẩu, `secrets.h` hoặc dữ liệu trong `data/`.
