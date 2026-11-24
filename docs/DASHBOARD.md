# Bảng điều khiển cục bộ

```sh
npm run build
node dist/index.js ui --port 8940 --open
# Hoặc sau khi cài gói:
tg-browser-mcp ui --config ./tg-browser.config.json --project demo
```

Mở URL `http://127.0.0.1:8940/?token=…` được in ra terminal. Token chỉ dùng để thiết lập cookie;
trình duyệt chuyển về `/` ngay sau đó. Mỗi lần chạy có token mới. Không chia sẻ URL này.
`--open` dùng chương trình mở URL của hệ điều hành, không chạy chuỗi shell.

Windows: xem [WINDOWS.md](WINDOWS.md) cho lệnh PowerShell, đường dẫn và cấu hình client.

Giao diện tiếng Việt hoạt động offline, không có CDN hay framework. Nền kem là mặc định; nút "Giao diện tối"
trên thanh trên cùng chuyển sang nền tối và được nhớ trong trình duyệt. Thanh điều hướng gồm:

- **Tổng quan**: phiên bản, trình duyệt, số tool theo profile, proxy, TLS, sessions và workflow gần đây.
- **Sessions**: lọc dự án/tên; dòng thời gian, ảnh (lightbox với ← → Esc), video, lỗi gộp theo nội dung,
  workflow và bước chạy, báo cáo Markdown/JUnit, tải trace và sao chép lệnh mở trace.
- **Workflows**: workflow đã lưu (`workflows/<project>/*.json`), số bước, lịch sử chạy; trang chi tiết có
  bảng các bước (chỉ đối tượng thao tác, **không bao giờ** hiện giá trị nhập), lệnh chạy lại
  (`workflow_execute`) và xuất test Playwright (`test_generate`), cùng hướng dẫn ghi một luồng mới.
- **Cài đặt**: bốn **cấu hình mẫu** ở đầu trang, rồi phần "Tùy chỉnh chi tiết" (mục lục bên trái, bảng
  bật/tắt từng tool có mô tả và ô lọc), JSON nâng cao, lỗi validation và lưu cấu hình.

## Cấu hình mẫu

| Mẫu                     | Profile     | Video              | Dùng khi                                                           |
| ----------------------- | ----------- | ------------------ | ------------------------------------------------------------------ |
| Cơ bản                  | `minimal`   | tắt                | Thao tác web đơn giản, ít token nhất                               |
| Lập trình (khuyên dùng) | `developer` | tắt                | Code và debug hằng ngày                                            |
| Kiểm thử                | `testing`   | chỉ giữ khi có lỗi | Test feature, ghi và chạy lại workflow                             |
| Toàn quyền              | `full`      | tắt                | Nối vào Chrome đang mở, upload file; tool rủi ro cao vẫn hỏi trước |

Mỗi mẫu chỉ ghi `tools.profile`, `recording.video` và `journal.enabled: true` (mẫu Toàn quyền thêm
`security.approval.highRisk: "ask"`); các trường khác giữ nguyên. Ô mẫu hiện số tool và ước tính token của
danh sách tool mà client nạp vào context mỗi phiên (cùng cách tính với `npm run schema-size`, ký tự / 4).

Tham số dòng lệnh thắng file cấu hình: nếu cấu hình client MCP có `--profile`, mẫu chọn ở đây không có tác
dụng. Tiến trình MCP chỉ tự tìm `tg-browser.config.json` trong thư mục nó được khởi chạy, nên tốt nhất truyền
cùng `--config <file>` cho cả client MCP và dashboard.

Lưu tạo bản sao `<config>.bak`, rồi thay tập tin bằng rename nguyên tử. Nếu chưa có cấu hình,
tạo `tg-browser.config.json` trong thư mục chạy dashboard. Thứ tự cấu hình vẫn là mặc định < tập tin <
biến môi trường < CLI. **Khởi động lại client MCP để áp dụng thay đổi**; dashboard không điều khiển hay
thay đổi cấu hình của tiến trình MCP đang chạy. Thư mục dữ liệu mà dashboard đang đọc cố định lúc khởi
động; khởi động lại dashboard sau khi đổi `dataDir`. Proxy chỉ nhận **tên biến môi trường** cho tài khoản
và mật khẩu. Xác minh TLS luôn bật.

## Thu thập dữ liệu

Dashboard và MCP cần cùng `dataDir`. Mỗi session ghi nhật ký vào
`journal/<project>/<session>/events.jsonl`, xoay sang `events.1.jsonl` khi đạt giới hạn, giữ tối đa hai tập
tin. Mặc định bật, 5.000.000 byte mỗi tập tin. Thư mục mới có mode 0700, nhật ký 0600. Nhật ký chỉ chứa
metadata đã lọc/redact, không chứa tham số nhập liệu, headers, cookies hay bodies. Lỗi ghi không làm
hỏng automation. Các bộ đếm chỉ phản ánh lịch sử còn được giữ, không phải tổng số suốt đời.

