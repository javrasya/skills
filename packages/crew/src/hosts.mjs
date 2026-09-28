// The session hosts crew runs on, by the name `crew run --host` takes. A
// launch that names none — the runner started directly, as a resume from the
// run view types it, or submit in a worker's pane — is on DEFAULT_HOST, the
// only host a run could be on before hosts had names.
import { sessionHost } from './session-host.mjs'

const HOSTS = {
  orca: async (options) => (await import('./orca-cli.mjs')).orcaCli(options),
}

export const HOST_NAMES = Object.freeze(Object.keys(HOSTS))
export const DEFAULT_HOST = 'orca'

export async function openHost(name = DEFAULT_HOST, options = {}) {
  const make = Object.hasOwn(HOSTS, name) ? HOSTS[name] : null
  if (!make) throw new Error(`unknown host ${name}: expected one of ${HOST_NAMES.join(', ')}`)
  return sessionHost(await make(options))
}
