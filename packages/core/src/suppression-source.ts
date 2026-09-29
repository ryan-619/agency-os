/**
 * Which path recorded a suppression (§2.1, 0018).
 *
 * An auditor's question — "how did this person come to be on the list?" — is
 * answered by a column, not by a prefix on the free-text reason. Five values,
 * each with exactly one writer: the suppressions page (`manual`), a reply
 * that said stop (`reply`), a spoken opt-out on a call (`voice`), the
 * one-click unsubscribe link (`unsubscribe`), and an erasure request that
 * keeps the opt-out while removing everything else (`erasure`). A value
 * nothing writes is not listed, and `suppressions_source_is_known` refuses
 * anything outside the five.
 *
 * Rows written before the column existed carry NULL. Inventing `manual` for
 * them would be a claim about who did what, which is the one thing this
 * column exists not to make.
 */
export const SUPPRESSION_SOURCES = ['manual', 'reply', 'voice', 'unsubscribe', 'erasure'] as const

export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number]
