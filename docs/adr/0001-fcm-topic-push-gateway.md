# ADR 0001：以中央 Gateway 發送活動範圍的 FCM topic 推播

- 狀態：提案中
- 提案日期：2026-09-01

## 背景

OPass 是共用 App 與平台；各活動主辦單位自行架設、維運一套 CCIP-Server。OneSignal 免費方案的規模限制不再適合約 1,277 位登入使用者的 SITCON 活動，因此新版本 App 改用 Firebase Cloud Messaging（FCM）。

公告與推播刻意是兩個獨立行為：可以只建立公告，也可以只發推播。OPass 主要服務一至三天的研討會，推播只作為可容忍延遲與漏收的公開提醒，不是必達訊息。活動後仍有影片上架、會後問卷等通知，但不延伸為隔年活動的行銷管道。

主辦方需要平台可取得的送達數與通知點擊數，以及能自行保存到隔年的 CSV；不需要 OPass 追蹤表單填寫、網站瀏覽、現場參與或其他轉化，也不要求活動系統長期在線。

## 決策

### 1. 服務拓撲與責任

新增獨立的中央 OPass Push Gateway repository，部署為 Cloudflare Worker，透過 FCM HTTP v1 API 發送 topic message。

| 元件 | 責任 |
| --- | --- |
| CCIP-Admin-Bueno | 由活動方 Basic Auth 保護；持有活動 Gateway key，透過 CCIP-Server 既有的 `GET roles` 取得具體角色，將「全體」展開後直接呼叫 Gateway |
| Gateway | 驗證 key、由 key 取得 `EVENT_ID`、建構 topic、呼叫 FCM 並回報 FCM 是否接受 |
| CCIP-Android、CCIP-iOS | 對每個已登入活動訂閱一個角色／推播語系 topic；處理通知顯示、點擊與 Analytics |

CCIP-Server 只提供既有的活動角色資料，不取得 Gateway key、不新增推播 endpoint，也不參與推播發送。每套 Admin 部署對應一個永久且唯一的 `EVENT_ID`，但 Gateway request 不接受呼叫端提供 `event_id` 或完整 topic；活動一律由驗證成功的 key 決定，避免主辦單位越權發送。

### 2. Topic 契約

topic 格式為：

```text
opass-v1.<EVENT_ID>.<ROLE>.<PUSH_LOCALE>
```

例如：

```text
opass-v1.SITCON_2027.audience.zh-Hant
```

規則：

