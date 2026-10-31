/**
 * Build the Kylin V10 SP1 offline `.deb` (glibc 2.31 baseline) for `linux-arm64` from one
 * officially built dsh tree. The payload is self-contained: the locked primary runtime
 * (Node.js, pnpm, Python) plus the dsh CLI installed from packed workspace tarballs, so the
 * package carries no interpreter from the target machine. See README.md in this directory
 * for the offline-package rules this script enforces (no system-component upgrades, glibc
 * symbol gate, payload self-check).
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
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
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFamily } from '../../../../../scripts/release/families.ts'
import { packFamilyMembers, parsePackConcurrency } from '../../../../../scripts/release/pack.ts'
import { capture } from '../../../../../scripts/release/process.ts'
import { packedIdentity } from '../../../../../scripts/release/tarball.ts'
// The imports above are five levels deep from apps/cli/packaging/linux/kylin-v10-sp1.

const PACKAGING_DIR = resolve(import.meta.dirname)
// Walk upward instead of counting levels: the depth from this file to the repository root
// has already been the source of one packaging outage.
const REPOSITORY_ROOT = (() => {
  let directory = PACKAGING_DIR
  for (let depth = 0; depth < 8; depth += 1) {
    directory = resolve(directory, '..')
    if (existsSync(join(directory, 'scripts', 'release', 'families.ts'))) return directory
  }
  throw new Error('kylin deb: repository root with scripts/release/families.ts not found above ' + PACKAGING_DIR)
})()
const CLI_ROOT = resolve(REPOSITORY_ROOT, 'apps', 'cli')
const PRIMARY_RUNTIME_LOCK = resolve(REPOSITORY_ROOT, 'scripts', 'primary-runtime', 'lock.json')

/** Target machine identity stamped into the package name and layout. */
const PACKAGE_NAME = 'deepseek-harness'
const PACKAGE_TARGET = 'kylin-v10-sp1'
const PACKAGE_ARCH = 'arm64'

/** Layout inside the target machine; the wrapper and maintainer scripts hard-code it. */
const APP_OPT_ROOT = 'opt/deepseek-harness'
const RUNTIME_DIR = `${APP_OPT_ROOT}/runtime`
const DSH_DIR = `${APP_OPT_ROOT}/dsh`
const DEPS_DIR = `${APP_OPT_ROOT}/deps`
const CLI_ENTRY = `${DSH_DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js`
const NODE_BIN = `${RUNTIME_DIR}/primary-runtime/dependencies/node/bin/node`

/**
 * Symbols the payload may require from the target machine's system libraries. Kylin V10 SP1
 * is Ubuntu 20.04-lineage: glibc 2.31 with the GCC 10 runtime, so official Node.js (built on
 * RHEL 8) fits its documented glibc 2.28 floor.
 */
const MAX_GLIBC = '2.31'
const MAX_GLIBCXX = '3.4.28'
const LIBC6_DEPEND = 'libc6 (>= 2.28)'

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
    throw new Error(`kylin deb: ${label} must name a directory, got ${JSON.stringify(value)}`)
  }
  mkdirSync(resolved, { recursive: true })
  return resolved
}

/**
 * Parse one symbol version (`major.minor` for GLIBC, `major.minor.patch` for GLIBCXX)
 * into a comparable zero-padded triple.
 * @param value - Version text.
 * @param label - Argument name for error messages.
 * @returns The numeric triple.
 */
function symbolVersion(value: string, label: string): readonly [number, number, number] {
  const parts = value.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isSafeInteger(part) || part < 0)) {
    throw new Error(`kylin deb: ${label} must be major.minor[.patch], got ${JSON.stringify(value)}`)
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/**
 * Compare two symbol version triples.
 * @returns Negative when `left` is older, zero when equal, positive when newer.
 */
function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  return (left[0] - right[0]) || (left[1] - right[1]) || ((left[2] ?? 0) - (right[2] ?? 0))
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
  if (typeof value !== 'string' || value === '') throw new Error(`kylin deb: ${subject} has no ${field}`)
  return value
}

