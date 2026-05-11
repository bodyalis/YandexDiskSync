// Bumps versions.json + manifest.json after `npm version <new-version>`.
// Run as part of `npm version` via the "version" script in package.json.

import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
    console.error('npm_package_version is not set; run via `npm version`.');
    process.exit(1);
}

// Read minAppVersion from manifest.json and bump version to target version
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, '\t') + '\n');

// Update versions.json with target version and minAppVersion from manifest.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, '\t') + '\n');

console.log(`Bumped to ${targetVersion} (minAppVersion ${minAppVersion}).`);
