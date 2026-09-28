// The session hosts crew runs on, by the name `crew run --host` takes; a
// `crew run` that names none is on DEFAULT_HOST, crew (ADR-0017). A runner
// started directly that names none, as a resume from the Orca run view types
// it, is on LEGACY_HOST, the only host a run could be on before hosts had
// names, as is a registry row or a run that names none. A worker's own
// commands (submit, `crew orchestration send`) are on the host its session's
// CREW_HOST names, which the crew host sets, else LEGACY_HOST: an Orca worker
// has no CREW_HOST.
import { sessionHost } from './session-host.mjs'

const HOSTS = {
  orca: async (options) => (await import('./orca-cli.mjs')).orcaCli(options),
  crew: async (options) => (await import('./crew-host.mjs')).crewHost(options),
}

export const HOST_NAMES = Object.freeze(Object.keys(HOSTS))
export const DEFAULT_HOST = 'crew'
export const LEGACY_HOST = 'orca'

// The host a worker's own command runs against.
export const workerHost = (env = process.env) => env.CREW_HOST || LEGACY_HOST

export async function openHost(name = LEGACY_HOST, options = {}) {
  const make = Object.hasOwn(HOSTS, name) ? HOSTS[name] : null
  if (!make) throw new Error(`unknown host ${name}: expected one of ${HOST_NAMES.join(', ')}`)
  return sessionHost(await make(options))
}

// Every host by its name, each opened with the `options` it knows: for a
// reader of runs on any host, as the run views are, which asks each run's.
export async function openHosts(options = {}) {
  return Object.fromEntries(await Promise.all(HOST_NAMES.map(async (name) => [name, await openHost(name, options)])))
}
