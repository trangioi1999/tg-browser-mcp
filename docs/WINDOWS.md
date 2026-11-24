# Cài đặt và cấu hình trên Windows

Hướng dẫn cho Windows 10/11, dùng PowerShell. Mọi lệnh chạy bằng tài khoản thường, không cần quyền Administrator.

## 1. Chuẩn bị

| Cần có                                      | Cách cài                                                         | Kiểm tra                      |
| ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| Node.js 20.10 trở lên (khuyên dùng bản LTS) | `winget install OpenJS.NodeJS.LTS`                               | `node -v`                     |
| Git                                         | `winget install Git.Git`                                         | `git --version`               |
| Chrome hoặc Edge                            | Edge có sẵn trên Windows; Chrome: `winget install Google.Chrome` | `node dist\index.js browsers` |

Sau khi cài Node bằng winget, **mở cửa sổ PowerShell mới** để `node` và `npm` có trong PATH.

## 2. Cài đặt

```powershell
cd $env:USERPROFILE
git clone https://github.com/trangioi1999/tg-browser-mcp.git
cd tg-browser-mcp
npm ci
npm run build
node dist\index.js doctor
```

`doctor` kiểm tra Node, trình duyệt, cấu hình, thư mục dữ liệu, proxy và TLS. Đã có Chrome hoặc Edge thì
không cần tải trình duyệt của Playwright.

Nếu PowerShell báo `npm.ps1 cannot be loaded because running scripts is disabled`, gọi `npm.cmd` thay cho
`npm` (ví dụ `npm.cmd ci`). Không cần nới lỏng execution policy của máy.

## 3. Một file cấu hình dùng chung

Tiến trình MCP chỉ tự tìm `tg-browser.config.json` trong **thư mục mà nó được khởi chạy**. Claude Desktop
và nhiều client khác khởi chạy MCP từ thư mục của chính client, nên file đặt trong thư mục dự án sẽ không
được đọc. Cách chắc chắn: đặt một file cố định và truyền `--config` cho **cả client MCP lẫn dashboard**.

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.tg-browser" | Out-Null
@'
{
  "tools": { "profile": "developer" },
  "journal": { "enabled": true },
  "recording": { "video": "off" },
  "output": { "screenshots": "both" }
}
'@ | Set-Content -Encoding utf8 "$env:USERPROFILE\.tg-browser\tg-browser.config.json"
```

- Thư mục dữ liệu mặc định là `%USERPROFILE%\.tg-browser`, gồm journal, ảnh, video, trace, workflow và
  session đã lưu. Dashboard và MCP phải dùng **cùng** thư mục này.
- `output.screenshots: "both"` để ảnh chụp được lưu ra file và hiện trong dashboard.
- Đường dẫn trong JSON phải nhân đôi dấu `\`, hoặc dùng `/`. Ví dụ: `"C:\\Users\\ban\\du-an"` hay
  `"C:/Users/ban/du-an"`.

## 4. Kết nối client MCP

Thay `ban` bằng tên tài khoản Windows của bạn. **Không truyền `--profile`** nếu muốn chọn cấu hình mẫu từ
dashboard: tham số dòng lệnh luôn thắng file cấu hình.

### Claude Code

```powershell
claude mcp add tg-browser -- node C:\Users\ban\tg-browser-mcp\dist\index.js --config C:\Users\ban\.tg-browser\tg-browser.config.json
```

### Claude Desktop

Mở `%APPDATA%\Claude\claude_desktop_config.json` (gõ đường dẫn này vào thanh địa chỉ của File Explorer):

```json
{
  "mcpServers": {
    "tg-browser": {
      "command": "node",
      "args": [
        "C:\\Users\\ban\\tg-browser-mcp\\dist\\index.js",
        "--config",
        "C:\\Users\\ban\\.tg-browser\\tg-browser.config.json"
      ]
    }
  }
}
```

Thoát hẳn Claude Desktop (cả biểu tượng dưới khay hệ thống) rồi mở lại.

### Codex CLI

`%USERPROFILE%\.codex\config.toml`:

```toml
[mcp_servers.tg-browser]
command = "node"
args = ["C:/Users/ban/tg-browser-mcp/dist/index.js", "--config", "C:/Users/ban/.tg-browser/tg-browser.config.json"]
```

Các client khác: xem [CLIENTS.md](CLIENTS.md), thêm `--config` như trên.

## 5. Mở dashboard và chọn cấu hình mẫu

```powershell
cd $env:USERPROFILE\tg-browser-mcp
node dist\index.js ui --config $env:USERPROFILE\.tg-browser\tg-browser.config.json --open
```

`--open` mở trình duyệt mặc định. Giữ cửa sổ PowerShell này mở trong lúc dùng; `Ctrl+C` để tắt.

1. Vào **Cài đặt** và chọn một cấu hình mẫu:

   | Mẫu        | Profile     | Dùng khi                                    |
   | ---------- | ----------- | ------------------------------------------- |
   | Cơ bản     | `minimal`   | Thao tác web đơn giản, ít token nhất        |
   | Lập trình  | `developer` | Code và debug hằng ngày (khuyên dùng)       |
   | Kiểm thử   | `testing`   | Test feature, ghi và chạy lại workflow      |
   | Toàn quyền | `full`      | Cần nối vào Chrome đang mở hoặc upload file |

2. Bấm **Lưu cấu hình**. Bản cũ được giữ ở `tg-browser.config.json.bak`.
3. **Khởi động lại client MCP** để áp dụng.

Mỗi mẫu chỉ đổi profile và chế độ quay video. Tên miền, proxy và các cài đặt khác giữ nguyên; muốn chỉnh
thêm thì mở **Tùy chỉnh chi tiết** hoặc **JSON nâng cao**.

## 6. Biến môi trường

Mật khẩu dùng trong workflow (`${secret.TEN}`) và tài khoản proxy được đọc từ biến môi trường, không bao giờ
ghi vào file cấu hình.

```powershell
# Lâu dài cho tài khoản hiện tại (chỉ áp dụng cho cửa sổ và ứng dụng mở SAU lệnh này)
setx TG_SECRET_MAKER_PASSWORD "mat-khau-test"
setx TG_PROXY_USERNAME "ten-dang-nhap"
setx TG_PROXY_PASSWORD "mat-khau-proxy"