- `EVENT_ID` 與 `ROLE` 必須符合 `[A-Za-z0-9_-]{1,64}`。
- 英文 `en` 與正體中文 `zh-Hant` 內容皆為必填；`PUSH_LOCALE` 目前啟用這兩種語系。
- App 介面語言與推播語系分開處理。App locale 為 `zh` 或其延伸標籤時，使用 `zh-Hant`，正體與簡體介面共用正體中文推播內容；`nan-Hant-*` 與 `nan-Latn-*` 使用 `zh-Hant`。其他語系使用 `en`。App 選擇 `x-default` 時，先解析目前的系統 locale。App 介面保留既有翻譯與語言選項。
- 不建立 `.all` topic。Admin 透過 CCIP-Server 既有的 `GET roles` 取得可選角色；選擇「全體」時由 Admin 展開並傳送完整 `roles[]`。Gateway 對每個 role 與 locale 各送一次 FCM topic message。
- App 只有在活動登入成功後才訂閱。跨裝置同步、備份還原或 Keychain 中出現 token，不等於在本安裝登入成功；須先向對應活動服務驗證成功並確認活動與角色。每個 App 安裝實例可同時訂閱多個活動，但同一個 `EVENT_ID` 最多保留一個 OPass topic，對應該活動目前的角色與推播語系。切換目前顯示的活動不會取消其他已登入活動的訂閱。
- 再次成功登入同一活動的不同身分時，新身分只取代該活動的舊身分。Android 目前沒有登出功能；iOS 登出時只移除該活動的訂閱。成功登入、重新載入參與者資料造成角色變更、明確失效的登入資料清理、登出、推播語系變更、FCM registration 更新及 App 啟動時，都必須重新比對並同步所有已登入活動，不只目前畫面上的活動。
- 驗證請求須綁定發起時的 `EVENT_ID` 與登入身分版本；套用成功或失敗結果前，確認該活動的身分仍未被登出、重新登入或同步帶入的新 token 取代。過期回應不得覆蓋角色、清除新憑證或觸發訂閱；資料寫入與清理以請求所屬活動為準，不以回應時目前開啟的活動決定。這項檢查與狀態更新須連續完成，不能只靠序列化後續 SDK 操作避免舊結果覆蓋新身分。
- App 依活動分開保存「已驗證登入身分／角色」與「本安裝的訂閱套用狀態」。同一活動的 SDK 訂閱操作須序列化，先取消舊 topic，再訂閱新 topic。發起 SDK 操作前就持久化待完成轉換，包含可能已訂閱、但尚未確認寫入本機的目標 topic；不能只保存最後一次成功的 topic。重新啟動或身分再次改變時，先清理可能殘留的 topic，再收斂到目前已驗證的目標，避免 SDK 成功、本機寫入前中斷後留下兩個角色訂閱。使用本機狀態與既有 SDK 重試，不新增中央裝置資料庫；切換期間短暫漏收可接受。
- 訂閱套用狀態與待完成轉換只屬於該安裝，不跨裝置同步或從備份沿用；新安裝不能拿還原的「已訂閱」標記跳過訂閱。
- 某活動明確登出或登入憑證確認失效時，只移除該活動既有的 OPass topic。離線、伺服器暫時失敗或本機憑證讀取失敗，不得當成登出、角色撤銷或清空所有訂閱；保留既有已驗證狀態，待下次驗證。失敗 HTTP 狀態須按活動服務的實際語意判斷，不能將所有 `403` 都當成 token 失效。
- topic 名稱不是授權機制。因推播保證是公開資訊，使用者自行得知或訂閱其他 topic 不構成資料外洩；發布權限仍由 Gateway key 控制。

每個 request 最多接受 8 個角色。兩個語系、每個可重試錯誤最多重試一次時，最多需要 32 次 FCM subrequest；再加上一次 OAuth access token request，共 33 次。Cloudflare Workers Free 每次 invocation 最多允許 50 個 subrequest，尚有 17 次餘裕。這是部署方案限制，不是產品需求；開發初期可使用 Free，正式運作若其他外部 subrequest 超出此上限，應改用 Workers Paid。

Cloudflare Workers 每次 invocation 最多可同時等待 6 個外部連線，因此 Gateway 同時最多發送 6 個 FCM request；不可一次並行送出全部 role-locale 組合。這只限制 Gateway 的呼叫方式，不改變 API 契約或 FCM fanout 結果。

### 3. API 與發送語意

`openapi.yaml` 是 CCIP-Admin-Bueno 瀏覽器端到 Gateway 的正式契約。核心 request 為：

```json
{
  "roles": ["audience", "staff"],
  "contents": {
    "en": "Lunch is ready.",
    "zh-Hant": "午餐已經準備好了。"
  },
  "uri": "https://sitcon.org/"
}
```

Gateway 以 key 所屬活動在中央登記的 `organizer_name`（例如 `SITCON`）作為通知標題、`contents` 作為通知本文，發送可由作業系統在背景直接顯示的 FCM notification message，不使用依賴 App 背景執行的 data-only message。主辦名稱不得為空白或含控制字元，request 不接受標題或期限。每則 message 的 data 都包含由 Gateway key 取得的 `event_id` 與同一次操作的 `push_id`；request 提供 `uri` 時一併包含，且所有 value 都是字串。

