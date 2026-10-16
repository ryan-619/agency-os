-- Revert 0020_assistant_playbook_and_brief.
-- DATA LOSS, stated: every org's playbook and its morning-brief settings are
-- DELETED with the table. The briefs already written stay — they are
-- ordinary chat threads — and code before 0020 neither reads a playbook nor
-- starts a brief.
DROP TABLE assistant_settings;
