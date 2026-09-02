# OPass Push Gateway

OPass 的中央 FCM topic 推播閘道，供受活動方 reverse proxy Basic Auth 保護的 CCIP-Admin-Bueno 發送所屬活動的公開推播，且不接觸 OPass 的 Firebase service account。

目前這個 repository 先確立跨專案契約，尚未包含 Cloudflare Worker 實作：

- [ADR 0001：FCM topic Push Gateway](docs/adr/0001-fcm-topic-push-gateway.md)
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

## Repository 職責

這裡是 Gateway 行為、topic 命名與 Admin-to-Gateway API 的唯一規格來源。Android、iOS 與 CCIP-Admin-Bueno 依此契約實作，不另行複製規格。

## License

[GNU Affero General Public License v3.0](LICENSE)