Android 使用 FCM normal priority；App 建立固定 ID 為 `announcements`、`IMPORTANCE_DEFAULT` 且使用預設提示音的 notification channel。Apple 平台使用 `apns-priority: 5` 與預設提示音，並設定 `aps.mutable-content: 1` 供最小 FCM Notification Service Extension 匯出送達資料。兩個平台都不由 Gateway 設定或累加 badge。

App 以 `push_id` 判斷是否由推播通知啟動。有 HTTPS `uri` 時開啟該 URI；沒有 `uri` 時依 `event_id` 進入發送活動的公告頁，即使該活動並非目前顯示的活動。`event_id` 僅供導頁，不是登入或角色證明。Admin request 不包含 `event_id` 或公告 ID；Gateway 不讀寫公告。

FCM topic message 的 payload 上限為 2,048 bytes，包括 key 與 value。OpenAPI 的 `maxLength` 計算字元而非 UTF-8 bytes，因此 Gateway 必須先建構所有 FCM message，連同中央標題與 APNs 設定，確認每則序列化後的 payload 均未超過上限，再開始發送；任一則超過上限即回傳 `400`，避免部分送出。

#### 一小時有效期限

- 每筆通過驗證的發送操作以 Gateway 時間記錄 `created_at`，並固定 `expires_at = created_at + 3600 秒`。呼叫端不能指定或延長期限。
- Android 設定 `android.ttl` 為距離同一 `expires_at` 的剩餘秒數（首次最多 `3600s`）；Apple 設定 `apns-expiration` 為該時間的 Unix 秒數字串。同一操作的所有角色、語系與有限重試共用期限，不因重試重算一小時。
- 期限已到時，不再開始 FCM request。這是平台保留、嘗試送達的期限，不是完整送達保證，也不會撤除已顯示的通知、阻止稍後點擊或讓 HTTPS 網址失效。延遲、平台合併通知或到期未送達均可接受，不補送。

#### 發送結果與有限重試

每次操作產生一個 `push_id`，同一操作的所有 FCM message 使用相同 Analytics label。只有所有 fanout request 都被 FCM 接受時才回傳成功；FCM message ID 證明 FCM 已接受，並不證明裝置已送達或使用者已開啟。

Gateway 僅對 FCM 明列為暫時性錯誤的 `INTERNAL`（500）與 `UNAVAILABLE`（503）重試，最多一次，並遵守 `Retry-After` 與 exponential backoff。FCM `QUOTA_EXCEEDED`（429）要求至少一分鐘的初始退避，不在同步 Admin request 內自動重試。驗證、授權與其他永久性錯誤不得重試。

若無法確認所有 role-locale 組合都已接受，回傳 `incomplete`，將未確認接受的項目區分為 `rejected`（收到明確拒絕）、`not_attempted`（尚未送往 FCM）及 `unknown`（已嘗試，但未取得可判定結果）。OAuth 失敗時，尚未派送的項目是未嘗試，不能假裝成 FCM 拒絕訊息。每個組合恰好出現在接受或未確認接受清單一次，不重複計入有限重試。

Gateway 不提供 exactly-once 或完整送達保證，不重試傳輸結果未知的請求，也不重送整筆操作。若整個 HTTP 回應遺失，Admin 只顯示「結果未知，可能已有部分送出」，不可宣稱全部失敗或安全重送。本版接受漏收，不增加部分補送、狀態查詢、人工恢復、佇列或 idempotency store；介面不得提供以失敗項目重送的功能。

### 4. 憑證與治理

Firebase service account JSON 只存於 Cloudflare Worker secret。Gateway 以它換取短效 OAuth 2.0 access token，再呼叫 FCM HTTP v1 API；不把 Firebase 憑證交給活動主辦單位，也不放入 repository。service account 只授予發送所需的 `cloudmessaging.messages.create` 權限，不授予 topic subscription 管理或其他 Firebase 資源權限。

