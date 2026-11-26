'use strict';
// bin/sshconfig.js: the address a person types, Kolonka's block in ~/.ssh/config, and writing that file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../bin/sshconfig');
const R = require('../src/main/remote');

const tmpdir = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolonka-sshcfg-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const target = (s) => { const r = C.parseTarget(s); assert.ok(!r.error, `${s}: ${r.error}`); return r; };
const BLOCK = (key, host, eol = '\n') => [`# >>> kolonka: ${key}`, `Host ${host}`, '    SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN', `# <<< kolonka: ${key}`].join(eol) + eol;
const noRestrict = async () => true;

// ---------- the address ----------

test('parseTarget: aliases, hosts, users, ports, IPv4 and IPv6', () => {
  const pick = (s) => { const r = target(s); return [r.destination, r.options, r.host, r.key]; };
  assert.deepEqual(pick('myserver'), ['myserver', [], 'myserver', 'myserver']);
  assert.deepEqual(pick('  build.example.com '), ['build.example.com', [], 'build.example.com', 'build.example.com']);
  assert.deepEqual(pick('leo@myserver'), ['leo@myserver', [], 'myserver', 'leo@myserver']);
  assert.deepEqual(pick('user@203.0.113.10'), ['user@203.0.113.10', [], '203.0.113.10', 'user@203.0.113.10']);
  assert.deepEqual(pick('user@203.0.113.10:2222'), ['user@203.0.113.10', ['-p', '2222'], '203.0.113.10', 'user@203.0.113.10:2222']);
  assert.deepEqual(pick('myserver:22'), ['myserver', [], 'myserver', 'myserver'], 'port 22 is the default');
  assert.deepEqual(pick('myserver:0022'), ['myserver', [], 'myserver', 'myserver']);
  assert.deepEqual(pick('2001:db8::1'), ['2001:db8::1', [], '2001:db8::1', '[2001:db8::1]'], 'IPv6 without a port');
  assert.deepEqual(pick('leo@[2001:db8::1]:2222'), ['leo@2001:db8::1', ['-p', '2222'], '2001:db8::1', 'leo@[2001:db8::1]:2222']);
  assert.deepEqual(pick('[::1]'), ['::1', [], '::1', '[::1]']);
  assert.deepEqual(pick('ssh://leo@myserver:2200/'), ['leo@myserver', ['-p', '2200'], 'myserver', 'leo@myserver:2200']);
});

test('parseTarget: anything ssh (or the msys argument parser) could read as an option, a file or a pattern is refused', () => {
  const err = (s) => C.parseTarget(s).error;
  assert.equal(err(''), 'empty');
  assert.equal(err('   '), 'empty');
  assert.equal(err(undefined), 'empty');
  assert.equal(err('-oProxyCommand=calc'), 'option');
  assert.equal(err('@C:\\x'), 'at');
  assert.equal(err('my server'), 'space');
  assert.equal(err('myserver\nHost *'), 'space');
  assert.equal(err('host;calc'), 'host');
  assert.equal(err('my*'), 'host', 'a Host pattern would match other hosts');
  assert.equal(err('!myserver'), 'host');
  assert.equal(err('.hidden'), 'host');
  assert.equal(err('leo@'), 'host');
  assert.equal(err('leo@-oX'), 'host');
  assert.equal(err('-leo@myserver'), 'option');
  assert.equal(err('le o@myserver'), 'space');
  assert.equal(err('le$o@myserver'), 'user');
  assert.equal(err('myserver:0'), 'port');
  assert.equal(err('myserver:65536'), 'port');
  assert.equal(err('myserver:ssh'), 'port');
  assert.equal(err('myserver:'), 'port');
  assert.equal(err('[myserver]:22'), 'host');
  assert.equal(err('[2001:db8::1'), 'host');
  assert.equal(err('2001:db8::g'), 'host');
  assert.equal(err('a'.repeat(256)), 'long');
  for (const code of new Set(['empty', 'option', 'at', 'space', 'host', 'user', 'port', 'long', 'chars'])) assert.ok(C.ERRORS[code], code);
});

