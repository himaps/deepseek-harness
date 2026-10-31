/**
 * Build the Windows x64 offline installer `deepseek-harness-windows-x64-setup.exe` from
 * one officially built dsh tree: a self-contained dsh CLI runtime (bundled Node.js, pnpm,
 * Python) that a machine without network access can run. The NSIS installer copies the
 * payload into `$PROGRAMFILES64\deepseek-harness`, appends it to the machine PATH, and
 * registers an uninstaller; it touches no system component beyond its own directory and
 * that PATH entry. Requires NSIS (`makensis`) on PATH — GitHub's Windows runners ship it.
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFamily } from '../../../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../../../scripts/release/pack.ts'
import { attempt, capture } from '../../../../../scripts/release/process.ts'
import { packedIdentity } from '../../../../../scripts/release/tarball.ts'

const PACKAGING_DIR = resolve(import.meta.dirname)
const REPOSITORY_ROOT = resolve(PACKAGING_DIR, '..', '..', '..', '..')
const CLI_ROOT = resolve(REPOSITORY_ROOT, 'apps', 'cli')
const PRIMARY_RUNTIME_LOCK = resolve(REPOSITORY_ROOT, 'scripts', 'primary-runtime', 'lock.json')

/** Package identity stamped into the installer name; it extracts one `deepseek-harness` folder. */
const PACKAGE_NAME = 'deepseek-harness'
const PACKAGE_TARGET = 'windows-x64'
const STAGE_FOLDER = PACKAGE_NAME

/** Layout inside the staged folder; the launcher and installer hard-code it. */
const RUNTIME_DIR = 'runtime'
const DSH_DIR = 'dsh'
const NODE_EXE = `${RUNTIME_DIR}/primary-runtime/dependencies/node/bin/node.exe`
const CLI_ENTRY = `${DSH_DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js`

/**
 * The native system package (Landlock launcher, flock addons) is Linux/macOS-only. On
 * Windows the workspace platform packages cannot even be packed — their prepack validates
 * Linux binaries — so the closure leaves the entry package to its published npm version,
 * whose Windows consumers load no platform binary at all.
 */
const WINDOWS_EXTERNAL_PREFIX = '@deepseek-ai/node-addon-system'

/** Sections whose workspace packages must ship inside the offline package. */
const CLOSURE_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/** A packed npm tarball and the identity it declares. */
interface PackedPackage {
  readonly name: string
  readonly version: string
  readonly file: string
  readonly path: string
}

/**
 * Validate one command-line directory, create it when missing, and return its resolved
 * absolute path. Every directory argument is build-owned staging or output.
 * @param value - Raw command-line value.
 * @param label - Option name for error messages.
 * @returns The resolved directory path.
 */
function directoryOption(value: string, label: string): string {
  const resolved = resolve(value)
  const existing = statSync(resolved, { throwIfNoEntry: false })
  if (existing !== undefined && !existing.isDirectory()) {
    throw new Error(`windows installer: ${label} must name a directory, got ${JSON.stringify(value)}`)
  }
  mkdirSync(resolved, { recursive: true })
  return resolved
}

/**
 * Read a required string field from a package manifest.
 * @param manifest - Parsed package.json object.
 * @param field - Field to read.
 * @param subject - File path for error messages.
 * @returns The field value.
 */
function manifestString(manifest: Readonly<Record<string, unknown>>, field: string, subject: string): string {
  const value = manifest[field]
  if (typeof value !== 'string' || value === '') throw new Error(`windows installer: ${subject} has no ${field}`)
  return value
}

/**
 * Decide whether one package manifest admits the target platform, following npm's
 * `os`/`cpu` rules (`!value` denies, absent or empty admits).
 * @param manifest - Parsed package.json object.
 * @param field - Either `os` or `cpu`.
 * @param value - Target value such as `win32` or `x64`.
 * @returns True when the package installs on the target.
 */
function acceptsTarget(manifest: Readonly<Record<string, unknown>>, field: 'os' | 'cpu', value: string): boolean {
  const values = manifest[field]
  if (values === undefined) return true
  if (!Array.isArray(values) || !values.every(entry => typeof entry === 'string')) {
    throw new Error(`windows installer: package manifest has invalid ${field}: ${JSON.stringify(values)}`)
  }
  if (values.includes(`!${value}`)) return false
  return values.length === 0 || values.includes(value) || values.every(entry => entry.startsWith('!'))
}

