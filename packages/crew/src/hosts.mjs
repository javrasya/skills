// The session hosts crew runs on, by the name `crew run --host` takes; a
// `crew run` that names none is on crew. A runner started directly that names
// none, as a resume from the Orca run view types it, is on DEFAULT_HOST, the
// only host a run could be on before hosts had names. A worker's own commands (submit, `crew
// orchestration send`) are on the host its session's CREW_HOST names, which
// the crew host sets, else DEFAULT_HOST: an Orca worker has no CREW_HOST.
import { sessionHost } from './session-host.mjs'

const HOSTS = {
  orca: async (options) => (await import('./orca-cli.mjs')).orcaCli(options),
  crew: async (options) => (await import('./crew-host.mjs')).crewHost(options),
}

export const HOST_NAMES = Object.freeze(Object.keys(HOSTS))
export const DEFAULT_HOST = 'orca'

// The host a worker's own command runs against.
export const workerHost = (env = process.env) => env.CREW_HOST || DEFAULT_HOST

export async function openHost(name = DEFAULT_HOST, options = {}) {
  const make = Object.hasOwn(HOSTS, name) ? HOSTS[name] : null
  if (!make) throw new Error(`unknown host ${name}: expected one of ${HOST_NAMES.join(', ')}`)
  return sessionHost(await make(options))
}
