# ADR 0001：以中央 Gateway 發送活動範圍的 FCM topic 推播

- 狀態：提案中
- 提案日期：2026-09-01

## 背景

OPass 是共用 App 與平台；各活動主辦單位自行架設、維運一套 CCIP-Server。OneSignal 免費方案的規模限制不再適合約 1,277 位登入使用者的 SITCON 活動，因此新版本 App 改用 Firebase Cloud Messaging（FCM）。

公告與推播刻意是兩個獨立行為：可以只建立公告，也可以只發推播。推播只作為可容忍延遲的提醒，內容一定是公開資訊。

## 決策

### 1. 服務拓撲與責任

新增獨立的中央 OPass Push Gateway repository，部署為 Cloudflare Worker，透過 FCM HTTP v1 API 發送 topic message。

| 元件 | 責任 |
| --- | --- |
| CCIP-Admin-Bueno | 由活動方 Basic Auth 保護；持有活動 Gateway key，透過 CCIP-Server 既有的 `GET roles` 取得具體角色，將「全體」展開後直接呼叫 Gateway |
| Gateway | 驗證 key、由 key 取得 `EVENT_ID`、建構 topic、呼叫 FCM 並回報 FCM 是否接受 |
| CCIP-Android、CCIP-iOS | 登入成功後訂閱一個活動／角色／推播語系 topic；處理通知顯示、點擊與 Analytics |

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
- `PUSH_LOCALE` 只有 `en`、`zh-Hant`、`zh-Hans`。
- App locale 為 `zh-Hant`、`zh-Hans` 或其延伸標籤時，分別使用 `zh-Hant`、`zh-Hans`；`nan-Hant-*` 與 `nan-Latn-*` 使用 `zh-Hant`。其他語系使用 `en`。App 選擇 `x-default` 時，先解析目前的系統 locale。
- 不建立 `.all` topic。Admin 透過 CCIP-Server 既有的 `GET roles` 取得可選角色；選擇「全體」時由 Admin 展開並傳送完整 `roles[]`。Gateway 對每個 role 與 locale 各送一次 FCM topic message。
- App 只有在登入成功後才訂閱，且任一時間最多保留一個 OPass topic，對應目前的活動、角色與推播語系。Android 目前沒有登出功能；再次成功登入不同身分時，新身分取代舊身分。成功登入新身分、切換活動、改變推播語系或 App 啟動時，都必須重新比對並同步訂閱狀態；重複執行不得產生額外訂閱。
- App 以整個 App 共用的本機狀態保存目前 topic，不依活動分開保存。目標 topic 改變時，先取消舊 topic，再訂閱新 topic；只有新訂閱成功後才更新本機狀態，失敗則保留足供下次啟動重試的狀態。這個順序優先避免重複通知；推播僅作提醒，因此可接受切換期間短暫漏收。
- 目前活動沒有有效登入資料時，目標 topic 為空，並移除既有 OPass topic。
- topic 名稱不是授權機制。因推播保證是公開資訊，使用者自行得知或訂閱其他 topic 不構成資料外洩；發布權限仍由 Gateway key 控制。

每個 request 最多接受 8 個角色。三個語系、每個可重試錯誤最多重試一次時，最多需要 48 次 FCM subrequest；再加上一次 OAuth access token request，共 49 次。Cloudflare Workers Free 每次 invocation 最多允許 50 個 subrequest，只剩一次餘裕。這是部署方案限制，不是產品需求；開發初期可使用 Free，正式運作若仍需要完整的 8 個角色、重試空間或其他外部 subrequest，應改用 Workers Paid。

Cloudflare Workers 每次 invocation 最多可同時等待 6 個外部連線，因此 Gateway 同時最多發送 6 個 FCM request；不可一次並行送出全部 role-locale 組合。這只限制 Gateway 的呼叫方式，不改變 API 契約或 FCM fanout 結果。

### 3. API 與發送語意

`openapi.yaml` 是 CCIP-Admin-Bueno 瀏覽器端到 Gateway 的正式契約。核心 request 為：

```json
{
  "roles": ["audience", "staff"],
  "contents": {
    "en": "Lunch is ready.",
    "zh-Hant": "午餐已經準備好了。",
    "zh-Hans": "午餐已经准备好了。"
  },
  "uri": "https://sitcon.org/"
}
```

Gateway 以固定的 `OPass` 作為通知標題、`contents` 作為通知本文，發送可由作業系統在背景直接顯示的 FCM notification message，不使用依賴 App 背景執行的 data-only message。每則 message 的 data 都包含同一次操作的 `push_id`；request 提供 `uri` 時一併包含，且所有 value 都是字串。

Android 使用 FCM normal priority；App 建立固定 ID 為 `announcements`、`IMPORTANCE_DEFAULT` 且使用預設提示音的 notification channel。Apple 平台使用 `apns-priority: 5` 與預設提示音。兩個平台都不由 Gateway 設定或累加 badge。

App 以 `push_id` 判斷是否由推播通知啟動。有 HTTPS `uri` 時開啟該 URI；沒有 `uri` 時進入目前活動的公告頁。request 不包含公告 ID；Gateway 不讀寫公告。