```json
{
  "output": { "screenshots": "both" },
  "journal": { "enabled": true, "maxBytes": 5000000 },
  "recording": { "video": "retain-on-failure", "size": { "width": 1280, "height": 720 } }
}
```

Video mặc định `off`; `on` giữ tất cả; `retain-on-failure` chỉ giữ nếu session có `action.failed` hoặc
workflow thất bại. `session_create.recordVideo` (boolean) ghi đè chế độ cho session đó: `true` luôn giữ,
`false` tắt. Hỗ trợ context thường và persistent; CDP không thể bật ghi hình cho context đã tồn tại.
Video ở `artifacts/<project>/<session>/videos/`. Đóng trang/context để hoàn tất video; chế độ chỉ giữ khi
lỗi quyết định khi đóng context. Tiến trình bị kill đột ngột có thể để lại video chưa hoàn tất.

Ảnh chỉ hiện khi đã lưu ra tập tin (`output.screenshots: file|both` hoặc truyền `path`). Trace xuất hiện
sau `browser_trace_stop`. Báo cáo từ `test_run`/`test_report` được liên kết với run; báo cáo cũ không có
metadata liên kết có thể không hiện. Các tập tin ngoài `dataDir/artifacts` không được phục vụ, kể cả khi
được một tool tạo hợp lệ ở thư mục khác. Dữ liệu session cũ trước khi bật journal không có dòng thời gian.
Không hiển thị raw storage state; saved-state chỉ có số cookies/origins và thời gian lưu.

## API và bảo mật

- Chỉ bind `127.0.0.1`, mặc định cổng 8940; `--port 0` chọn cổng trống. Host chỉ chấp nhận
  `127.0.0.1:<port>` hoặc `localhost:<port>`.
- Token ngẫu nhiên 32 byte, so sánh constant-time. `/api/*` và `/files/*` yêu cầu cookie
  `HttpOnly; SameSite=Strict; Path=/` hoặc `Authorization: Bearer <token>`.
- PUT/POST/DELETE yêu cầu Origin chính xác `http://127.0.0.1:<port>` và `X-TG-CSRF: 1`.
  PUT config phải là JSON, tối đa 1 MiB, được kiểm tra bằng cùng Zod schema với MCP.
- CSP chỉ cho tài nguyên cùng origin; không inline scripts, objects, iframe embedding hay base URL.
  `nosniff`, `no-referrer` và `no-store` được gửi trên mọi phản hồi.
- Tập tin chỉ thuộc `artifacts/` và `journal/`, kiểm tra đường dẫn thực, từ chối traversal, symlink thoát
  root và root là symlink. Không phục vụ keys, encrypted sessions, profiles, HTML hay JavaScript tùy ý.
  Video hỗ trợ single HTTP Range; ZIP/XML tải dưới dạng attachment.
- Dữ liệu website không đáng tin: UI chỉ tạo DOM qua `textContent` và thuộc tính, không chèn HTML từ dữ liệu.
  Media và links chỉ dùng URL `/files/` do API trả về.

API đọc: `/api/status`, `/api/config`, `/api/config/schema`, `/api/tools?profile=`, `/api/projects`,
`/api/sessions?project=`, `/api/sessions/:project/:name`,
`/api/sessions/:project/:name/events?type=&since=&limit=`, `/api/runs?project=`, `/api/runs/:project/:runId`,
`/api/workflows?project=`, `/api/workflows/:project/:id` (`id` là tên file không có `.json`).
`/api/status` có thêm `toolTokens` (ước tính token theo profile); `/api/tools` có thêm `description`
(câu đầu tiên) và `profile` (profile thấp nhất chứa tool).
`since` là thời gian ISO; sự kiện mới nhất ở cuối, `limit` từ 1 đến 1000.
Chỉ `PUT /api/config` thay đổi trạng thái. Dashboard không cung cấp API approval, eval hay shell.

Ảnh/video/trace có thể chứa dữ liệu nhạy cảm nhìn thấy trên trang; chúng không được redact từng pixel
hoặc DOM của trace. Token cho phép đọc các artifacts và sửa chính sách cấu hình, nên chỉ người vận hành
đáng tin được truy cập. Không đưa dashboard qua reverse proxy/tunnel hoặc expose ra mạng. Người có quyền
sửa tập tin cục bộ là trusted; đây không phải cơ chế chống một tiến trình cùng tài khoản đã bị xâm nhập.

## Kiểm thử

`tests/unit/dashboard.test.ts` chạy HTTP handler trong bộ nhớ (không cần bind socket), kiểm tra auth,
CSRF, traversal, validation, backup, Range và headers. `tests/unit/journal.test.ts` kiểm tra redaction,
rotation, quyền tập tin và cấu hình. `tests/integration/dashboard.test.ts` chạy fixture app, Chrome,
screenshot, lỗi, workflow, trace và video thật, rồi đọc lại qua TCP sau khi harness đóng.

Chạy `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`. Môi trường phải cho phép localhost
listeners và Chrome; kiểm thử integration không tự bỏ qua khi thiếu các quyền này.
