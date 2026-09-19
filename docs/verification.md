# Gateway 測試與發布驗收

Gateway 驗證分為 repository 自動檢查、跨專案整合與目標環境驗收。每項結果須綁定程式版本及執行環境；本機 mock 測試不能證明正式憑證、APNs 或原生統計匯出可用。

## 自動檢查

使用 Node.js 24 LTS 與 npm 11，依 [`.node-version`](../.node-version) 安裝預設 Node 版本，先執行 `npm ci`，再執行 `npm run check`。命令由 [`package.json`](../package.json) 定義，[CI](../.github/workflows/check.yml) 讀取同一版本檔並執行相同流程。

| 命令                     | 驗證範圍                                                                    |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run format:check`   | Prettier 納管檔案的格式；排除項目見 [`.prettierignore`](../.prettierignore) |
| `npm run typecheck`      | 依 Worker 設定重建型別，再檢查 Worker 與 TypeScript 測試                    |
| `npm run contract:check` | OpenAPI YAML 語法、重複鍵與本機 `$ref` 目標；不等同完整 OpenAPI 語意驗證    |
| `npm test`               | Workers runtime API 測試與 Node.js 原生 CSV／CLI 測試                       |
| `npm run build`          | Wrangler dry-run 打包及 binding 設定檢查，不部署                            |

API 測試在本機 Workers runtime 執行，攔截所有 OAuth／FCM `fetch`；RSA 金鑰在測試執行時產生。每次派送測試透過官方 `applyD1Migrations` 在隔離的 D1 套用 repo migrations。CSV 測試使用暫存檔案，另以 Wrangler `--local` 建立暫存 D1，執行 migrations、內容查詢與匯出。測試環境須允許 loopback 通訊與測試子程序，無須正式 Cloudflare／Firebase 憑證。

| 行為           | 主要案例與原始碼                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活動與來源隔離 | 無效／撤銷 key、跨活動 origin、preflight、呼叫端指定活動、重疊輪替與共用截止時間；[`context.test.ts`](../test/context.test.ts)                                                  |
| 輸入與內容限制 | 拒絕 `all`、完整 topic、裝置識別、非法角色／語系／URI；所有 UTF-8 payload 在派送前檢查；[`messages.test.ts`](../test/messages.test.ts)                                          |
| 派送結果與期限 | OAuth 簽章、雙語 fanout、六個並行上限、固定期限、有限重試、活動截止，以及 accepted／rejected／not_attempted／unknown 的完整分組；[`messages.test.ts`](../test/messages.test.ts) |
| 保存與敏感資料 | D1 寫入失敗或未新增紀錄不得發送；結果寫入失敗及找不到原紀錄時保留真實 HTTP 結果，日誌不含憑證；[`messages.test.ts`](../test/messages.test.ts)                                   |
| 活動內容交付   | 原生 D1 查詢、活動與截止邊界、來源截斷及身分不符、CSV 逸出、公式注入防護、重複或損壞紀錄、缺少派送結果與 CLI 操作；[`export.test.mjs`](../test/export.test.mjs)                 |

HTTP 契約修改須一併核對實作與回歸案例。文件變更檢查相對連結、命令與來源一致性；OpenAPI 描述變更仍須執行 `contract:check`。測試數量與打包大小取自指定版本的執行結果，不寫成持續有效的專案屬性。

Mermaid 圖解須對照契約與實作，另行渲染檢查語法、文字、連線與版面；`npm run check` 不包含 Mermaid 渲染。

## 工具鏈維護

Node 使用 LTS 主版本；預設版本及其隨附 npm 由 `.node-version` 對應的 Node 發行版提供，`package.json` 的 `engines` 宣告支援範圍。Node 的更新一併修改版本檔並執行檢查，不由套件更新順帶切換主版本。

直接開發依賴採精確版本，與 `package-lock.json` 一起更新；安裝使用 `npm ci`。維護時選擇符合既有環境與 peer dependencies 的最新穩定版本。Wrangler、Cloudflare Vitest plugin 與 Vitest 須作為相容組合檢查；若整合尚未支援新版主版本，保留最新的相容版本，並在更新紀錄說明原因，不使用 `--force` 或 `--legacy-peer-deps` 略過相容性檢查。

Workers 型別使用官方 [`wrangler types`](https://developers.cloudflare.com/workers/languages/typescript/)，依 `wrangler.jsonc` 的 bindings、`compatibility_date` 與 flags 產生至 `.wrangler/types/worker-configuration.d.ts`。安裝與型別檢查會重建產物，Git 與 Prettier 均排除產物；秘密欄位由 `src/types.ts` 明列，不依賴某台設備的 `.dev.vars`。相容日期啟用的 Node API 另載入 `@types/node`，其主版本配合 Node 24 維護基準。`compatibility_date` 控制 Workers API 行為，與 Node 或工具套件版本分開審核及驗證。

更新後執行 `npm ls --depth=0` 與完整 `npm run check`。工具鏈或安裝流程變更另以沒有 `node_modules`、`.wrangler`、`.dev.vars` 的乾淨副本執行 `npm ci` 與 `npm run check`，確認不依賴全域 Wrangler、本機憑證或未提交產物，且安裝與檢查不修改受版本管理的檔案。

## D1 實作驗收

[ADR 0002](adr/0002-content-export-storage.md) 採用 D1；發布版本必須以實際 D1 binding 與 schema 通過下列檢查。以該版本測試結果確認涵蓋範圍，不以 ADR 狀態代替實作驗證。

- `wrangler.jsonc`、Worker 型別與保存程式一致使用 D1；schema 與 migrations 納入版本管理，能在本機建立同樣的資料結構。活動 key 對應仍使用中央 secret。
- 在本機 D1 執行內容及結果保存測試：內容保存失敗不得呼叫 FCM；結果保存失敗仍保留內容並回報真實派送結果；缺少結果不得被視為未發送或觸發補送。
- 以實際 D1 查詢輸出驗證本機匯出器，涵蓋活動／截止隔離、來源筆數、身分不符、來源截斷、重複或損壞紀錄、CSV 逸出及公式注入防護。
- 以該版本實際成功的查詢與 CLI 命令核對操作文件，確認發布版本提供所需的輸入格式。資料備份與活動交付用途分開，匯出不包含其他活動或逐裝置資料。

D1 實作驗收與雲端服務條件、帳號設定及實機成效驗收分別記錄；任一必要條件未完成時，不發布整合功能。

## 跨專案與目標環境驗收

App 統計選擇須在該流程實作前定案；未定案時可先完成 Gateway、Admin、通知訂閱與導頁，統計選擇流程保留待決，不以現有 Analytics 開關推定產品決策。各活動設定、資料交付與清理約定、維運責任及服務條件須在正式發布前確認。Gateway 執行、內容保存及原生成效交付均不得要求綁定有效付款方式；不符合時重新評估決策，不自動升級付費。這些前置條件與架構採納分別記錄，不以 Gateway 自動測試通過代替。

驗收使用獲授權的測試活動、帳號與裝置；流程與設定入口見[操作文件](operations.md)。

跨專案工作分別追蹤於 [Admin #50](https://github.com/CCIP-App/CCIP-Admin-Bueno/issues/50)、[Android #128](https://github.com/CCIP-App/CCIP-Android/issues/128) 與 [iOS #68](https://github.com/CCIP-App/CCIP-iOS/issues/68)。實作與驗收須記錄各 repo revision，並核對 issues 引用的契約版本與本 repo 已採用的 ADR、OpenAPI 一致。

App 整合依選定 SDK 的官方文件與 release notes 核對 FID registration、APNs 及統計 API，套件版本與 lockfile 一起更新。驗收須涵蓋既有安裝升級、快取 registration 及語系切換；只驗證乾淨安裝不足以確認訂閱恢復。Admin 擴充既有 Playwright smoke 與 mock，不另建測試框架。

iOS 的 SwiftUI delegate 須依 [Firebase 官方接收指引](https://firebase.google.com/docs/cloud-messaging/ios/receive-messages#handle_messages_with_method_swizzling_disabled)明確轉交 APNs token，並接妥 `appDidReceiveMessage` 所需的收到／點擊回呼；不能只在停用 swizzling 時才檢查手動串接。以實機驗證允許蒐集時的原生統計既不漏報也不重複計數，拒絕或撤回時停止蒐集，通知顯示與導頁仍正常。

實機測試前準備以下資訊；憑證透過受保護的管道提供，repo／issue 只記錄設定需求、取得方式及不含秘密的驗收結果：

- 測試活動的永久 ID、主辦名稱、結束時間、Server URL、具體角色，以及可驗證的測試登入資料。驗收環境須讓 App 能取得並核對該活動設定；一次性活動入口與操作工具不納入產品程式。
- Admin 的測試 URL、Basic Auth 保護與 runtime config 來源，以及中央 Gateway 登記的精確 origin。確認 context、角色清單與 App 登入資料指向同一活動。
- Android 測試包的 application ID 與相符的 Firebase client 設定；需要與正式 App 並存時，先備妥獨立的測試 application ID 與設定。Android 裝置須具備所需 Google Play Services；iOS 準備 Xcode、簽章、APNs 設定及實體裝置。
- 中央 Cloudflare／Firebase 權限、D1 database、Gateway 端點與測試活動 key 的取得方式，以及真實派送的授權範圍。空白範例設定與 dry-run 不代表這些資源已就緒。

先完成各 repo 的自動測試、可操作的 Admin 與可安裝的 App，再以獲授權的活動驗證送出、收到通知與點擊導頁；最後驗證遵守統計選擇的原生成效與 CSV 交付。每階段各自保存結果，建置成功不等於 end-to-end 驗收通過。

| 責任範圍               | 驗收條件                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中央維運               | Firebase service account 僅有發送權限；D1 僅中央 Worker 與授權維運者可存取，migrations 已套用；正式 origin、key 撤銷／輪替、活動截止與 rate limit 符合契約                                                       |
| 服務條件與執行用量     | 未綁有效付款方式可啟用及使用所需服務；冷啟動憑證處理、最大合法內容、八角色雙語與有限重試符合 Worker 限制；D1 讀寫含索引及匯出用量，容量足以保存待交付內容                                                        |
| CCIP-Admin-Bueno       | runtime config 受 Basic Auth 保護且不快取；以相同 key 核對 context；活動不符或停發時禁止發送；展開具體角色並確認雙語內容；部分或未知結果不重送                                                                   |
| CCIP-Android／CCIP-iOS | 驗證每活動身分後才訂閱；切換活動保留其他訂閱；角色、語系、registration 與啟動觸發同步；過期驗證回應不覆蓋新身分；離線、還原備份及中斷後的訂閱恢復符合 ADR 0001                                                   |
| App 產品與維護者       | 決定統計蒐集的預設、詢問時機、撤回方式及與既有 Analytics 開關的關係；拒絕或撤回統計不影響通知使用                                                                                                                |
| 通知顯示與導頁         | 使用系統 notification、預設提示音及指定優先度；無 badge；點擊能定位非顯示中活動或 HTTPS URI；iOS extension 完成通知顯示及允許的送達匯出                                                                          |
| 原生統計與交付         | 在未綁有效付款方式的目標專案，以同意蒐集的 Android／iOS 裝置驗證原生匯入、可用送達／開啟紀錄及 `push_id` 對照；執行 BigQuery 查詢與 CSV 匯出，核對涵蓋、延遲、到期與額度；不含其他活動或逐裝置資料，無資料不補零 |
| 平台與活動方           | 確認活動資料、統計截止、交付時間與對象、資料存取權限及清理日期；內容保留到 CSV 交付完成                                                                                                                          |
| 中央維運與活動方       | 確認主要與備援窗口、服務條件不符時的處理，以及故障、key 外洩與撤銷的處理時間；驗證 D1 備份／還原與活動資料清理，不影響未交付內容                                                                                 |

Gateway repository 的通過結果只涵蓋表列自動檢查。發布整合功能前，中央維運者須取得相關 repository 版本與目標環境的驗收證據；沒有執行證據的項目標為「未驗證」。

## 版本證據

功能變更的 commit 應包含實作、保護該行為的測試及必要文件。驗證結果記在對應 commit body、PR 或發布紀錄，至少包含版本、實際命令、結果與未執行項目；CI 結果附 run 連結，環境驗收另附日期、環境及各元件版本。

架構決策採用、程式碼完成、自動檢查通過與環境部署是不同狀態。ADR 記錄決策生命週期，發布紀錄記錄環境結果；不以其中一項推定其餘項目完成。
