# Gateway 操作

此手冊供 OPass 中央維運者設定 Gateway 與判讀派送結果。開發與檢查使用本機環境；雲端資源與發布由具有對應權限的中央維運者操作。驗收條件與證據要求見[測試與發布驗收](verification.md)。

以下發布流程適用於通過 [D1 實作驗收](verification.md#d1-實作驗收)的版本。資料結構見 [migration](../migrations/0001_push_records.sql)。執行前核對目標 database 與程式版本；ADR 採納與文件內容不能代替部署證據。

## 開發與檢查

```sh
npm ci
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply PUSH_RECORDS --local
npm run dev
npm run check
```

範例設定為空，API 會拒絕沒有有效 key 的呼叫。完整發送流程用 `npm test` 的假 OAuth／FCM 上游驗證；RSA 金鑰僅在測試執行中產生。`npm run build` 僅 dry-run 打包，輸出在 `dist/`。

`wrangler dev --local` 只代表 bindings 在本機；填入正式 service account 後的外部 `fetch` 仍可能送出通知，因此本機開發只使用空設定或測試憑證。受限環境若禁止 runtime 綁定 loopback 通訊埠，需放行本機測試；日誌路徑可用 `WRANGLER_LOG_PATH=/tmp/opass-push-gateway-logs` 覆寫。

## 中央設定

依 ADR 0001 與 ADR 0002，Worker 的設定由兩個 secrets 與兩個 bindings 組成：

| 名稱                       | 內容與責任                                                    |
| -------------------------- | ------------------------------------------------------------- |
| `EVENT_CONFIG_JSON`        | 中央活動資料與 key digest 對應；整份 JSON 原子更新            |
| `FIREBASE_SERVICE_ACCOUNT` | 僅 OPass 團隊持有的 service-account JSON；不可給 Admin 或 App |
| `EVENT_RATE_LIMITER`       | 依永久活動 ID 共用的限流器，輪替 key 不重設計數               |
| `PUSH_RECORDS`             | 中央 D1 database，派送前保存內容，派送後保存已知結果          |

`EVENT_CONFIG_JSON` 的格式如下。零值 digest 是不能用來登入的示意值，並非已發行的 key；正式活動 ID 必須永久唯一，活動結束時間必須包含時區。

```json
{
  "events": {
    "EXAMPLE_2027": {
      "organizer_name": "活動主辦單位",
      "event_ends_at": "2027-03-13T18:00:00+08:00"
    }
  },
  "keys": [
    {
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "event_id": "EXAMPLE_2027",
      "allowed_origins": ["https://admin.example.org"],
      "state": "active"
    }
  ]
}
```

正式 key 至少使用 32 個隨機 bytes，digest 為其完整 bearer 字串的 UTF-8 SHA-256、小寫十六進位。原始 key 只交給該活動受 Basic Auth 保護、`Cache-Control: no-store` 的 Admin runtime config。Origins 是精確 origin，不含路徑或結尾斜線；正式來源用 HTTPS，本機 HTTP 僅允許 loopback。

重疊輪替時保留同一 `event_id` 的舊、新 digest；確認新設定可用後才將舊 key 設為 `revoked`。活動 ID、主辦名稱與結束時間放在 `events`，不隨 key 複製或延長。每次實際 GET／POST 都重新驗證；secret 更新的生效範圍取決於 Cloudflare 的設定傳播，撤銷後須核對實際拒絕結果。

Admin 先用相同 key 呼叫 `/v1/context`，比對其設定的活動。錯誤、活動不符或 `publishing_enabled: false` 都禁止發送。角色來自 Server 的既有 roles API；「全體」展開為具體角色，POST 不帶活動 ID。這項 UI 行為須在 Admin repository 驗收。

## 正式資源與發布

發布前確認目標 Cloudflare 帳號、Firebase 專案、活動設定與程式版本，並保留部署及環境驗收紀錄。依 [ADR 0002](adr/0002-content-export-storage.md)，啟用與使用服務均不得要求綁定有效付款方式；不能只根據「含免費用量」判定符合條件。

每次發布前核對下列服務條件，將查核日期、帳號／專案、方案、官方來源及實測結果附在發布紀錄。額度或功能不符時，先停止發布並重新評估，不默認啟用 billing 或刪除未交付內容。

| 範圍     | 查核內容                                                                                                     | 官方來源                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker   | 啟用條件、CPU、每日 requests、外部與內部 subrequests；量測冷啟動憑證處理、最大合法內容、八角色雙語及有限重試 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)                                                                                                                           |
| D1       | 啟用條件、每日讀寫列數、索引用量、單一 database 與帳號容量，以及錯誤時的行為                                 | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)                                                               |
| 原生成效 | 不綁付款方式的專案能否完成雙平台原生匯入、查詢及 CSV 匯出；核對資料到期時間與累積額度                        | [Firebase 匯出與 Sandbox](https://firebase.google.com/docs/projects/bigquery-export#pricing-and-the-bigquery-sandbox)、[Sandbox 限制](https://docs.cloud.google.com/bigquery/docs/sandbox#limitations) |

1. 由授權維運者建立中央 D1 database，將實際名稱與 ID 寫入 `wrangler.jsonc` 的 `PUSH_RECORDS`，取代本機用的零值 ID。確認目標後執行 `npx wrangler d1 migrations apply PUSH_RECORDS --remote`；migrations 納入 Git，不能以本機已套用推定遠端也已套用。操作方式見 [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)。中央維運者管理 D1 權限，Admin／App 不取得資料庫或 Cloudflare 憑證。保留待交付內容，不設定提早清理。
2. 啟用目標專案的 FCM HTTP v1 API。service account 的自訂 IAM role 僅含 `cloudmessaging.messages.create`；不要用 Firebase Admin、Editor 或 Owner 代替。Worker 固定向 Google OAuth endpoint 取 token，只要求 `firebase.messaging` scope，不跟隨 redirect。[權限來源](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging)
3. 透過受保護的秘密管理流程輸入下列 secrets；不把 JSON、bearer 或私鑰放進命令列參數、Git 或 CI 日誌。

   ```sh
   npx wrangler secret put EVENT_CONFIG_JSON
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
   ```

4. 在部署設定中指定中央 HTTPS route／custom domain；`workers_dev` 與 preview URL 維持關閉。正式端點以中央部署紀錄為準，不能僅憑 OpenAPI 的規劃網址推定服務可用。確認 rate-limit namespace 未與無關 Worker 共用，再執行核准版本的 `npx wrangler deploy`。
5. 以有效 key 驗證 context、未登記 origin、撤銷 key、跨活動 origin 與活動截止；這些檢查不需要發送通知。另取得測試活動與裝置的通知授權後，再驗收實際發送、顯示、點擊與統計。

## 執行預算與事故判讀

每活動預設每 60 秒最多六次發送操作，設定在 `wrangler.jsonc`。Cloudflare 原生 rate limiter 是依位置運作的近似防濫用限制，不是全球精確配額；只有觀測到跨位置濫用時才需要重新評估限流架構。[原生限流語意](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)

一次最多八角色乘雙語系、六個並行 FCM requests；只有 `INTERNAL`／500 與 `UNAVAILABLE`／503 可對該項重試一次。上游 timeout 最多十秒，派送預算從建立 `created_at` 起算三十秒，包含派送前的限流、內容保存與 OAuth 等待；遇到較長 `Retry-After` 時保留拒絕結果，不提前重試。三十秒是停止開始新派送的預算，不是整個 HTTP 回應的完成保證，D1 結果保存仍可能增加回應時間。所有 FCM requests 使用相同一小時到期時間，活動結束加三十天亦會停止開始新 request。

依 ADR 0001，外部請求最多為 32 次 FCM 加一次 OAuth。D1 的服務操作另依實際 SQL 與平台限制核算；索引及匯出查詢也會消耗用量，不能只數程式中的 SQL 呼叫次數。

| 結果                           | 判讀與處理                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------- |
| `200 accepted`                 | 每個 topic message 都被 FCM 接受；不代表裝置送達                              |
| `400`／`401`／`403`／`429`     | 尚未開始 FCM；檢查內容、key、origin、截止或限流                               |
| `500`                          | 尚未開始 FCM；檢查中央設定與內容保存                                          |
| `502 incomplete`               | 逐項看 `accepted`、`rejected`、`not_attempted`、`unknown`；不可整筆或部分補送 |
| 逾時、斷線、缺少完整 HTTP 回應 | 結果未知，可能已有派送；不可自動重送                                          |
| `RESULT_RECORD_FAILED` 日誌    | FCM 結果已產生但 D1 結果保存失敗；HTTP 仍回傳真實結果，可由該日誌保留已知結果 |

D1 紀錄以活動 ID 與 `push_id` 識別，保存完整內容快照及可取得的派送結果。缺少結果不等於未發送，內容存在也不等於發送成功；D1 與 FCM 沒有跨服務交易。日誌僅輸出正規化結果與原因，不記錄 upstream diagnostic body、Authorization、OAuth token 或私鑰。先檢查中央設定、D1 狀態／用量與相同 `push_id` 的紀錄；沒有補送或操作狀態 API。

## 備份與清理

中央維運者依資料變動與可接受的遺失範圍安排備份，並在 schema 變更或清理前保存可還原副本。D1 的 [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) 是有限的事故恢復窗口，與內容保存到交付完成的期限分開管理。

完整 SQL 備份可使用 [Wrangler `d1 export`](https://developers.cloudflare.com/d1/wrangler-commands/)，以新檔名保存到受控位置。完整匯出期間資料庫會無法服務其他查詢，須安排在不需派送的時段；限制見 [D1 import／export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)。備份可能包含多個活動，僅由中央保管，不作為活動交付檔案。

還原前核對時間點、受影響活動及之後新增的內容；還原不重送任何通知。清理只限已完成交付且到達約定清理日的活動與時間範圍，先用相同條件查詢核對筆數，再由獲授權維運者刪除。備份及本機匯出檔案也須符合約定的保存範圍。
