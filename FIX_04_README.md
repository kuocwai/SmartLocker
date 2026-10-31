# FIX 04 — ESP32 sensor confirmation / HTTP delivery reliability

## Phạm vi

- Firmware chỉ gửi `ITEM_STORED` / `ITEM_PICKED` sau **mở cửa ổn định 400 ms**, sau đó **đóng cửa + trạng thái hàng phù hợp ổn định 400 ms**.
- Chỉ hiển thị hoàn tất khi Backend trả **HTTP 200**, JSON `success: true` và `locker_status` phù hợp (`STORED` hoặc `AVAILABLE`).
- Khi Wi-Fi mất, timeout, HTTP 5xx hoặc ACK không chắc chắn, firmware giữ sự kiện chờ trong RAM và thử lại mỗi 3 giây. Không báo hoàn tất sai.
- Nếu cửa/hàng thay đổi sau khi đã xác nhận nhưng trước lúc gửi lại, firmware dừng để kiểm tra thủ công thay vì gửi dữ liệu cảm biến đã cũ.
- HTTP 4xx / API từ chối: dừng và hiển thị **CAN KIEM TRA**, không tự sửa trạng thái hoặc bỏ qua. Phải kiểm tra Backend thủ công.
- OTP chỉ kích relay sau HTTP 200, JSON thành công, vai trò hợp lệ và ID ngăn 1/2. Giữ nguyên GPIO và xung relay 800 ms.
- Bổ sung hàm `DoorCycle` thuần C++ để kiểm tra debounce không cần ESP32 (nếu máy có g++).

## Tại sao không tự retry vô hạn HTTP 409?

Có thể Backend đã nhận sự kiện nhưng phản hồi HTTP bị mất, sau đó gửi lại sẽ nhận `409` do sự kiện đã được xử lý. Ngược lại `409` cũng có thể là sai trình tự thực sự. Firmware không thể phân biệt hoàn toàn qua API hiện có, vì vậy **dừng an toàn và báo cần kiểm tra thủ công**, không giả định thành công.

## Giới hạn chưa giải quyết

- **Một E18 + một MC-38** được khai báo cho hệ thống **hai ngăn**. Chỉ xác minh được đúng từng ngăn nếu dây cảm biến thực tế tương ứng/ngăn đang thao tác; cần kiểm tra sơ đồ đấu dây trực tiếp, không thể khắc phục bằng code.
- Sự kiện chờ giữ **trong RAM**, sẽ mất khi ESP32 mất điện/reboot. Không khẳng định giao dịch phục hồi sau reboot hoặc đồng bộ 100% khi ACK bị mất. Muốn phục hồi chắc chắn cần thiết kế giao thức có `event_id`, xác nhận idempotent ở Backend và lưu bền vững trên ESP32.
- `WiFi`/HTTP có thể chặn loop tối đa timeout trong khi POST; cần đo thực tế.
- Không tự động cho phép nhập OTP mới khi còn sự kiện chờ hoặc trạng thái cần kiểm tra. Khi cần xử lý thủ công, đối chiếu tình trạng vật lý, đơn hàng và trạng thái Backend **trước** khi khởi động lại ESP32.
- Không thêm sự kiện `SENSOR_SYNC` liên tục vì cảm biến hiện không phân biệt hai ngăn, có thể ghi trạng thái sai ngăn.

## Kiểm thử tự động

Sau khi áp dụng:

```powershell
node --test tests/fix01.test.js tests/fix02.test.js tests/fix03.test.js tests/fix03_remaining.test.js tests/fix04_firmware.test.js
```

Các kiểm thử mới xác minh tích hợp ở mức source và chính sách debounce C++ với `g++` nếu có; **không phải compile firmware Arduino hay chạy ESP32 thật**. Nếu thiếu `g++`, bài test C++ sẽ SKIP. Test Node backend trước đây có thể vẫn chạy JSON fallback; phải xác nhận log để biết SQLite đã được kiểm thử hay chưa.

## Checklist ESP32 thật (bắt buộc trước khi triển khai)

1. Đối chiếu GPIO, cực tính cảm biến, cách bố trí E18 + MC-38 theo từng ngăn; relay ở HIGH khi không mở khóa.
2. Với OTP đúng, quan sát mở khóa đúng ngăn 800 ms; mã sai / HTTP 401 / 5xx không mở khóa.
3. Sau OTP đúng, giữ cửa đóng dù cảm biến hàng đã khớp: **không gửi sự kiện**.
4. Mở cửa ít nhất 400 ms, đóng và giữ trạng thái hàng đúng ít nhất 400 ms: **một** sự kiện được Backend ghi nhận.
5. Đưa cảm biến bị rung/dao động dưới 400 ms, hoặc mở lại cửa khi đang đóng: **không hoàn tất sớm**.
6. Ngắt Wi-Fi trước khi đóng cửa: không báo hoàn tất; nối lại rồi kiểm tra API được ACK và dashboard đồng bộ.
7. Cho Backend trả HTTP 403/409: hiển thị `CAN KIEM TRA`, không báo thành công, không nhận OTP mới.
8. Giả lập Backend đã xử lý sự kiện nhưng response bị mất: kiểm tra bước xử lý thủ công; không giả định retry 409 là thành công.
9. Reboot khi có sự kiện chờ: ghi nhận đây là **giới hạn chưa được giải quyết**, phải kiểm tra Backend và ngăn tủ trước khi tiếp tục.
10. Kiểm tra cả giao đồ và lấy đồ trên **cả hai ngăn**, màn hình LCD, keypad I2C, Wi-Fi reconnect, SLA và ESP32 watchdog.
