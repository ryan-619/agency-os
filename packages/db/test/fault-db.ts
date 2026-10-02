/**
 * Two ways to make the database fail at one statement, for tests about what
 * a fault leaves behind.
 *
 * `throughTransactions` is a Proxy over a drizzle database that applies the
 * same handler to every transaction and savepoint opened from it. A plain
 * `new Proxy(db, …)` stops at `db.transaction(…)`: drizzle hands the callback
 * a transaction object it built itself, so a fault aimed at a statement
 * inside one never fires, and the test passes for the wrong reason.
 *
 * `failOnce` installs a trigger that RAISES the first time it fires and never
 * again. A JavaScript throw is not what a database fault does to a
 * transaction: a real one ABORTS it, and every later statement in it fails
 * until a ROLLBACK (TO SAVEPOINT). Worse, a COMMIT sent to an aborted
 * transaction is answered ROLLBACK with no error, and drizzle resolves it —
 * measured on PGlite — so a swallowed failure with no savepoint around it
 * silently discards everything the transaction wrote. Only a fault the
 * engine raises tests that. The trigger counts with a sequence, which a
 * rollback does not reset, so the retry after it runs clean.
 */
import type { PGlite } from '@electric-sql/pglite'
import type { AgencyDb } from '../src/index.js'

type TransactionFn = (cb: (tx: unknown) => Promise<unknown>, config?: unknown) => Promise<unknown>

export function throughTransactions(db: AgencyDb, handler: ProxyHandler<object>): AgencyDb {
  const wrap = (target: object): AgencyDb =>
    new Proxy(target, {
      ...handler,
      get(t, prop, receiver) {
        if (prop === 'transaction') {
          const real = Reflect.get(t, prop, t) as TransactionFn
          return (cb: (tx: unknown) => Promise<unknown>, config?: unknown) =>
            real.call(t, (tx: unknown) => cb(wrap(tx as object)), config)
        }
        return handler.get ? handler.get(t, prop, receiver) : Reflect.get(t, prop, receiver)
      },
    }) as AgencyDb
  return wrap(db as object)
}

let installed = 0

/**
 * The first `event` on `table` (matching `when`, a trigger WHEN condition
 * over NEW/OLD) raises; every later one passes. Returns the message it
 * raises, for a test that wants to see it did.
 */
export async function failOnce(
  pg: PGlite,
  on: { readonly table: string; readonly event: 'INSERT' | 'UPDATE'; readonly when?: string },
): Promise<string> {
  const id = `injected_fault_${++installed}`
  const message = `injected fault on ${on.event} ${on.table}`
  await pg.exec(`
    CREATE SEQUENCE ${id}_seq;
    CREATE FUNCTION ${id}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('${id}_seq') = 1 THEN
        RAISE EXCEPTION '${message}';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ${id} BEFORE ${on.event} ON ${on.table}
      FOR EACH ROW ${on.when ? `WHEN (${on.when})` : ''} EXECUTE FUNCTION ${id}();
  `)
  return message
}
