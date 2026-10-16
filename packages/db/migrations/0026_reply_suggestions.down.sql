-- Reverting 0026 deletes every suggested answer; the replies, the answers a
-- person drafted from them and their audit rows stay.
DROP TABLE reply_suggestions;
