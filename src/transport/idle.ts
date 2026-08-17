/**
 * Bound how long a provider may stay silent while a read is outstanding.
 *
 * A hung `claude` process otherwise parks the harness turn forever: the socket
 * stays open, no chunk arrives, and nothing times out. The budget is per read,
 * not per call, so a long but productive generation is never cut short.
 *
 * @module dsh-claude-cli/transport/idle
 */

/**
 * Re-yield a stream, failing if any single read takes longer than the budget.
 * @param source - the upstream async iterable.
 * @param idleTimeoutMs - maximum silence between reads.
 * @param onTimeout - builds the error to throw; called only on expiry.
 * @returns the same values, with an idle guard around each read.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleTimeoutMs: number,
  onTimeout: () => Error,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), idleTimeoutMs)
        // A pending idle timer must not be the reason the process stays alive.
        timer.unref?.()
      })
      let result: IteratorResult<T>
      try {
        result = await Promise.race([iterator.next(), expiry])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (result.done === true) return
      yield result.value
    }
  } finally {
    // Covers both the timeout throw and an early `break` in the consumer:
    // without this the upstream generator never runs its own cleanup.
    await iterator.return?.()
  }
}