每個活動另有一把高熵、可撤銷的 Gateway bearer key：

1. OPass 開發團隊產生 key，將 SHA-256 digest、永久 `EVENT_ID` 與允許的 Admin origins 存入 Gateway 的 Cloudflare secret；明文只顯示一次。
2. 明文 key 經安全的帶外管道交給活動技術負責人，放入受 reverse proxy Basic Auth 保護且不快取的 Admin runtime config。
3. 所有能進入 Admin 的活動主辦方人員都被視為有權讀取並使用 key；這是接受的治理邊界。key 不得進入公開 repository、未受保護的靜態檔、App 或 log。
4. 輪替時可短暫讓同一 `EVENT_ID` 有兩個有效 digest；確認新 key 生效後撤銷舊 key。

初期以單一 JSON secret 保存少量 digest-to-event 對應。接近 Cloudflare 單一變數大小限制，或需要多人同時管理、稽核與立即撤銷時，再改用 D1；不預先建立管理後台或 key-management API。

Admin 以 `Authorization: Bearer <Gateway key>` 直接呼叫 Gateway。Gateway 的 preflight 只允許全域登記的 Admin origin，明列 `Authorization` 與 `Content-Type`，不得使用 `*`；實際 GET／POST 還須確認 `Origin` 屬於該 key。允許瀏覽器讀取的回應須包含對應 origin 的 CORS headers，並 expose `Retry-After`；完整規則見 OpenAPI。CORS 只限制瀏覽器，不能取代 bearer key 驗證；活動 key 若外洩，仍須以撤銷、輪替、rate limit 與 audit log 控制濫用。

#### 活動資料與發布期限

OPass 團隊在中央按永久 `EVENT_ID` 維護 `organizer_name` 與含時區的活動結束時間 `event_ends_at`。主辦方提供名稱、日期與活動時區，由中央登記成明確時間點；不能只留下沒有時區的日期。`send_until` 固定為 `event_ends_at + 30 × 24 小時`，所有綁定同一活動的 key 共用此設定。

Gateway 在接受發送及每次準備開始 FCM request（含有限重試）時檢查期限；當目前時間大於或等於 `send_until` 時，不再發起新派送。整筆尚未開始時回傳 `403 EVENT_PUBLISHING_EXPIRED`；若 fanout 已開始，尚未派送的項目如實列為未嘗試。不取消已交給 FCM 的訊息，其一小時期限仍有效。

停發由 Gateway 強制執行，不只是在 Admin 隱藏按鈕。輪替或補發 key 不延長活動期限；缺少或不合法的中央活動設定必須拒絕發送。停發不等於 App 登出、清除公告或強制退訂，也不影響其他活動。

#### 發送前核對

Admin 先以同一把 key 呼叫 `GET /v1/context`，取得 key 實際綁定的活動、主辦名稱、停發時間及目前是否可發布。Admin 比對自己目前設定的活動；不一致、無法取得 context 或已停發時禁止送出，不能等發送成功後才比對。送出確認顯示 Gateway 回傳的活動與主辦名稱、角色、雙語內容及選填連結。此查詢不是活動目錄，也不讓呼叫端選擇發布活動；POST 仍獨立驗證 key、origin 與期限。

### 5. 可觀測性與 Analytics

- Gateway 在開始 FCM 派送前，記錄 `push_id`、由憑證取得的 `EVENT_ID`、發送時間、角色、公開標題、雙語本文與選填 URI 的對照；另記錄各角色／語系組合的 FCM message ID 與結果。發送對照用於活動 CSV，不代表 FCM 已接受；不得記錄 bearer key 或 Firebase 私鑰。
- Android 與 iOS 使用 Firebase Analytics，啟用 FCM reporting 所需的資料分享與必要的 delivery export；資料蒐集遵守 App 的隱私告知與使用者選擇，不為取得統計繞過拒絕。未提供 Analytics 資料不影響通知使用。
- Firebase 報表與 BigQuery export 使用同一個 `push_id` Analytics label，依平台彙總可取得的送達與通知開啟數。沿用平台現有功能，不新增 Gateway 報表 API、自建追蹤事件服務或報表後台。
- 不建立裝置 token/FID 中央資料庫，也不承諾逐裝置送達證明。