/**
 * Map workspace package names to their repository directories from the root workspace list.
 * @returns The name-to-directory map.
 */
function workspacePackages(): Map<string, string> {
  const rootManifest = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as { workspaces?: unknown }
  if (!Array.isArray(rootManifest.workspaces) || !rootManifest.workspaces.every(entry => typeof entry === 'string')) {
    throw new Error('windows installer: root package.json has no workspaces list')
  }
  const patterns = (rootManifest.workspaces as string[]).map(pattern => `${pattern}/package.json`)
  const found = new Map<string, string>()
  for (const relativePath of globSync(patterns, { cwd: REPOSITORY_ROOT })) {
    const directory = resolve(REPOSITORY_ROOT, relativePath, '..')
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
    if (typeof parsed.name !== 'string' || parsed.name === '') continue
    found.set(parsed.name, directory)
  }
  return found
}

/**
 * Walk the CLI's dependency closure over workspace packages for Windows x64, honoring npm
 * os/cpu filters so platform packages for other machines stay out of the package set.
 * @param cliManifest - The CLI package.json object.
 * @param workspace - Workspace name-to-directory map.
 * @returns Closure package names sorted.
 */
function selectClosure(cliManifest: Readonly<Record<string, unknown>>, workspace: Map<string, string>): string[] {
  const selected = new Set<string>()
  const pending = [manifestString(cliManifest, 'name', join(CLI_ROOT, 'package.json'))]
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined || selected.has(name)) continue
    if (name.startsWith(WINDOWS_EXTERNAL_PREFIX)) continue
    const directory = workspace.get(name)
    if (directory === undefined) continue
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
    if (!acceptsTarget(manifest, 'os', 'win32') || !acceptsTarget(manifest, 'cpu', 'x64')) continue
    selected.add(name)
    for (const section of CLOSURE_SECTIONS) {
      const dependencies = manifest[section]
      if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
      pending.push(...Object.keys(dependencies))
    }
  }
  return [...selected].sort()
}

/**
 * Index one directory of staged tarballs by the package name each declares.
 * @param directory - Staging directory.
 * @param files - Tarball file names staged by the caller.
 * @returns The staged tarballs indexed by declared package name.
 */
function indexPacked(directory: string, files: readonly string[]): Map<string, PackedPackage> {
  const packed = new Map<string, PackedPackage>()
  for (const file of files) {
    const path = join(directory, file)
    const identity = packedIdentity(path)
    if (packed.has(identity.name)) throw new Error(`windows installer: duplicate staged tarball for ${identity.name}`)
    packed.set(identity.name, { name: identity.name, version: identity.version, file, path })
  }
  return packed
}

/**
 * Pack every member of one release family into its staging directory.
 * @param familyId - `dsh` or `vendor`.
 * @param destination - Staging directory; packFamilyMembers replaces it.
 * @param concurrency - Parallel pack limit.
 * @returns The staged tarballs indexed by declared package name.
 */
async function packFamily(familyId: string, destination: string, concurrency: number): Promise<Map<string, PackedPackage>> {
  const staged = await packFamilyMembers(REPOSITORY_ROOT, releaseFamily(familyId), destination, concurrency)
  console.log(`windows installer: packed family ${familyId}: ${String(staged.length)} tarball(s)`)
  return indexPacked(destination, staged)
}

/**
 * Pack closure members the release families do not cover, running each package's prepack
 * validation.
 * @param names - Closure member names to pack.
 * @param workspace - Workspace name-to-directory map.
 * @param destination - Staging directory for ad-hoc packs.
 * @returns The newly staged tarballs indexed by declared package name.
 */
function packRemaining(names: readonly string[], workspace: Map<string, string>, destination: string): Map<string, PackedPackage> {
  mkdirSync(destination, { recursive: true })
  const staged: string[] = []
  for (const name of names) {
    const directory = workspace.get(name)
    if (directory === undefined) throw new Error(`windows installer: closure member ${name} is not a workspace package`)
    const before = new Set(readdirSync(destination))
    capture('pnpm', ['--dir', directory, 'pack', '--pack-destination', destination])
    const file = readdirSync(destination).find(candidate => !before.has(candidate))
    if (file === undefined) throw new Error(`windows installer: packing ${name} produced no tarball in ${destination}`)
    staged.push(file)
    console.log(`windows installer: packed ${name}`)
  }
  return indexPacked(destination, staged)
}

