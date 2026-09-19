# OPass Push Gateway

OPass 的中央 FCM topic 推播閘道，供受活動方 reverse proxy Basic Auth 保護的 CCIP-Admin-Bueno 發送所屬活動的公開推播，且不接觸 OPass 的 Firebase service account。

Gateway v1 的跨專案契約如下。架構採用中央 D1 保存公開推播內容與已知派送結果；部署以不綁定有效付款方式為前提：

- [ADR 0001：FCM topic Push Gateway](docs/adr/0001-fcm-topic-push-gateway.md)
- [ADR 0002：D1 內容保存](docs/adr/0002-content-export-storage.md)
- [OpenAPI 契約](openapi.yaml)

## 信任邊界

```text
CCIP-Admin-Bueno -> OPass Push Gateway -> FCM topic
        |                    ^
        +-- EVENT_ID 綁定的 Gateway key
```

- CCIP-Admin-Bueno 由活動方 reverse proxy Basic Auth 保護；能進入 Admin 的活動主辦方人員都可讀取並使用該活動的 Gateway key。
- Admin 透過 CCIP-Server 既有的 `GET roles` 取得具體角色，將「全體」展開後直接呼叫 Gateway。
- CCIP-Server 只維持既有的活動角色資料來源，不取得 Gateway key、不新增推播 endpoint，也不參與推播發送路徑。
- Gateway 由驗證成功的 key 決定 `EVENT_ID`；request 不接受 `event_id` 或完整 topic。
- Gateway key 只放在受保護且不快取的 Admin runtime config，不提交到公開 repository。
- Firebase service account 只存在於中央 Gateway 的 Cloudflare secret。
- 所有推播內容都是公開資訊；topic 不是機密資料的授權邊界。
- Android 與 iOS 對每個已登入活動各維持一個 topic；切換目前活動不會取消其他活動的訂閱。

## 推播範圍

- 推播有效一小時；活動結束後三十天由 Gateway 停止新派送，輪替 key 不延長期限。
- 通知標題使用中央登記的活動主辦名稱；Admin 發送前先核對 key 對應的活動與可發布狀態。
- 接受漏收，不補送部分或未知結果；FCM 已接受、裝置送達與通知點擊是不同狀態。
- 跨裝置帶入的登入資料須驗證成功後才新增訂閱；訂閱套用狀態不跨裝置同步或從備份沿用。
- 成效只交付平台可取得的送達數、通知點擊數及 CSV；沿用 Firebase／Analytics／BigQuery，主辦方自行保存，不建立報表後台或追蹤後續轉化。
- iOS 移除 OneSignal，保留送達統計所需的最小 FCM Notification Service Extension；UnifiedPush 不納入本版。

## Repository 職責

這裡是 Gateway 行為、topic 命名與 Admin-to-Gateway API 的唯一規格來源。Android、iOS 與 CCIP-Admin-Bueno 依此契約實作，不另行複製規格。

## License

[GNU Affero General Public License v3.0](LICENSE)
