-- GoogleSQL. Replace YOUR_PROJECT_ID; parameters and handoff steps: docs/operations.md.
-- @pushes_json comes from the event-scoped content exporter, never a global label list.
-- @cutoff_at is the observation cutoff; ingestion can continue after that time.
WITH pushes AS (
  SELECT
    JSON_VALUE(item, '$.push_id') AS push_id,
    TIMESTAMP(JSON_VALUE(item, '$.created_at')) AS created_at
  FROM UNNEST(JSON_QUERY_ARRAY(@pushes_json)) AS item
  WHERE JSON_VALUE(item, '$.event_id') = @event_id
    AND TIMESTAMP(JSON_VALUE(item, '$.created_at')) <= @cutoff_at
), deliveries AS (
  SELECT
    analytics_label AS push_id,
    UPPER(sdk_platform) AS platform,
    COUNT(DISTINCT TO_JSON_STRING(STRUCT(app_name, message_id, instance_id))) AS delivery_count
  FROM `YOUR_PROJECT_ID.firebase_messaging.data`
  WHERE analytics_label IN (SELECT push_id FROM pushes)
    AND event = 'MESSAGE_DELIVERED'
    AND event_timestamp >= (SELECT MIN(created_at) FROM pushes)
    AND event_timestamp <= @cutoff_at
    -- Partition time is ingestion time, not send time. Retain late imports.
    AND (_PARTITIONTIME >= TIMESTAMP_TRUNC((SELECT MIN(created_at) FROM pushes), DAY)
      OR _PARTITIONTIME IS NULL)
    AND COALESCE(message_id, '') != ''
    AND COALESCE(instance_id, '') != ''
  GROUP BY 1, 2
)
SELECT
  @event_id AS event_id,
  pushes.push_id,
  pushes.created_at,
  platform,
  deliveries.delivery_count,
  IF(deliveries.delivery_count IS NULL, 'NO_OBSERVED_DELIVERY_DATA', NULL) AS delivery_unavailable_reason,
  CAST(NULL AS INT64) AS open_count,
  'EXPORT_FIREBASE_OPENS_SEPARATELY' AS open_unavailable_reason,
  'FCM BigQuery MESSAGE_DELIVERED' AS source,
  'message_app_installation_pairs' AS unit,
  'Only exported SDK deliveries with message and installation IDs; not unique people or complete coverage' AS coverage,
  @cutoff_at AS cutoff_at,
  CURRENT_TIMESTAMP() AS exported_at
FROM pushes
CROSS JOIN UNNEST(['ANDROID', 'IOS']) AS platform
LEFT JOIN deliveries USING (push_id, platform)
ORDER BY pushes.created_at, pushes.push_id, platform;