/**
 * Decide whether one package manifest admits the target platform, following npm's
 * `os`/`cpu` rules (`!value` denies, absent or empty admits).
 * @param manifest - Parsed package.json object.
 * @param field - Either `os` or `cpu`.
 * @param value - Target value such as `linux` or `arm64`.
 * @returns True when the package installs on the target.
 */
function acceptsTarget(manifest: Readonly<Record<string, unknown>>, field: 'os' | 'cpu', value: string): boolean {
  const values = manifest[field]
  if (values === undefined) return true
  if (!Array.isArray(values) || !values.every(entry => typeof entry === 'string')) {
    throw new Error(`kylin deb: package manifest has invalid ${field}: ${JSON.stringify(values)}`)
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
    throw new Error('kylin deb: root package.json has no workspaces list')
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
 * Walk the CLI's dependency closure over workspace packages, honoring npm os/cpu filters so
 * platform packages for other machines (Darwin, x64) stay out of the package set.
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
    const directory = workspace.get(name)
    if (directory === undefined) continue
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
    if (!acceptsTarget(manifest, 'os', 'linux') || !acceptsTarget(manifest, 'cpu', 'arm64')) continue
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
    if (packed.has(identity.name)) throw new Error(`kylin deb: duplicate staged tarball for ${identity.name}`)
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
  console.log(`kylin deb: packed family ${familyId}: ${String(staged.length)} tarball(s)`)
  return indexPacked(destination, staged)
}

/**
 * Pack closure members the release families do not cover (the native system entry and its
 * platform package), running each package's prepack validation.
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
    if (directory === undefined) throw new Error(`kylin deb: closure member ${name} is not a workspace package`)
    const before = new Set(readdirSync(destination))
    capture('pnpm', ['--dir', directory, 'pack', '--pack-destination', destination])
    const file = readdirSync(destination).find(candidate => !before.has(candidate))
    if (file === undefined) throw new Error(`kylin deb: packing ${name} produced no tarball in ${destination}`)
    staged.push(file)
    console.log(`kylin deb: packed ${name}`)
  }
  return indexPacked(destination, staged)
}

/**
 * Run one pnpm install pass against the runtime project. The pnpm process reads its whole
 * configuration from npm_config_* environment variables, so no host .npmrc applies and no
 * configuration value ever becomes part of a command line.
 * @param project - Runtime project directory; also the command working directory.
 * @param state - Directory owning the pnpm store, cache, and config for this build.
 * @param args - pnpm arguments after the `install` command.
 */
function runPnpm(project: string, state: string, args: readonly string[]): void {
  const config = join(state, 'config')
  const home = join(state, 'home')
  mkdirSync(config, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(config, 'npmrc'), '')
  // spawnSync replaces the whole environment, so this carries exactly what pnpm needs:
  // a PATH for its own tool lookups, an isolated HOME, and its npm_config_* configuration.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    NPM_CONFIG_REGISTRY: process.env.DSH_NPM_REGISTRY ?? 'https://registry.npmjs.org',
    NPM_CONFIG_STORE_DIR: join(state, 'store'),
    NPM_CONFIG_USERCONFIG: join(config, 'npmrc'),
    npm_config_verify_store_integrity: 'true',
    npm_config_package_import_method: 'copy',
    npm_config_enable_global_virtual_store: 'false',
  }
  for (const proxy of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    const value = process.env[proxy]
    if (value !== undefined) environment[proxy] = value
  }
  capture('pnpm', ['install', ...args], { cwd: project, env: environment })
}

/**
 * Compose the runtime project's pnpm-workspace.yaml — the only home pnpm 11 reads for
 * overrides and build approvals — following the Desktop shipped-runtime pattern: the
 * project includes itself, installs hoisted (no store symlinks inside the deb), pins every
 * workspace tarball off the registry, and decides each package's build script explicitly so
 * a CI run never fails on ignored builds and never executes an unreviewed script.
 * @param overrides - Tarball overrides keyed by package name.
 * @returns The workspace file contents.
 */
