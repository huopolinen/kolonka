'use strict';
// Checks the files electron-updater relies on, after `electron-builder --win nsis`:
//   - latest.yml names the installer that was built, with its real sha512 and size (electron-updater
//     refuses a download whose sha512 differs, so a stale latest.yml would break every update);
//   - the blockmap next to it is valid and covers the whole installer (differential downloads);
//   - the installer runs without elevation (per-user, no UAC prompt when it updates the app);
//   - resources/app-update.yml in the package points at this repository.
//   node test/smoke/release-files.js [dist] [version]   (version: package.json's by default)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');

function sha512(file) { return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64'); }

// -> list of what was checked; throws with every problem found
function checkRelease({ dist, version, owner = 'huopolinen', repo = 'kolonka' }) {
  const yaml = require('js-yaml');
  const problems = [];
  const ok = [];
  const fail = (m) => problems.push(m);
  const exeName = `Kolonka-Setup-${version}.exe`;
  const exe = path.join(dist, exeName);

  const latestFile = path.join(dist, 'latest.yml');
  let latest = null;
  try { latest = yaml.load(fs.readFileSync(latestFile, 'utf8')); } catch (e) { fail(`latest.yml: ${e.message}`); }
  if (!fs.existsSync(exe)) fail(`${exeName} was not built`);

  if (latest && fs.existsSync(exe)) {
    const size = fs.statSync(exe).size;
    const hash = sha512(exe);
    const files = Array.isArray(latest.files) ? latest.files : [];
    if (String(latest.version) !== version) fail(`latest.yml version ${latest.version}, expected ${version}`);
    if (files.length !== 1) fail(`latest.yml lists ${files.length} files, expected the installer only`);
    const f = files[0] || {};
    if (f.url !== exeName) fail(`latest.yml files[0].url is ${f.url}, the release asset is ${exeName}`);
    if (latest.path !== exeName) fail(`latest.yml path is ${latest.path}, expected ${exeName}`);
    if (f.sha512 !== hash) fail(`latest.yml files[0].sha512 does not match ${exeName}`);
    if (latest.sha512 !== hash) fail(`latest.yml sha512 does not match ${exeName}`);
    if (f.size !== size) fail(`latest.yml files[0].size is ${f.size}, ${exeName} has ${size} bytes`);
    if (f.isAdminRightsRequired || latest.isAdminRightsRequired) fail('latest.yml says the update needs admin rights (a per-user install must not)');
    ok.push(`latest.yml: ${version}, ${exeName}, ${size} bytes, sha512 matches`);

    const bm = exe + '.blockmap';
    if (!fs.existsSync(bm)) fail(`${exeName}.blockmap was not built (needed for differential updates)`);
    else {
      try {
        const map = JSON.parse(zlib.gunzipSync(fs.readFileSync(bm)).toString('utf8'));
        const file = map.files && map.files[0];
        const total = file && Array.isArray(file.sizes) ? file.sizes.reduce((a, b) => a + b, 0) : -1;
        if (!file || !file.checksums || file.checksums.length !== file.sizes.length || file.checksums.length === 0) fail('the blockmap has no blocks');
        else if (total !== size) fail(`the blockmap covers ${total} bytes, the installer has ${size}`);
        else ok.push(`blockmap: ${file.checksums.length} blocks over the whole installer`);
      } catch (e) { fail(`the blockmap cannot be read: ${e.message}`); }
    }

    // the stub's manifest (raw XML in its resources): asInvoker = no UAC prompt
    const buf = fs.readFileSync(exe);
    const at = buf.indexOf('<requestedExecutionLevel');
    const tag = at < 0 ? '' : buf.subarray(at, at + 120).toString('latin1');
    const level = (/level="([^"]+)"/.exec(tag) || [])[1];
    if (level !== 'asInvoker') fail(`the installer requests execution level ${level || '(none found)'}, expected asInvoker`);
    else ok.push('installer manifest: asInvoker (no UAC)');
  }

  const appUpdate = path.join(dist, 'win-unpacked', 'resources', 'app-update.yml');
  let cfg = null;
  try { cfg = yaml.load(fs.readFileSync(appUpdate, 'utf8')); } catch (e) { fail(`app-update.yml: ${e.message}`); }
  if (cfg) {
    if (cfg.provider !== 'github' || cfg.owner !== owner || cfg.repo !== repo) fail(`app-update.yml points at ${cfg.provider} ${cfg.owner}/${cfg.repo}, expected github ${owner}/${repo}`);
    if (!cfg.updaterCacheDirName) fail('app-update.yml has no updaterCacheDirName');
    if (cfg.private || cfg.token) fail('app-update.yml must not carry a token');
    ok.push(`app-update.yml: ${cfg.provider} ${cfg.owner}/${cfg.repo}, cache ${cfg.updaterCacheDirName}${cfg.publisherName ? ', publisher ' + cfg.publisherName : ', no publisherName (unsigned)'}`);
  }

  if (problems.length) throw new Error('release files:\n  ' + problems.join('\n  '));
  return ok;
}

module.exports = { checkRelease };

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));
  const version = process.argv[3] || require(path.join(ROOT, 'package.json')).version;
  try {
    for (const line of checkRelease({ dist, version })) console.log('[release-files]', line);
    console.log('[release-files] ok');
  } catch (e) {
    console.error('[release-files] FAIL:', e.message);
    process.exitCode = 1;
  }
}