test('parseTarget: every destination it gives is one remote.js accepts, keys are destKey, validators agree', () => {
  for (const s of ['myserver', 'leo@myserver', 'user@203.0.113.10:2222', '2001:db8::1', 'leo@[2001:db8::1]:2222', 'a.b-c_d', 'x@y@myserver:10']) {
    const r = target(s);
    assert.ok(R.validHost(r.destination), r.destination);
    assert.equal(r.key, R.destKey({ destination: r.destination, options: r.options }), s);
    assert.ok(R.validKey(r.key), r.key);
  }
  for (const h of ['myserver', 'a@b', '-x', '@x', 'a b', 'a/b', 'a'.repeat(255), 'a'.repeat(256), 'x:y', '[x]', '', 'é', 'a\nb']) {
    assert.equal(C.validHost(h), R.validHost(h), JSON.stringify(h));
  }
  for (const c of ['', 'htop', 'a\tb', 'a\nb', 'a\u202eb', 'x'.repeat(512), 'x'.repeat(513), 'a\u0007', 'tail -f log | grep x']) {
    assert.equal(C.validCmd(c), R.validCmd(c), JSON.stringify(c));
  }
});

// ---------- the text ----------

test('addBlock: an empty file gets just the block; a file without a final line end gets one and a blank line', () => {
  const t = target('myserver');
  assert.equal(C.addBlock('', t).text, BLOCK('myserver', 'myserver'));
  assert.equal(C.addBlock('', t, { eol: '\r\n' }).text, BLOCK('myserver', 'myserver', '\r\n'), 'a new file takes the default line end');
  assert.equal(C.addBlock('Host a\n  User x', t).text, 'Host a\n  User x\n\n' + BLOCK('myserver', 'myserver'));
  assert.equal(C.addBlock('Host a\n\n', t).text, 'Host a\n\n' + BLOCK('myserver', 'myserver'), 'no second blank line');
});

test('addBlock: CRLF files stay CRLF, the lines that were there are not touched', () => {
  const before = 'Host a\r\n  User x\r\nHost b\n  User y\r\n';
  const r = C.addBlock(before, target('myserver'), { eol: '\n' });
  assert.ok(r.text.startsWith(before), 'the old text byte for byte, even its one LF line');
  assert.equal(r.text.slice(before.length), '\r\n' + BLOCK('myserver', 'myserver', '\r\n'));
});

test('addBlock: a block of the user for the same host stays as it is, ours comes after it', () => {
  const user = 'Host myserver\n  HostName 203.0.113.10\n  User leo\n  SendEnv LANG\n';
  const r = C.addBlock(user, target('myserver'));
  assert.equal(r.text, user + '\n' + BLOCK('myserver', 'myserver'));
});

test('addBlock: connecting again changes nothing (by the markers), whatever the case of the host', () => {
  const once = C.addBlock('Host a\n', target('myserver')).text;
  const again = C.addBlock(once, target('MyServer'));
  assert.equal(again.changed, false);
  assert.equal(again.text, once);
  const other = C.addBlock(once, target('leo@myserver')).text;
  assert.equal(C.listKeys(other).join(), 'myserver,leo@myserver', 'another user is another connection');
});

test('addBlock: after a Match block at the end of the file, the Host line starts a block of its own', () => {
  const r = C.addBlock('Host *\n  ServerAliveInterval 30\nMatch exec "true"\n  ForwardAgent yes\n', target('myserver'));
  const lines = r.text.split('\n');
  const host = lines.indexOf('Host myserver');
  assert.ok(host > lines.indexOf('  ForwardAgent yes'));
  assert.equal(lines[host + 1], '    SendEnv LC_TERMINAL LC_TERMINAL_VERSION KOLONKA_TOKEN');
  assert.equal(lines[host - 1], '# >>> kolonka: myserver');
});