FCM topic message 的 payload 上限為 2,048 bytes，包括 key 與 value。OpenAPI 的 `maxLength` 計算字元而非 UTF-8 bytes，因此 Gateway 必須先建構所有 FCM message，確認每則序列化後的 payload 均未超過上限，再開始發送；任一則超過上限即回傳 `400`，避免部分送出。

每次操作產生一個 `push_id`，同一操作的所有 FCM message 使用相同 Analytics label。只有所有 fanout request 都被 FCM 接受時才回傳成功；FCM message ID 證明 FCM 已接受，並不證明裝置已送達或使用者已開啟。

Gateway 僅對 FCM 明列為暫時性錯誤的 `INTERNAL`（500）與 `UNAVAILABLE`（503）重試，最多一次，並遵守 `Retry-After` 與 exponential backoff。FCM `QUOTA_EXCEEDED`（429）要求至少一分鐘的初始退避，不在同步 Admin request 內自動重試。驗證、授權與其他永久性錯誤不得重試。

Gateway 不提供 exactly-once 保證。Admin 不得在逾時或結果不明時自動重送，以免產生重複通知；確有安全重送需求時，再加入持久化 idempotency 機制。

### 4. 憑證與治理

Firebase service account JSON 只存於 Cloudflare Worker secret。Gateway 以它換取短效 OAuth 2.0 access token，再呼叫 FCM HTTP v1 API；不把 Firebase 憑證交給活動主辦單位，也不放入 repository。service account 只授予發送所需的 `cloudmessaging.messages.create` 權限，不授予 topic subscription 管理或其他 Firebase 資源權限。

每個活動另有一把高熵、可撤銷的 Gateway bearer key：

1. OPass 開發團隊產生 key，將 SHA-256 digest、永久 `EVENT_ID` 與允許的 Admin origins 存入 Gateway 的 Cloudflare secret；明文只顯示一次。
2. 明文 key 經安全的帶外管道交給活動技術負責人，放入受 reverse proxy Basic Auth 保護且不快取的 Admin runtime config。
3. 所有能進入 Admin 的活動主辦方人員都被視為有權讀取並使用 key；這是接受的治理邊界。key 不得進入公開 repository、未受保護的靜態檔、App 或 log。
4. 輪替時可短暫讓同一 `EVENT_ID` 有兩個有效 digest；確認新 key 生效後撤銷舊 key。

初期以單一 JSON secret 保存少量 digest-to-event 對應。接近 Cloudflare 單一變數大小限制，或需要多人同時管理、稽核與立即撤銷時，再改用 D1；不預先建立管理後台或 key-management API。

Admin 以 `Authorization: Bearer <Gateway key>` 直接呼叫 Gateway。Gateway 的 preflight 只允許全域登記的 Admin origin，明列 `Authorization` 與 `Content-Type`，不得使用 `*`；實際 POST 還須確認 `Origin` 屬於該 key。CORS 只限制瀏覽器，不能取代 bearer key 驗證；活動 key 若外洩，仍須以撤銷、輪替、rate limit 與 audit log 控制濫用。

### 5. 可觀測性與 Analytics

- Gateway 記錄 `push_id`、由憑證取得的 `EVENT_ID`、角色、語系、FCM message ID、結果與時間；不得記錄 bearer key 或 Firebase 私鑰。
- Android 與 iOS 使用 Firebase Analytics，並啟用 FCM reporting 所需的資料分享；iOS 依 Firebase 指引匯出 delivery metrics。
- Firebase Console 的 `Sends` 可涵蓋 Android 與 Apple 平台，但 `Received` 與 `Impressions` 僅適用 Android；`Opens` 只計入使用者開啟背景 notification message 的情況。報表資料可能因批次處理延遲最多 24 小時。
- Firebase 報表與 BigQuery export 使用同一個 Analytics label，依平台彙總可取得的送達與開啟趨勢。這些指標不是即時、完整或兩平台完全對稱的送達證明。
- 不建立裝置 token/FID 中央資料庫，也不承諾逐裝置送達證明。

FCM 每日最多報告 100 個不同 Analytics label。以一個 `push_id` 對應一個 label 的作法先符合目前活動頻率；若全平台實測超過此上限，再改成活動／日期彙總 label。

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

## 參考資料

- [Firebase：Send messages to topics](https://firebase.google.com/docs/cloud-messaging/send-topic-messages)
- [Firebase：Send a message using FCM HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
- [Firebase：Set message type](https://firebase.google.com/docs/cloud-messaging/customize-messages/set-message-type)
- [Firebase：Set and manage message priority](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-priority)
- [Firebase：FCM error codes](https://firebase.google.com/docs/cloud-messaging/error-codes)
- [Firebase：Understanding message delivery](https://firebase.google.com/docs/cloud-messaging/understand-delivery)
- [Firebase：Firebase Cloud Messaging IAM permissions](https://firebase.google.com/docs/projects/iam/permissions#cloud-messaging)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
