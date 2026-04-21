/**
 * Build standalone executables for all platforms using pkg.
 * Run: npx tsx build.ts
 */
import { execSync } from 'child_process'
import { existsSync, mkdirSync } from 'fs'

const TARGETS = [
  { platform: 'mac-arm64',   pkg: 'node18-macos-arm64',   out: 'mevbot-runner-mac-arm64'     },
  { platform: 'mac-x64',     pkg: 'node18-macos-x64',     out: 'mevbot-runner-mac-x64'       },
  { platform: 'win-x64',     pkg: 'node18-win-x64',       out: 'mevbot-runner-win-x64.exe'   },
  { platform: 'linux-x64',   pkg: 'node18-linux-x64',     out: 'mevbot-runner-linux-x64'     },
]

const target = process.argv[2] // optional: filter single platform

if (!existsSync('dist-bin')) mkdirSync('dist-bin')

// 1. Compile TypeScript → CommonJS for pkg compatibility
console.log('Compiling TypeScript...')
execSync('npx tsc -p tsconfig.pkg.json', { stdio: 'inherit' })

// 2. Package with pkg
const targets = target ? TARGETS.filter((t) => t.platform === target) : TARGETS

for (const t of targets) {
  console.log(`\nPackaging ${t.platform}...`)
  execSync(
    `npx pkg dist-cjs/index.js --target ${t.pkg} --output dist-bin/${t.out} --compress GZip`,
    { stdio: 'inherit' }
  )
  console.log(`✓ dist-bin/${t.out}`)
}

console.log('\nAll builds complete.')