test('addBlock: user@host:port and IPv6 get Host <host only>, no brackets; the marker has the whole key', () => {
  assert.match(C.addBlock('', target('leo@203.0.113.10:2222')).text, /^# >>> kolonka: leo@203\.0\.113\.10:2222\nHost 203\.0\.113\.10\n/);
  assert.match(C.addBlock('', target('leo@[2001:db8::1]:2222')).text, /^# >>> kolonka: leo@\[2001:db8::1\]:2222\nHost 2001:db8::1\n/);
});

test('removeBlock: only our block for that key goes, with the blank line before it; the rest stays byte for byte', () => {
  const head = 'Host myserver\r\n  User leo\r\n';
  let text = C.addBlock(head, target('myserver')).text;
  text = C.addBlock(text, target('other')).text;
  text += '# >>> kolonka: someone-elses-note\n'; // not closed, but not the one being removed
  const r = C.removeBlock(text, 'MYSERVER');
  assert.equal(r.changed, true);
  assert.equal(r.text, head + '\r\n' + BLOCK('other', 'other', '\r\n') + '# >>> kolonka: someone-elses-note\n');
  assert.equal(C.removeBlock(r.text, 'myserver').changed, false);
  assert.equal(C.removeBlock(C.addBlock('', target('myserver')).text, 'myserver').text, '');
});

test('a block without its closing marker is not guessed at: connect and disconnect refuse', () => {
  const broken = 'Host a\n# >>> kolonka: myserver\nHost myserver\n';
  assert.throws(() => C.addBlock(broken, target('myserver')), (e) => e.code === 'unclosed');
  assert.throws(() => C.removeBlock(broken, 'myserver'), (e) => e.code === 'unclosed');
  assert.deepEqual(C.listKeys(broken), []);
});

test('decode / encode: UTF-8 with and without a BOM, other bytes kept as they are, UTF-16 refused', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const withBom = Buffer.concat([bom, Buffer.from('# Привет\nHost a\n')]);
  const d = C.decodeConfig(withBom);
  assert.equal(d.bom, true);
  assert.equal(d.text, '# Привет\nHost a\n');
  assert.deepEqual(C.encodeConfig(d), withBom);
  const latin = Buffer.from([0x23, 0x20, 0xe9, 0x0a]); // "# é\n" in latin1, not valid UTF-8
  const l = C.decodeConfig(latin);
  assert.deepEqual(C.encodeConfig(Object.assign({}, l, { text: l.text + 'x\n' })), Buffer.concat([latin, Buffer.from('x\n')]));
  assert.throws(() => C.decodeConfig(Buffer.from([0xff, 0xfe, 0x48, 0x00])), (e) => e.code === 'utf16');
});

// ---------- the file ----------

test('connectConfig: no .ssh folder, no file: both created, the file limited to the user, no backup', async (t) => {
  const home = tmpdir(t);
  const restricted = [];
  const r = await C.connectConfig(target('myserver'), { home, platform: 'win32', restrict: async (f) => { restricted.push(f); return true; } });
  const file = path.join(home, '.ssh', 'config');
  assert.deepEqual(r, { file, changed: true, created: true, backup: null });
  assert.equal(fs.readFileSync(file, 'utf8'), BLOCK('myserver', 'myserver', '\r\n'), 'a new file on Windows: CRLF');
  assert.equal(restricted.length, 1);
  assert.match(path.basename(restricted[0]), /^config\.kolonka-\d+-[0-9a-f]+\.tmp$/, 'the ACL is set before the file takes its place');
  assert.deepEqual(fs.readdirSync(path.join(home, '.ssh')), ['config'], 'no temp, lock or backup left');
  if (process.platform !== 'win32') {
    const r2 = await C.connectConfig(target('other'), { home: tmpdir(t), platform: 'linux' });
    assert.equal(fs.statSync(r2.file).mode & 0o777, 0o600);
  }
});

test('connectConfig: an existing file: one backup of it, the block added, BOM and CRLF kept; again: nothing, no backup', async (t) => {
  const home = tmpdir(t);
  fs.mkdirSync(path.join(home, '.ssh'));
  const file = path.join(home, '.ssh', 'config');
  const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Host myserver\r\n  User leo\r\n')]);
  fs.writeFileSync(file, before);
  const now = new Date('2026-11-26T15:30:00.123Z');
  const r = await C.connectConfig(target('myserver'), { home, now, platform: 'win32', restrict: noRestrict });
  assert.equal(r.changed, true);
  assert.equal(r.backup, file + '.bak-kolonka-20261126T153000Z');
  assert.deepEqual(fs.readFileSync(r.backup), before);
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([before, Buffer.from('\r\n' + BLOCK('myserver', 'myserver', '\r\n'))]));
  const again = await C.connectConfig(target('myserver'), { home, now, platform: 'win32', restrict: noRestrict });
  assert.deepEqual(again, { file, changed: false, created: false, backup: null });
  assert.equal(fs.readdirSync(path.join(home, '.ssh')).length, 2, 'config and one backup');
  // a second change in the same second gets its own backup
  const third = await C.connectConfig(target('other'), { home, now, platform: 'win32', restrict: noRestrict });
  assert.equal(third.backup, file + '.bak-kolonka-20261126T153000Z-2');
});