/**
 * Run one pnpm install pass against the runtime project. The host environment passes
 * through except for npm/pnpm configuration variables, so this build's isolated store and
 * empty user config always win and no host registry or cache setting leaks in; Node on
 * Windows needs the system environment (SystemRoot and friends) for its crypto stack.
 * @param project - Runtime project directory; also the command working directory.
 * @param state - Directory owning the pnpm store, cache, and config for this build.
 * @param args - pnpm arguments after the `install` command.
 */
function runPnpm(project: string, state: string, args: readonly string[]): void {
  const config = join(state, 'config')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'npmrc'), '')
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^(?:npm|pnpm|corepack)_/iu.test(name)
  )))
  environment.NPM_CONFIG_REGISTRY = process.env.DSH_NPM_REGISTRY ?? 'https://registry.npmjs.org'
  environment.NPM_CONFIG_STORE_DIR = join(state, 'store')
  environment.NPM_CONFIG_USERCONFIG = join(config, 'npmrc')
  environment.npm_config_verify_store_integrity = 'true'
  environment.npm_config_package_import_method = 'copy'
  environment.npm_config_enable_global_virtual_store = 'false'
  capture('pnpm', ['install', ...args], { cwd: project, env: environment })
}

/**
 * Create the runtime project that installs the CLI from the packed tarballs, then run the
 * two-pass install (lockfile, then production install) exactly like the Desktop runtime.
 * @param project - Directory to create.
 * @param packed - Every staged tarball by name.
 * @param version - The dsh release version the CLI was built at.
 * @param state - pnpm state directory for this build.
 */