| 對外名稱 | 資料來源與解讀 |
| --- | --- |
| FCM 已接受 | Gateway 的 topic request 結果；不是收件人數，不可當成送達數。Firebase 的 `Sends` 同樣不能當成裝置送達 |
| 裝置送達數 | Firebase 的 Android `Received`，或已啟用 FCM BigQuery delivery export 的 `MESSAGE_DELIVERED`；依平台與來源分開呈現，不把同一資料的兩種來源相加 |
| 通知點擊數 | Firebase／Analytics 可取得的 `Opens`／通知開啟事件；官方 `Opens` 僅涵蓋背景 notification message 的開啟，不等於所有 App 開啟、網址成功載入或任何轉化 |

`Received` 與 `Impressions` 僅適用 Android；Firebase Console 報表可能因批次處理延遲最多 24 小時，BigQuery 匯入也有自己的批次延遲。數字須標示實際計數單位、來源、平台、資料涵蓋限制與統計截止時間；訊息次數或 App 安裝實例數都不得標成不重複的自然人人數。未啟用、尚未匯入、不支援或不足以提供的資料標為「無資料」並附原因，不補成 `0`。沒有觀測到不代表沒送達；不承諾即時、完整或兩平台對稱的報表。

FCM 每日最多報告 100 個不同 Analytics label。以一個 `push_id` 對應一個 label 的作法先符合目前活動頻率；超過限制的報表缺漏不能算成零。匯出需要對應個別通知，因此若全平台實測接近此上限，須先另行評估並修訂契約，不能直接改成活動／日期 label 而失去逐筆對照。

#### Apple 送達資料

iOS 移除 OneSignal SDK 與其專屬實作，但保留最小 Notification Service Extension，對收到的 alert notification 呼叫 Firebase 的 delivery export API，並正常完成通知顯示。Gateway 設定 `apns.payload.aps.mutable-content: 1`；不得用主 App 背景回呼取代此 extension，也不為此改用 data-only 通知。

OPass 團隊在活動發送前完成中央 Firebase／Analytics 設定、FCM 到 BigQuery 的連結與需要的 App delivery export，確認測試數據可按 `push_id` 查得。只留 extension 而未啟用中央匯出，不能視為完成 Apple 送達統計。

#### CSV 匯出與交付

OPass 團隊負責使用 Firebase 現成 CSV 匯出；平台報表缺少的 Apple 送達數等資料，以 BigQuery／Analytics 查詢的原生 CSV 匯出補足。所需查詢與匯出流程須在活動上線前建立並驗收，不能假設專案已經具備。交付前只保留該活動的彙總資料，不讓主辦方取得整個中央 Firebase 專案或其他活動的資料。可交付多份以 `push_id` 對照的 CSV，不要求額外的合併服務。

匯出資料至少能辨識活動、`push_id`、發送時間、平台、可取得的送達數及通知點擊數，並附上來源、單位、統計截止／匯出時間與無資料原因；保留發送內容的對照，供主辦方理解是哪一則通知。不匯出 token、FID、參與者身分或逐裝置紀錄。含自由輸入文字的 CSV 必須正確逸出，並避免試算表公式注入。