test('connectConfig: a read-only file, a symlink or a folder is not written', async (t) => {
  const home = tmpdir(t);
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, 'Host a\n');
  fs.chmodSync(file, 0o444);
  await assert.rejects(C.connectConfig(target('myserver'), { home, restrict: noRestrict }), (e) => e.code === 'readonly');
  fs.chmodSync(file, 0o644);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Host a\n');

  const real = path.join(home, 'real-config');
  fs.writeFileSync(real, 'Host a\n');
  fs.rmSync(file);
  let linked = true;
  try { fs.symlinkSync(real, file); } catch { linked = false; } // Windows without the symlink privilege
  if (linked) {
    await assert.rejects(C.connectConfig(target('myserver'), { home, restrict: noRestrict }), (e) => e.code === 'symlink');
    assert.equal(fs.readFileSync(real, 'utf8'), 'Host a\n');
    fs.rmSync(file);
  }
  fs.mkdirSync(file);
  await assert.rejects(C.connectConfig(target('myserver'), { home, restrict: noRestrict }), (e) => e.code === 'notfile');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config']);
});

test('connectConfig: if the ACL cannot be set, the file is not replaced and no temp file is left', async (t) => {
  const home = tmpdir(t);
  const dir = path.join(home, '.ssh');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config'), 'Host a\n');
  await assert.rejects(C.connectConfig(target('myserver'), { home, platform: 'win32', restrict: async () => { throw new Error('icacls failed: access denied'); } }),
    (e) => e.code === 'write' && /icacls failed/.test(e.message));
  assert.equal(fs.readFileSync(path.join(dir, 'config'), 'utf8'), 'Host a\n');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => /tmp|lock/.test(f)), []);
});

test('two connects at once both land (the lock), none lost', async (t) => {
  const home = tmpdir(t);
  const hosts = ['a1', 'a2', 'a3', 'a4', 'a5'];
  // a slow ACL step between reading and replacing the file, as icacls is on Windows
  const slow = () => new Promise((r) => setTimeout(r, 20));
  await Promise.all(hosts.map((h) => C.connectConfig(target(h), { home, platform: 'win32', restrict: slow })));
  assert.deepEqual(C.readKeys(C.configFile(home)).sort(), hosts);
});

test('disconnectConfig: removes our block (with a backup), no file or folder: nothing, nothing created', async (t) => {
  const home = tmpdir(t);
  assert.deepEqual(await C.disconnectConfig('myserver', { home }), { file: C.configFile(home), changed: false, created: false, backup: null });
  assert.equal(fs.existsSync(path.join(home, '.ssh')), false);
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(C.configFile(home), 'Host keep\n');
  await C.connectConfig(target('myserver'), { home, restrict: noRestrict });
  const r = await C.disconnectConfig('myserver', { home, restrict: noRestrict });
  assert.equal(r.changed, true);
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(fs.readFileSync(C.configFile(home), 'utf8'), 'Host keep\n');
});

test('connectArg: Kolonka.exe --connect=ADDRESS or --connect ADDRESS; nothing else', () => {
  assert.equal(C.connectArg(['Kolonka.exe', '--connect=leo@myserver:2222']), 'leo@myserver:2222');
  assert.equal(C.connectArg(['Kolonka.exe', '--allow-file-access', '--connect', 'myserver']), 'myserver');
  assert.equal(C.connectArg(['Kolonka.exe', '--connect', '--other']), null);
  assert.equal(C.connectArg(['Kolonka.exe', '--connect']), null);
  assert.equal(C.connectArg(['Kolonka.exe', 'myserver']), null);
  assert.equal(C.connectArg(undefined), null);
});
