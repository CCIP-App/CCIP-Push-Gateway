-- Replace both scope values with the centrally registered event and UTC cutoff.
-- Keep the event filter, time filter and window count in this same query.
SELECT event_id, push_id, created_at, content_json,
       COUNT(*) OVER () AS source_count
FROM push_records
WHERE event_id = 'EXAMPLE_2027'
  AND created_at <= '2027-03-14T00:00:00.000Z'
ORDER BY created_at, push_id;