function installRuntime(project: string, packed: Map<string, PackedPackage>, version: string, state: string): void {
  const dsh = packed.get('@deepseek-ai/dsh')
  if (dsh === undefined) throw new Error('windows installer: the packed set omits @deepseek-ai/dsh')
  if (dsh.version !== version) {
    throw new Error(`windows installer: packed @deepseek-ai/dsh ${dsh.version} does not match the CLI version ${version}`)
  }
  rmSync(project, { recursive: true, force: true })
  mkdirSync(join(project, 'tarballs'), { recursive: true })
  for (const entry of packed.values()) cpSync(entry.path, join(project, 'tarballs', entry.file))
  const overrides = Object.fromEntries([...packed.values()]
    .map(entry => [entry.name, 'file:./tarballs/' + entry.file])
    .sort(([left], [right]) => left.localeCompare(right)))
  const manifest = {
    name: 'deepseek-harness-runtime',
    private: true,
    version,
    type: 'module',
    dependencies: { '@deepseek-ai/dsh': version },
    pnpm: { overrides },
  }
  writeFileSync(join(project, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  runPnpm(project, state, ['--lockfile-only'])
  const lockfile = readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8')
  console.log(`windows installer: runtime lockfile sha256 ${createHash('sha256').update(lockfile).digest('hex')}`)
  runPnpm(project, state, ['--prod', '--frozen-lockfile', '--trust-lockfile'])
  if (!existsSync(join(project, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error('windows installer: runtime install produced no CLI entry under node_modules')
  }
}

/**
 * Assemble the staged folder the installer packages. The runtime project's node_modules is
 * copied with dereference so pnpm's junctions become real directories, which the NSIS
 * file graph preserves safely.
 * @param stageRoot - Directory receiving the ${STAGE_FOLDER} folder.
 * @param sources - Prepared directories.
 */
function assembleStage(stageRoot: string, sources: {
  readonly runtime: string
  readonly officeSkills: string
  readonly runtimeProject: string
}): void {
  const folder = join(stageRoot, STAGE_FOLDER)
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(folder, { recursive: true })
  cpSync(join(sources.runtime, 'primary-runtime'), join(folder, RUNTIME_DIR, 'primary-runtime'), { recursive: true })
  cpSync(sources.officeSkills, join(folder, 'office-skills'), { recursive: true })
  cpSync(join(sources.runtimeProject, 'node_modules'), join(folder, DSH_DIR, 'node_modules'), { recursive: true, dereference: true })
  for (const file of ['package.json', 'pnpm-lock.yaml']) {
    cpSync(join(sources.runtimeProject, file), join(folder, DSH_DIR, file))
  }
  cpSync(join(REPOSITORY_ROOT, 'LICENSE'), join(folder, 'LICENSE'))
  for (const template of ['dsh.cmd', 'README.txt']) {
    const source = join(PACKAGING_DIR, template)
    if (!existsSync(source)) throw new Error(`windows installer: missing template ${template}`)
    cpSync(source, join(folder, template))
  }
  for (const required of [NODE_EXE, CLI_ENTRY]) {
    if (!existsSync(join(folder, required))) throw new Error(`windows installer: payload is missing ${required}`)
  }
}

/**
 * Measure one directory tree recursively.
 * @param root - Directory to measure.
 * @returns Total size in bytes.
 */
function treeBytes(root: string): number {
  let bytes = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (entry.isFile()) bytes += statSync(path).size
    }
  }
  visit(root)
  return bytes
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      work: { type: 'string' },
      cache: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
    },
    allowPositionals: false,
  })
  if (values.output === undefined || values.work === undefined || values.cache === undefined) {
    throw new Error('usage: build-installer.ts --output <dir> --work <dir> --cache <dir> [--concurrency 4]')
  }
  const outputDir = directoryOption(values.output, '--output')
  const workDir = directoryOption(values.work, '--work')
  const cacheDir = directoryOption(values.cache, '--cache')
  const concurrency = parsePackConcurrency(values.concurrency)
  const cliManifest = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
  const version = manifestString(cliManifest, 'version', join(CLI_ROOT, 'package.json'))
  const setupPath = join(outputDir, PACKAGE_NAME + '-' + PACKAGE_TARGET + '-setup.exe')

  releaseFamily('dsh').verifyBuildArtifacts(REPOSITORY_ROOT)
  console.log('windows installer: official build artifacts verified for ' + version)

  const probe = attempt('makensis', ['/VERSION'])
  if (probe.status !== 0) {
    throw new Error('windows installer: makensis is not on PATH; install NSIS 3 (GitHub Windows runners ship it) '
      + 'and add its install directory to PATH')
  }

  const tarballs = join(workDir, 'tarballs')
  const workspace = workspacePackages()
  const closure = selectClosure(cliManifest, workspace)
  console.log('windows installer: CLI closure selects ' + String(closure.length) + ' workspace package(s)')

  const packed = new Map<string, PackedPackage>()
  for (const [name, entry] of await packFamily('dsh', join(tarballs, 'dsh'), concurrency)) packed.set(name, entry)
  for (const [name, entry] of await packFamily('vendor', join(tarballs, 'vendor'), 1)) packed.set(name, entry)
  const uncovered = closure.filter(name => !packed.has(name))
  for (const [name, entry] of packRemaining(uncovered, workspace, join(tarballs, 'local'))) packed.set(name, entry)

  const runtimeLock = JSON.parse(readFileSync(PRIMARY_RUNTIME_LOCK, 'utf8')) as { targets?: Record<string, unknown> }
  if (runtimeLock.targets === undefined || runtimeLock.targets['win-x64'] === undefined) {
    throw new Error('windows installer: primary runtime lock has no win-x64 target')
  }
  const runtimeDir = join(workDir, 'runtime')
  capture('pnpm', ['exec', 'tsx', 'scripts/primary-runtime/prepare.ts',
    '--target', 'win-x64', '--output', runtimeDir, '--cache', cacheDir], { cwd: REPOSITORY_ROOT })

  const project = join(workDir, 'runtime-project')
  installRuntime(project, packed, version, join(workDir, 'pnpm-state'))

  const stageRoot = join(workDir, 'staging')
  assembleStage(stageRoot, {
    runtime: runtimeDir,
    officeSkills: join(runtimeDir, 'office-skills'),
    runtimeProject: project,
  })
  // The staged folder owns every byte; free the staging copies before the installer build.
  rmSync(join(workDir, 'pnpm-state', 'store'), { recursive: true, force: true })
  rmSync(tarballs, { recursive: true, force: true })
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })

  const stagedBytes = treeBytes(stageRoot)
  console.log('windows installer: staged folder ' + (stagedBytes / (1024 * 1024)).toFixed(1) + ' MiB')
  capture('makensis', ['/DSTAGE=' + stageRoot, '/DOUT=' + setupPath, '/DVERSION=' + version,
    join(PACKAGING_DIR, 'installer.nsi')])
  if (!existsSync(setupPath)) throw new Error('windows installer: makensis produced no installer at ' + setupPath)
  console.log('windows installer: built ' + setupPath + ' (' + (statSync(setupPath).size / (1024 * 1024)).toFixed(1) + ' MiB)')
}