FCM 的 [BigQuery 匯出欄位](https://firebase.google.com/docs/cloud-messaging/understand-delivery#what_data_is_exported_to_bigquery) 不含通知標題與本文。發送內容對照須另行保存至活動 CSV 交付完成；上線前驗收保存與匯出流程，確認原始日誌到期後仍能按 `push_id` 對應通知內容及成效。

CSV 依主辦方需要匯出，標示實際統計截止與匯出時間；交付時點不綁定活動停發時間。OPass 團隊須在相關原始紀錄清理前完成所需資料的匯出與交付，不把「停發」當成同時刪除尚未匯出的資料。主辦方自行保存 CSV 到隔年；不要求為此保留有效發布 key、維持活動系統在線或建立固定多年的中央資料保存期。

## 結果與取捨

- 一次 topic fanout 取代約 1,277 次逐裝置發送；Gateway 的 request 數量取決於角色數乘以語系數，而非登入人數。
- Admin 可直接發布，CCIP-Server 無須新增推播 endpoint 或保存憑證；活動 Gateway key 只能向所屬 `EVENT_ID` 的公開 topic 發布，中央 Firebase 權限不外流。
- 活動方接受所有 Basic Auth Admin 使用者都能在瀏覽器看到發布 key；相對風險是 key 可被複製，必須能快速輪替與撤銷。
- 不支援 OneSignal 舊版 App、雙送或相容期；只處理採用新契約的 App 版本。
- 推播與公告保持解耦；推播失敗不改寫公告，公告存在也不代表必須推播。
- FCM 開始 topic fanout 後無法取消，因此操作介面必須清楚顯示活動、角色與內容，並在送出前要求確認。

## 不在本決策範圍

- 公告的建立、保存或讀取流程
- CCIP-Serverless
- 逐裝置追蹤、私密訊息與交易型通知
- Gateway 管理後台、佇列、device registry 或自建 Analytics 系統
- UnifiedPush、本版的部分／未知結果補送、表單或現場轉化追蹤、長期報表服務
- 為本次推播整合新增登出或逐活動靜音 UI

## 驗收重點

- 相同操作各語系、角色與有限重試共用一小時期限；已顯示通知不因期限到而被宣稱撤回。
- 停發時間前可發送、到達時間即拒絕；key 輪替不能繞過，fanout 中途到期不再開始剩餘派送。
- Admin 設定活動與 key 所屬活動不同時不能送出；中央主辦名稱出現在通知與送出確認。
- 部分接受、OAuth 失敗、上游拒絕、傳輸中斷與整個回應遺失均如實呈現，不觸發補送。
- 同步 token 尚未驗證、角色改變、驗證暫時失敗、SDK 成功後 App 中斷、還原備份及切換活動均符合每活動訂閱契約。
- 舊身分的驗證成功或失效回應在新身分登入後才抵達，均不得改寫新身分或其 topic；登出後的舊回應不得恢復訂閱，活動切換後的回應不得寫入另一活動。
- Android 與 iOS 在同意蒐集的測試裝置完成可取得的送達／通知點擊紀錄，確認中央匯出可依 `push_id` 區分；CSV 的不可用資料不是零，且沒有其他活動或裝置識別資料。
- 匯出範圍內、統計截止時間前的推播均能對應通知內容；所需對照保存至 CSV 交付完成，不因原始日誌到期而遺失。

## 參考資料

- [Firebase：Send messages to topics](https://firebase.google.com/docs/cloud-messaging/send-topic-messages)
- [Firebase：Send a message using FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
- [Firebase：Set message type](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type)
- [Firebase：Set and manage message priority](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority)
- [Firebase：Set the lifespan of a message](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan)
- [Firebase：HTTP v1 Message reference](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages)
- [Firebase：FCM error codes](https://firebase.google.com/docs/cloud-messaging/error-codes)
- [Firebase：Understanding message delivery](https://firebase.google.com/docs/cloud-messaging/understand-delivery)
- [Firebase：Firebase Cloud Messaging IAM permissions](https://firebase.google.com/docs/projects/iam/permissions#cloud-messaging)
- [BigQuery：Exporting table data](https://cloud.google.com/bigquery/docs/export-file)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
