-- Per-host access path: lets a 429 back off a host without scanning the
-- whole table, spread that host's URLs over time, and lets the scheduler
-- skip a host whose backlog would otherwise fill the candidate window.
-- Costs one extra index write per next_check_at change.
CREATE INDEX urls_host_next ON urls(host, next_check_at);
