import { can, type Principal } from '@agency/core'

/**
 * Who may read and change the services catalogue (0022). Reading it is any
 * member's — they pitch from it. Changing it is an owner's: it sets the prices
 * the assistant quotes, as the playbook sets its voice.
 */
export const mayReadServices = (p: Principal): boolean => can(p, 'companies:read')
export const mayWriteServices = (p: Principal): boolean => can(p, 'agents:write')

/** A request body is small: a name, a description, a few needs and a price. */
export const SERVICE_MAX_REQUEST_BYTES = 8_000
