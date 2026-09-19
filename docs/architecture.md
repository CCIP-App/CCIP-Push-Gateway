# 架構與流程圖解

OPass Push Gateway 把發布權限集中在中央，以活動專屬 key 隔離發布者，再由 FCM 把公開通知分送給訂閱的 App。先看 [README 的系統與信任邊界](../README.md#信任邊界)，再依下列問題閱讀。

| 想理解的問題                             | 圖解                      |
| ---------------------------------------- | ------------------------- |
| 主辦人員按下發送後，哪些事情依序發生？   | [發送時序](#發送時序)     |
| 成功、失敗與結果未知有何差別？           | [派送結果](#派送結果)     |
| 切換活動、重新登入會改變哪些通知？       | [多活動訂閱](#多活動訂閱) |
| 通知內容如何對應到主辦方拿到的成效數字？ | [CSV 交付](#csv-交付)     |

圖解依 [ADR 0001](adr/0001-fcm-topic-push-gateway.md)、[ADR 0002](adr/0002-content-export-storage.md) 與 [OpenAPI](../openapi.yaml) 說明已採用的設計。Gateway、內容匯出工具與查詢由此 repository 維護；Admin 與 App 的行為由各自 repository 實作及驗收。架構圖不代表 D1 實作、目標環境部署或跨專案整合已通過；證據要求見[測試與發布驗收](verification.md)。

## 發送時序

Admin 先核對 key 所屬活動，讓主辦人員確認活動、角色與內容，再發送。Gateway 在任何 FCM 派送前驗證全部內容並保存對照；以下呈現前置檢查與內容保存成功後的流程。

```mermaid
sequenceDiagram
    accTitle: 從活動核對到 FCM 派送的順序
    accDescr: Admin 核對活動後提出發送，Gateway 重新驗證請求、保存內容、取得 OAuth token、呼叫 FCM，最後保存並回傳已知結果。
    participant A as Admin 瀏覽器
    participant G as Gateway
    participant D as 中央 D1
    participant F as FCM

    A->>G: GET /v1/context ＋活動 key
    G->>G: 驗證 key、Origin，讀取綁定活動
    G-->>A: event_id、主辦名稱、publishing_enabled
    Note over A: 活動不符、查詢失敗或停發時禁止送出
    A->>A: 將「全體」展開為具體角色，確認雙語內容
    A->>G: POST /v1/messages ＋同一把 key
    G->>G: 重新驗證授權、活動截止、輸入與中央設定
    G->>G: 建立 push_id 與固定一小時期限<br/>檢查所有 payload 大小與活動限流
    G->>D: 保存完整內容快照
    D-->>G: 內容保存成功
    Note over G,D: 內容保存失敗即停止，不呼叫 FCM
    G->>G: 取得或重用 OAuth token
    Note over G,F: 每組角色 × 語系各一則；最多六個並行<br/>每次開始前檢查期限與派送預算
    G->>F: notification ＋ event_id ＋ push_id ＋選填 uri
    F-->>G: 接受、明確拒絕或缺少可判定結果
    G->>D: 保存已知派送結果
    Note over G,D: 結果保存失敗仍保留真實派送結果
    G-->>A: 200 accepted 或 502 incomplete
```

最多八個角色乘兩個語系，產生最多 16 組派送。每則 FCM payload 都須先通過 2,048-byte UTF-8 檢查；各組與有限重試共用同一個 `push_id` 和到期時間。

只有明確的 `INTERNAL`／500 或 `UNAVAILABLE`／503 才可能重試一次，並遵守 `Retry-After` 與剩餘預算。OAuth 失敗時沒有項目送往 FCM，各組列為 `not_attempted`。活動結束後 30 天停止新派送；整筆尚未開始就到期時回傳 `403`，已開始後則如實記錄剩餘項目。完整錯誤與 HTTP 回應見 [OpenAPI](../openapi.yaml)。

一小時是訊息嘗試送達的有效期限；活動結束後 30 天是發布者能開始新派送的截止。兩者都不會撤回已顯示的通知，也不會登出或取消 App 的活動訂閱。

## 派送結果

每組「角色 × 語系」在有限重試結束後只歸入一種結果。這些是 Gateway 能確認的派送狀態，裝置送達與通知點擊須另外看平台統計。

```mermaid
flowchart TD
    accTitle: 每組角色與語系的派送結果
    accDescr: 尚未呼叫 FCM 是未嘗試；呼叫後缺少可判定結果是未知；可判定結果則分為 FCM 已接受或明確拒絕。

    Attempt{"是否曾向 FCM<br/>嘗試該組派送？"}
    Attempt -->|否| Pending["not_attempted<br/>尚未嘗試"]
    Attempt -->|是| Known{"最終是否取得<br/>可判定結果？"}
    Known -->|否| Unknown["unknown<br/>可能已被 FCM 接受"]
    Known -->|是| Accepted{"FCM 是否接受？"}
    Accepted -->|是| Success["accepted<br/>取得 FCM message ID"]
    Accepted -->|否| Rejected["rejected<br/>FCM 明確拒絕"]
```

全部項目被接受才回傳 `200 accepted`；否則回傳 `502 incomplete`，分列已接受及其餘項目。輸入、權限、限流、中央設定或內容保存等前置失敗，則依 OpenAPI 回傳對應錯誤。

**FCM 已接受不等於裝置送達。** 若整個 HTTP 回應遺失，Admin 只能顯示結果未知，可能已有部分送出。部分或未知結果都不補送；D1 缺少派送結果紀錄也不能當成全部未送出。事故處理見[操作文件](operations.md#執行預算與事故判讀)。

## 多活動訂閱

訂閱以「App 安裝 × 已登入活動」分開維護。圖中 App 正在看活動 B，仍保留活動 A 的訂閱；每個活動各有一個對應目前角色與推播語系的 topic。

```mermaid
flowchart LR
    accTitle: 同一個 App 安裝保留多個活動的訂閱
    accDescr: 查看活動 B 不影響活動 A。兩個活動各自以已驗證角色與語系對應一個 FCM topic。

    App["同一個 App 安裝<br/>目前查看活動 B"]
    subgraph identities["依活動保存已驗證身分"]
        A["活動 A<br/>audience · zh-Hant"]
        B["活動 B<br/>staff · en"]
    end
    subgraph topics["FCM topic 訂閱"]
        TA["活動 A 的<br/>audience／zh-Hant topic"]
        TB["活動 B 的<br/>staff／en topic"]
    end
    App --> A
    App --> B
    A --> TA
    B --> TB
```

topic 格式為 `opass-v1.<EVENT_ID>.<ROLE>.<PUSH_LOCALE>`。topic 是公開通知的分組，發布權限由 Gateway key 控制。

| 變化                             | App 應有的行為                                                   |
| -------------------------------- | ---------------------------------------------------------------- |
| 切換目前查看的活動               | 保留其他已登入活動的訂閱                                         |
| 同一活動重新登入、角色或語系改變 | 依該活動目前已驗證身分，先取消舊 topic，再訂閱新 topic           |
| 某活動登出或登入憑證確認失效     | 只取消該活動的訂閱                                               |
| 跨裝置同步或備份帶入登入資料     | 先向對應活動服務驗證成功，再新增訂閱；不沿用還原的「已訂閱」標記 |
| 驗證暫時失敗                     | 保留既有已驗證狀態，稍後再驗證                                   |
| 舊身分的驗證回應較晚抵達         | 忽略過期回應；不能覆寫新身分、清除新憑證或觸發訂閱               |

套用驗證回應前，必須核對發起時的活動與仍有效的身分版本；版本檢查與身分更新須連續完成。SDK 操作另按活動序列化，先在本機保存待完成轉換與可能已訂閱的目標，再操作訂閱，讓中斷後仍能清除殘留 topic。套用狀態與待完成轉換不跨裝置同步或還原；啟動與 FCM registration 更新時重新比對各活動。

這些是 App repository 的整合契約；細節見 [ADR 0001 的 Topic 契約](adr/0001-fcm-topic-push-gateway.md#2-topic-契約)。通知點擊有 HTTPS `uri` 時開啟連結；沒有時依 `event_id` 進入發送活動的公告頁，即使它不是目前查看的活動。

## CSV 交付

通知內容與成效分別來自 D1 和原生平台，以同一個 `push_id` 對照。App 的 Analytics／delivery export 須符合使用者選擇；iOS 送達資料另需要最小 FCM Notification Service Extension 與中央匯出設定。

```mermaid
flowchart TD
    accTitle: 活動內容與原生成效的 CSV 交付
    accDescr: 中央維運者下載指定活動的內容，匯出內容 CSV 與推播清單，再用清單限定原生統計，核對後交付活動方保存，最後依約定清理。

    Records[("中央 D1<br/>推播內容快照")]
    Export["本機內容匯出工具<br/>限定活動與截止時間"]
    Content["content.csv<br/>雙語通知內容"]
    Scope["pushes.json ＋ export.json<br/>推播清單、截止與涵蓋範圍"]
    Native["Firebase／Analytics<br/>BigQuery<br/>可取得的送達與開啟資料"]
    Query["原生報表與查詢<br/>依清單限定 labels 與平台<br/>限定統計範圍"]
    Metrics["成效 CSV<br/>來源、單位、截止<br/>無資料原因"]
    Handoff["中央核對並交付<br/>以 push_id 對應內容<br/>只交付該活動資料"]
    Organizer["主辦方自行保存 CSV"]
    Cleanup["交付完成後<br/>依約定清理中央與本機資料"]

    Records -->|查詢指定活動與時間範圍| Export
    Export --> Content
    Export --> Scope
    Scope --> Query
    Native --> Query
    Query --> Metrics
    Content --> Handoff
    Metrics --> Handoff
    Handoff --> Organizer
    Handoff --> Cleanup
```

`content.csv` 提供內容對照，不代表 FCM 已接受或裝置已送達。成效可交付多份 CSV，保留平台、來源、計數單位、截止時間與無資料原因；不可把無資料補成零，或把訊息次數當成不重複的自然人人數。交付不得包含其他活動、token、FID 或逐裝置紀錄。

內容至少保存到 CSV 交付完成，停發不觸發資料清理。來源完整性、匯出介面驗證、原生查詢與交付核對見[操作與交付](operations.md#活動內容-csv)。

## 對照實作與驗收

| 閱讀範圍                     | 程式與驗證入口                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活動驗證、context 與 CORS    | [`src/index.ts`](../src/index.ts)、[`src/config.ts`](../src/config.ts)、[`test/context.test.ts`](../test/context.test.ts)                                                   |
| 輸入、期限、保存、派送與結果 | [`src/input.ts`](../src/input.ts)、[`src/messages.ts`](../src/messages.ts)、[`src/firebase.ts`](../src/firebase.ts)、[`test/messages.test.ts`](../test/messages.test.ts)    |
| 活動內容匯出與原生送達查詢   | [`scripts/export-content.mjs`](../scripts/export-content.mjs)、[`reports/fcm-delivery.sql`](../reports/fcm-delivery.sql)、[`test/export.test.mjs`](../test/export.test.mjs) |
| Admin、App、雲端及實機整合   | [跨專案與目標環境驗收](verification.md#跨專案與目標環境驗收)                                                                                                                |
