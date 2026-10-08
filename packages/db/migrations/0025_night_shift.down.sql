-- Reverting 0025 deletes the night shift's settings and its saved searches;
-- the businesses it filed, the scans and audits it wrote and its audit rows stay.
DROP TABLE night_searches;
DROP TABLE night_shifts;