# Chỉ cho cửa sổ PowerShell hiện tại
$env:TG_SECRET_MAKER_PASSWORD = "mat-khau-test"
```

`${secret.MAKER_PASSWORD}` trong workflow đọc từ biến `TG_SECRET_MAKER_PASSWORD`. Tên biến cho tài khoản
proxy do bạn tự đặt: khai báo trong **Cài đặt → Tùy chỉnh chi tiết → Mạng → Proxy** (ô "Tên biến môi trường
tài khoản/mật khẩu"), ví dụ `TG_PROXY_USERNAME` và `TG_PROXY_PASSWORD` như trên.

Sau `setx`, khởi động lại client MCP (với Claude Desktop là thoát hẳn rồi mở lại) để nó nhận biến mới.

Các biến hữu ích khác: `TG_BROWSER=edge` để dùng Edge, `TG_BROWSER_HEADLESS=1` để chạy ẩn,
`TG_BROWSER_DATA_DIR` để đổi thư mục dữ liệu (đổi thì dashboard cũng phải dùng cùng giá trị).

## 7. Mạng công ty: proxy và chứng chỉ

- Chrome/Edge dùng proxy của Windows (Settings, Network & internet, Proxy). Chế độ mạng mặc định
  "Theo hệ thống" là đủ trong đa số trường hợp.
- Mạng có kiểm tra TLS (SSL inspection): CA của công ty phải nằm trong kho chứng chỉ Windows, việc này
  thường do IT cài. Với các lệnh Node (`doctor`, `network_diagnose`), trỏ thêm file CA:

  ```powershell
  setx NODE_EXTRA_CA_CERTS "C:\certs\corp-ca.pem"
  ```

- Cần tải trình duyệt Playwright qua mirror nội bộ: `setx PLAYWRIGHT_DOWNLOAD_HOST "https://mirror.noi-bo"`.
  Trình duyệt tải về nằm ở `%LOCALAPPDATA%\ms-playwright`.

Chi tiết: [PROXY.md](PROXY.md).

## 8. Xử lý sự cố

| Hiện tượng                                  | Cách xử lý                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Dashboard không thấy session hay ảnh nào    | MCP và dashboard đang dùng hai thư mục dữ liệu khác nhau. Dùng cùng `--config`, hoặc cùng `TG_BROWSER_DATA_DIR`     |
| Đổi mẫu nhưng agent vẫn thấy tool cũ        | Client vẫn truyền `--profile`, hoặc chưa khởi động lại client                                                       |
| `Error: listen EADDRINUSE 127.0.0.1:8940`   | Cổng đang bận: thêm `--port 8941`                                                                                   |
| Windows Firewall hỏi quyền khi mở dashboard | Không cần cho phép: dashboard chỉ nghe trên `127.0.0.1`, máy khác không truy cập được                               |
| `doctor` báo không tìm thấy trình duyệt     | Cài Chrome, hoặc đặt `TG_BROWSER=edge`, hoặc chạy `npx playwright install chromium`                                 |
| Lệnh mở trace                               | Dashboard đưa sẵn lệnh có dấu ngoặc kép, dán thẳng vào PowerShell: `npx playwright show-trace "C:\...\trace.zip"`   |
| Workflow tên tiếng Việt                     | Tên file tự bỏ dấu, ví dụ "Đăng nhập" thành `dang-nhap.json` trong `%USERPROFILE%\.tg-browser\workflows\<project>\` |