function workspaceFile(overrides: Readonly<Record<string, string>>): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides['@deepseek-ai/dsh-subprocess-local']
  const coreBuildKey = coreBuildSpec === undefined
    ? JSON.stringify('@deepseek-ai/dsh-subprocess-local')
    : `  ${JSON.stringify('@deepseek-ai/dsh-subprocess-local@' + coreBuildSpec.replace('file:./', 'file:'))}`
  return `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\n${overrideSection}\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n${coreBuildKey}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
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
  if (dsh === undefined) throw new Error('kylin deb: the packed set omits @deepseek-ai/dsh')
  if (dsh.version !== version) {
    throw new Error(`kylin deb: packed @deepseek-ai/dsh ${dsh.version} does not match the CLI version ${version}`)
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
  }
  writeFileSync(join(project, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(project, 'pnpm-workspace.yaml'), workspaceFile(overrides))
  runPnpm(project, state, ['--lockfile-only'])
  const lockfile = readFileSync(join(project, 'pnpm-lock.yaml'), 'utf8')
  console.log(`kylin deb: runtime lockfile sha256 ${createHash('sha256').update(lockfile).digest('hex')}`)
  runPnpm(project, state, ['--prod', '--frozen-lockfile', '--trust-lockfile'])
  if (!existsSync(join(project, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
    throw new Error('kylin deb: runtime install produced no CLI entry under node_modules')
  }
}

/**
 * Copy the prepared payload trees and maintainer scripts into the deb data tree.
 * @param debRoot - The deb data tree root to (re)create.
 * @param sources - Prepared directories.
 */
function assembleTree(debRoot: string, sources: {
  readonly runtime: string
  readonly officeSkills: string
  readonly runtimeProject: string
}): void {
  rmSync(debRoot, { recursive: true, force: true })
  mkdirSync(join(debRoot, APP_OPT_ROOT), { recursive: true })
  mkdirSync(join(debRoot, 'DEBIAN'), { recursive: true })
  mkdirSync(join(debRoot, 'usr', 'bin'), { recursive: true })
  cpSync(join(sources.runtime, 'primary-runtime'), join(debRoot, RUNTIME_DIR, 'primary-runtime'), { recursive: true })
  cpSync(sources.officeSkills, join(debRoot, APP_OPT_ROOT, 'office-skills'), { recursive: true })
  cpSync(sources.runtimeProject, join(debRoot, DSH_DIR), { recursive: true })
  // The tarballs were install-time inputs; the installed tree resolves through node_modules.
  rmSync(join(debRoot, DSH_DIR, 'tarballs'), { recursive: true, force: true })
  cpSync(join(REPOSITORY_ROOT, 'LICENSE'), join(debRoot, APP_OPT_ROOT, 'LICENSE'))
  for (const [template, target, mode] of [
    ['dsh.sh', join(debRoot, 'usr', 'bin', 'dsh'), 0o755],
    ['install-deps.sh', join(debRoot, DEPS_DIR, 'install-deps.sh'), 0o755],
    ['postinst', join(debRoot, 'DEBIAN', 'postinst'), 0o755],
    ['deps-readme.txt', join(debRoot, DEPS_DIR, 'README.txt'), 0o644],
  ] as const) {
    const source = join(PACKAGING_DIR, template)
    if (!existsSync(source)) throw new Error(`kylin deb: missing template ${template}`)
    cpSync(source, target)
    chmodSync(target, mode)
  }
  // The offline dependency closure staged by `focal-container.sh fetch-deps`; empty or
  // absent means the payload needs nothing beyond glibc.
  const closure = join(PACKAGING_DIR, 'deps')
  if (existsSync(closure)) {
    for (const file of readdirSync(closure)) {
      if (file.endsWith('.deb')) cpSync(join(closure, file), join(debRoot, DEPS_DIR, file))
    }
  }
  for (const required of [NODE_BIN, CLI_ENTRY]) {
    if (!existsSync(join(debRoot, required))) throw new Error(`kylin deb: payload is missing ${required}`)
  }
}

/**
 * Measure the data tree and scan every ELF for glibc and libstdc++ symbol requirements.
 * @param debRoot - The deb data tree root.
 * @returns Total size in bytes, observed symbol maximums, and gate violations.
 */
function scanTree(debRoot: string): {
  bytes: number
  maximums: { glibc: readonly [number, number, number]; glibcxx: readonly [number, number, number] }
  violations: string[]
} {
  const gates: ReadonlyArray<{
    readonly kind: 'GLIBC' | 'GLIBCXX'
    readonly pattern: string
    readonly limit: readonly [number, number, number]
  }> = [
    { kind: 'GLIBC', pattern: 'GLIBC_([0-9]+\\.[0-9]+)', limit: symbolVersion(MAX_GLIBC, MAX_GLIBC) },
    { kind: 'GLIBCXX', pattern: 'GLIBCXX_([0-9]+\\.[0-9]+\\.[0-9]+)', limit: symbolVersion(MAX_GLIBCXX, MAX_GLIBCXX) },
  ]
  const observed = new Map<'GLIBC' | 'GLIBCXX', [number, number, number]>([
    ['GLIBC', [0, 0, 0]],
    ['GLIBCXX', [0, 0, 0]],
  ])
  const violations: string[] = []
  let bytes = 0
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile()) continue
      bytes += statSync(path).size
      // musl-linked payload binaries serve musl hosts, never this glibc package.
      if (relative(debRoot, path).split(/[\\/]/u).includes('musl')) continue
      const contents = readFileSync(path)
      if (contents.length < 4 || !contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue
      const text = contents.toString('latin1')
      for (const gate of gates) {
        let best: [number, number, number] = [0, 0, 0]
        for (const match of text.matchAll(new RegExp(gate.pattern, 'gu'))) {
          const version = symbolVersion(match[1] ?? '', gate.kind)
          if (compareVersions(version, best) > 0) best = version
        }
        const seen = observed.get(gate.kind)
        if (seen === undefined || compareVersions(best, seen) > 0) observed.set(gate.kind, best)
        if (compareVersions(best, gate.limit) > 0) {
          violations.push(relative(debRoot, path) + ' requires ' + gate.kind + '_' + best.join('.')
            + ' (gate ' + gate.limit.join('.') + ')')
        }
      }
    }
  }
  visit(debRoot)
  return {
    bytes,
    maximums: { glibc: observed.get('GLIBC') ?? [0, 0, 0], glibcxx: observed.get('GLIBCXX') ?? [0, 0, 0] },
    violations,
  }
}

/**
 * Write the DEBIAN control file from measured values.
 * @param debRoot - The deb data tree root.
 * @param version - The dsh release version.
 * @param installedSize - Data tree size in bytes.
 */
function writeControl(debRoot: string, version: string, installedSize: number): void {
  const control = [
    'Package: ' + PACKAGE_NAME,
    'Version: ' + version,
    'Section: utils',
    'Priority: optional',
    'Architecture: ' + PACKAGE_ARCH,
    'Installed-Size: ' + String(Math.ceil(installedSize / 1024)),
    'Depends: ' + LIBC6_DEPEND,
    'Maintainer: Hangzhou DeepSeek Artificial Intelligence Co., Ltd. <noreply@deepseek.com>',
    'Homepage: https://github.com/deepseek-ai/deepseek-harness',
    'Description: DeepSeek Harness CLI for Kylin V10 SP1 (' + PACKAGE_ARCH + ', offline package)',
    ' Self-contained dsh agent harness runtime: bundled Node.js, pnpm, Python and the',
    ' @deepseek-ai/dsh CLI. Built for the Kylin V10 SP1 glibc 2.31 baseline; installs no',
    ' system components and never upgrades packages already on the machine.',
  ]
  writeFileSync(join(debRoot, 'DEBIAN', 'control'), control.join('\n') + '\n')
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
    throw new Error('usage: build-deb.ts --output <dir> --work <dir> --cache <dir> [--concurrency 4]')
  }
  const outputDir = directoryOption(values.output, '--output')
  const workDir = directoryOption(values.work, '--work')
  const cacheDir = directoryOption(values.cache, '--cache')
  const concurrency = parsePackConcurrency(values.concurrency)
  const cliManifest = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
  const version = manifestString(cliManifest, 'version', join(CLI_ROOT, 'package.json'))
  const debPath = join(outputDir, PACKAGE_NAME + '-' + PACKAGE_TARGET + '-aarch64.deb')

  releaseFamily('dsh').verifyBuildArtifacts(REPOSITORY_ROOT)
  console.log('kylin deb: official build artifacts verified for ' + version)

  const tarballs = join(workDir, 'tarballs')
  const workspace = workspacePackages()
  const closure = selectClosure(cliManifest, workspace)
  console.log('kylin deb: CLI closure selects ' + String(closure.length) + ' workspace package(s)')

  const packed = new Map<string, PackedPackage>()
  for (const [name, entry] of await packFamily('dsh', join(tarballs, 'dsh'), concurrency)) packed.set(name, entry)
  for (const [name, entry] of await packFamily('vendor', join(tarballs, 'vendor'), 1)) packed.set(name, entry)
  const uncovered = closure.filter(name => !packed.has(name))
  for (const [name, entry] of packRemaining(uncovered, workspace, join(tarballs, 'local'))) packed.set(name, entry)

  const runtimeLock = JSON.parse(readFileSync(PRIMARY_RUNTIME_LOCK, 'utf8')) as { targets?: Record<string, unknown> }
  if (runtimeLock.targets === undefined || runtimeLock.targets['linux-arm64'] === undefined) {
    throw new Error('kylin deb: primary runtime lock has no linux-arm64 target')
  }
  const runtimeDir = join(workDir, 'runtime')
  capture('pnpm', ['exec', 'tsx', 'scripts/primary-runtime/prepare.ts',
    '--target', 'linux-arm64', '--output', runtimeDir, '--cache', cacheDir], { cwd: REPOSITORY_ROOT })

  const project = join(workDir, 'runtime-project')
  installRuntime(project, packed, version, join(workDir, 'pnpm-state'))

  const debRoot = join(workDir, 'debroot')
  assembleTree(debRoot, {
    runtime: runtimeDir,
    officeSkills: join(runtimeDir, 'office-skills'),
    runtimeProject: project,
  })
  // The data tree now owns every byte; free the staging copies before the deb build so the
  // peak disk use stays within a hosted runner's budget.
  rmSync(join(workDir, 'pnpm-state', 'store'), { recursive: true, force: true })
  rmSync(tarballs, { recursive: true, force: true })
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  const { bytes, maximums, violations } = scanTree(debRoot)
  writeControl(debRoot, version, bytes)
  console.log('kylin deb: data tree ' + (bytes / (1024 * 1024)).toFixed(1) + ' MiB, max glibc '
    + maximums.glibc.join('.') + ', max glibcxx ' + maximums.glibcxx.join('.'))
  if (violations.length > 0) {
    for (const violation of violations.slice(0, 10)) console.error('::error::' + violation)
    throw new Error('kylin deb: ' + String(violations.length) + ' payload file(s) exceed the ' + PACKAGE_TARGET + ' symbol gates')
  }

  capture('dpkg-deb', ['--build', '--root-owner-group', debRoot, debPath])
  // The file listing of a payload this size exceeds spawnSync's default output buffer.
  const listingResult = spawnSync('dpkg-deb', ['-c', debPath], {
    encoding: 'utf8', shell: false, maxBuffer: 1024 * 1024 * 512,
  })
  if (listingResult.error !== undefined) throw listingResult.error
  if (listingResult.status !== 0) {
    throw new Error('kylin deb: dpkg-deb -c exited with ' + String(listingResult.status ?? 'a signal'))
  }
  const listing = listingResult.stdout ?? ''
  for (const required of ['./' + CLI_ENTRY, './' + NODE_BIN, './usr/bin/dsh', './' + DEPS_DIR + '/install-deps.sh']) {
    if (!listing.includes(required)) throw new Error('kylin deb: packed deb omits ' + required)
  }
  const controlDir = join(workDir, 'control')
  mkdirSync(controlDir, { recursive: true })
  capture('dpkg-deb', ['-e', debPath, controlDir])
  if (!existsSync(join(controlDir, 'postinst'))) throw new Error('kylin deb: packed deb omits the postinst maintainer script')

  console.log('kylin deb: built ' + debPath + ' (' + (statSync(debPath).size / (1024 * 1024)).toFixed(1) + ' MiB)')
}
