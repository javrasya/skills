// A program by its name, found as a Windows shell would find it.
import { existsSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'

// A bare name on Windows is looked up on Path with each PATHEXT extension
// (conpty finds one only with its extension given: "node.exe", never "node");
// a relative path resolves against cwd; anything else, and every name off
// Windows, is left as it is.
export function resolveCommand(file, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32' || isAbsolute(file) || extname(file)) return file
  if (/[\\/]/.test(file)) return resolve(cwd, file)
  const path = env.Path ?? env.PATH ?? ''
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, file + ext.toLowerCase())
      if (existsSync(candidate)) return candidate
    }
  }
  return file
}

// The [program, args] a child_process spawn runs `file args` as. Node spawns
// no .cmd or .bat (an npm shim, a setup hook) without a shell, so on Windows
// one is run through ComSpec.
export function childCommand(file, args, { cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const program = resolveCommand(file, { cwd, env, platform })
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(program)) return [env.ComSpec || 'cmd.exe', ['/d', '/c', program, ...args]]
  return [program, args]
}
