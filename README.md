# 餐廳預約系統

[業主看板](https://joseph-mingen.github.io/ntou-restaurant-reservations/#admin) · [LINE 訂位展示](https://joseph-mingen.github.io/ntou-restaurant-reservations/#line) · [LINE 官方帳號 @291hdbqn](https://line.me/R/ti/p/%40291hdbqn)

單店配有 6 張兩人桌、6 張四人桌。午餐營業 11:30–14:30，晚餐營業 17:00–20:00。每組最多用餐 2 小時，入座前 30 分鐘停止接受訂位。時段均為台灣時間。

## 試用展示

1. 業主看板預設顯示明天午餐的 6 組、17 人，可查看備餐量、入座分布與桌況。「當日營業預估」依所選日期的午晚餐有效訂位人數計算營業額、成本與盈餘。每位消費預設 NT$1,000、餐點成本 NT$300。每位員工月費 NT$36,000，租金與水電各 NT$6,000／月，依所選月份的實際日數攤提。成本設定保存在目前的瀏覽器。點選「分時到店」的時間後，可以在「時段客人」切換文字列表與圖像動畫。
2. 選「LINE 訂位」，使用表單預填的示例聯絡方式建立訂位。成功後，返回「業主看板」看同餐期的備餐與桌況變化。
3. 切回「LINE 訂位」。選「我的訂位」取得編號，再傳「定位 訂位編號」。選「傳送示例定位」後，看板上對應訂位會有定位連結。也可改期或取消，觀察桌位立即釋出。試訂 5 人可看到同組的兩張桌；13 人以上請聯繫店家。
4. GitHub Pages 的兩個介面使用同一瀏覽器的示例資料。用無痕視窗可以開啟一份新的示例。

## 本機驗證

需 Node.js 22 以上，無須安裝套件。

```sh
npm test
python3 -m http.server 8765 --bind 127.0.0.1 --directory site
```

開啟 http://127.0.0.1:8765/ 查看展示。HTTP 測試需系統允許在本機迴路位址啟動暫時伺服器。

## 用 LINE 實測

以手機或電腦的 LINE 與官方帳號 `@291hdbqn` 私聊。先輸入 `/help` 看完整指令。傳送 `訂位` 後在手機選日期與入座時間，再回覆 `確認 人數 姓名 電話或 Email`。電腦版可輸入 `訂位 YYYY-MM-DD`，再依回覆選擇時段。定位可選。需要讓店家參考位置時，用手機傳「定位 訂位編號」，再點 LINE 的「分享定位」選擇位置。測試期間請使用虛構的聯絡資料。

口語可輸入「明天晚上五點半，五位，有位嗎？」或「我想訂明晚五點半，六個人」。也可以問「明天晚上六點要提前多久訂位？」。如果要求 19:59 入座，系統會說明晚餐最晚 18:00 入座、最晚需在當天 17:30 前完成訂位，並列出仍開放的時段。

本次實測使用本機業主服務與臨時 HTTPS 通道。正式帳號能否回覆取決於服務、通道及頻道憑證是否有效。GitHub Pages 亦提供瀏覽器內的示例，與正式 LINE 訂位資料各自獨立。

新訂位會收到 6 位數字編號，例如 `482731`，可用於改期、取消與定位。

## LINE 與業主服務

1. 將 `.env.example` 複製到 `.env`，設定獨立、強隨機的 `ADMIN_KEY`，以及 LINE Official Account Messaging API 的 `LINE_CHANNEL_SECRET` 和 `LINE_CHANNEL_ACCESS_TOKEN`。
2. 執行 `node --env-file=.env server.mjs`。正式營運時，先核對實店桌位相鄰關係，再使用具有持久磁碟的單一 Node.js 行程和 HTTPS 反向代理。將 `data/` 納入私有備份，備份保護級別與正式業主名單相同。
3. 在 LINE Developers Console 將公開的 HTTPS `/line/webhook` 設為 Webhook URL，點 Verify 並啟用 Webhook。業主使用該服務的 `/admin`，登入後可讀取來自 LINE 的預約與定位。測試時核對同一支 LINE 私聊與業主看板。
4. LINE 指令範例如下。含空格的姓名可用 `|` 分隔姓名和聯絡方式，例如 `訂位 YYYY-MM-DD 12:00 2 Amy Chen | guest@example.test`。

| 指令 | 作用 |
| --- | --- |
| `/help` | 顯示所有指令及範例 |
| `查詢 YYYY-MM-DD` | 查詢當天所有入座選項 |
| `查詢 YYYY-MM-DD 12:00` | 查詢指定入座時間 |
| `訂位` 或 `訂位 YYYY-MM-DD` | 開始選日期與仍可預約的入座時間 |
| `確認 2 王小明 0912000000` | 選好入座時間後送出預約 |
| `訂位 YYYY-MM-DD 12:00 2 王小明 0912000000` | 一次輸入全部資料送出預約 |
| `我的訂位` | 查詢本人有效訂位 |
| `改期 訂位編號 YYYY-MM-DD 17:00 3` | 更改日期、時間或人數 |
| `取消 訂位編號` | 取消訂位 |
| `定位 訂位編號` | 在 10 分鐘內透過 LINE 分享位置 |

GitHub Pages 的 `gh-pages` 分支由 `site/` 的內容發佈，使用根目錄。正式服務、測試與文件存放於 `main`。LINE Webhook 驗證使用伺服器的簽章配置。線上接受真實客人之前，需在實際 LINE 帳號和 HTTPS 主機完成驗證，並確定保存期限、備份復原及店家管理權限在營運中可執行。

[GitHub Pages 發佈來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) · [LINE Webhook 簽章](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/) · [LINE 定位動作](https://developers.line.biz/en/docs/messaging-api/using-quick-reply/)

## 開發記錄

[規劃範圍](docs/01_規劃範圍.md) · [規格](docs/02_規格.md) · [計畫](docs/03_計畫.md) · [計畫審查](docs/04_計畫審查.md) · [TDD](docs/05_TDD.md) · [完整功能盤點](docs/06_完整功能盤點.md)
