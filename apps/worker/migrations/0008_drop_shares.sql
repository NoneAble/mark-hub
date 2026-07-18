-- Share feature removed: drop its tables. IF EXISTS keeps this safe for
-- databases created after share_links/rate_limits stopped shipping.
DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS rate_limits;
