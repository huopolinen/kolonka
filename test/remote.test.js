'use strict';
// Remote control over ssh, the pure parts: OSC 7711 / 9 / 777, ssh command lines, the process tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/main/remote');

const b = R.b64encode;

// ---------- base64 ----------

test('base64: standard alphabet, padding optional, UTF-8 only', () => {
  assert.equal(R.b64decode(b('привет, myserver')), 'привет, myserver');
  assert.equal(R.b64decode('aGk='), 'hi');
  assert.equal(R.b64decode('aGk'), 'hi', 'without padding');
  assert.equal(R.b64decode(''), '');
  assert.equal(R.b64decode('aGk=='), null, 'wrong padding');
  assert.equal(R.b64decode('a'), null, 'impossible length');
  assert.equal(R.b64decode('aG-_'), null, 'base64url is not accepted');
  assert.equal(R.b64decode('aGk=aGk='), null, 'padding in the middle');
  assert.equal(R.b64decode('aG k='), null);
  assert.equal(R.b64decode(Buffer.from([0xff, 0xfe]).toString('base64')), null, 'not UTF-8');
});

// ---------- OSC 7711 ----------

test('open: all fields decoded; select defaults to 1', () => {
  const r = R.parseRemoteOsc(`open;host=${b('@same')};cmd=${b('htop -d 5')};name=${b('top')};ws=${b('ops')};select=0`);
  assert.deepEqual(r, { action: 'open', host: '@same', cmd: 'htop -d 5', name: 'top', ws: 'ops', select: false });
  const d = R.parseRemoteOsc(`open;host=${b('leo@myserver')}`);
  assert.deepEqual(d, { action: 'open', host: 'leo@myserver', cmd: '', name: '', ws: '', select: true });
});

test('open: spaces around fields and unknown fields are ignored', () => {
  const r = R.parseRemoteOsc(` open ; host=${b('myserver')} ; cmd=${b('ls')} ; future=1 ; junk ; select=1`);
  assert.equal(r.action, 'open');
  assert.equal(r.host, 'myserver');
  assert.equal(r.cmd, 'ls');
});

test('open: missing host, bad host, bad base64, duplicate fields, bad select are errors', () => {
  assert.match(R.parseRemoteOsc(`open;cmd=${b('ls')}`).error, /needs host/);
  assert.match(R.parseRemoteOsc(`open;host=${b('-oProxyCommand=calc')}`).error, /host/);
  assert.match(R.parseRemoteOsc(`open;host=${b('my server')}`).error, /host/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a;b')}`).error, /host/);
  assert.match(R.parseRemoteOsc('open;host=@@@').error, /base64/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};host=${b('b')}`).error, /duplicate/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};select=yes`).error, /select/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};cmd=${b('ls\nrm -rf ~')}`).error, /cmd/, 'a newline in cmd');
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};cmd=${b('ls \u202erm')}`).error, /cmd/, 'a bidi override in cmd');
  assert.match(R.parseRemoteOsc('x'.repeat(20000)).error, /longer/);
});

test('status, notify, rename: validated and sanitized', () => {
  assert.deepEqual(R.parseRemoteOsc('status;state=blocked'), { action: 'status', state: 'blocked' });
  assert.match(R.parseRemoteOsc('status;state=evil').error, /state/);
  assert.match(R.parseRemoteOsc('status').error, /state/);

  const n = R.parseRemoteOsc(`notify;title=${b('Build\x1b[31m')};text=${b('line1\nline2\x07' + 'x'.repeat(400))}`);
  assert.equal(n.action, 'notify');
  assert.equal(n.title, 'Build [31m', 'escape characters removed');
  assert.ok(!/[\x00-\x1f]/.test(n.text));
  assert.equal(Array.from(n.text).length, 300);
  assert.ok(n.text.startsWith('line1 line2'));
  assert.deepEqual(R.parseRemoteOsc(`notify;text=${b('hi')}`), { action: 'notify', title: '', text: 'hi' });
  assert.match(R.parseRemoteOsc('notify').error, /needs/);
  assert.match(R.parseRemoteOsc('notify;text=***').error, /base64/);

  const r = R.parseRemoteOsc(`rename;name=${b('\u202e' + 'n'.repeat(100))}`);
  assert.equal(r.name, 'n'.repeat(80));
  assert.match(R.parseRemoteOsc(`rename;name=${b('\x1b\x07')}`).error, /needs name/);
  assert.match(R.parseRemoteOsc('launch;x=1').error, /unknown action/);
});

// ---------- OSC 9 / 777 ----------

test('OSC 9: a notification is 9;<text>, not ConEmu\'s 9;N subcommands', () => {
  assert.deepEqual(R.notifyFromOsc9('Build finished'), { action: 'notify', title: '', text: 'Build finished' });
  assert.deepEqual(R.notifyFromOsc9('\n\nClaude needs your permission'), { action: 'notify', title: '', text: 'Claude needs your permission' });
  assert.equal(R.notifyFromOsc9('9;C:\\x'), null, 'cwd');
  assert.equal(R.notifyFromOsc9('4;1;50'), null, 'progress');
  assert.equal(R.notifyFromOsc9('12'), null);
  assert.equal(R.notifyFromOsc9(''), null);
  assert.deepEqual(R.notifyFromOsc9('3 tests failed'), { action: 'notify', title: '', text: '3 tests failed' }, 'a digit not followed by ; is text');
});

test('OSC 777: notify;title;body', () => {
  assert.deepEqual(R.notifyFromOsc777('notify;Claude;Done; all good'), { action: 'notify', title: 'Claude', text: 'Done; all good' });
  assert.deepEqual(R.notifyFromOsc777('notify;Only title'), { action: 'notify', title: 'Only title', text: '' });
  assert.equal(R.notifyFromOsc777('preexec'), null);
  assert.equal(R.notifyFromOsc777('notify;;'), null);
});

// ---------- Windows command lines and ssh getopt ----------

test('parseWinCommandLine follows the C runtime rules', () => {
  assert.deepEqual(R.parseWinCommandLine('"C:\\Program Files\\Git\\usr\\bin\\ssh.exe" -p 2222 leo@myserver'),
    ['C:\\Program Files\\Git\\usr\\bin\\ssh.exe', '-p', '2222', 'leo@myserver']);
  assert.deepEqual(R.parseWinCommandLine('ssh.exe -i "C:\\Users\\a b\\.ssh\\id" myserver'), ['ssh.exe', '-i', 'C:\\Users\\a b\\.ssh\\id', 'myserver']);
  assert.deepEqual(R.parseWinCommandLine('ssh a\\\\"b c"  d\\"e  "f\\\\"'), ['ssh', 'a\\b c', 'd"e', 'f\\']);
  assert.deepEqual(R.parseWinCommandLine('C:\\Windows\\System32\\OpenSSH\\ssh.exe\tmyserver'), ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', 'myserver']);
  assert.deepEqual(R.parseWinCommandLine('ssh "a ""quoted"" word"'), ['ssh', 'a "quoted" word']);
});

const parse = (line) => R.parseSshArgs(R.parseWinCommandLine(line).slice(1));

test('parseSshArgs: destination and the safe options only', () => {
  assert.deepEqual(parse('ssh leo@myserver'), { destination: 'leo@myserver', options: [] });
  assert.deepEqual(parse('ssh 100.64.1.2'), { destination: '100.64.1.2', options: [] });
  assert.deepEqual(parse('ssh -p 2222 myserver'), { destination: 'myserver', options: ['-p', '2222'] });
  assert.deepEqual(parse('ssh -p2222 -lleo myserver'), { destination: 'myserver', options: ['-p', '2222', '-l', 'leo'] });
  assert.deepEqual(parse('ssh.exe -i "C:\\Users\\a b\\.ssh\\id" myserver'), { destination: 'myserver', options: ['-i', 'C:\\Users\\a b\\.ssh\\id'] });
  assert.deepEqual(parse('ssh -4 -J jump@bastion:22 myserver'), { destination: 'myserver', options: ['-4', '-J', 'jump@bastion:22'] });
  assert.deepEqual(parse('ssh -46vAt myserver'), { destination: 'myserver', options: ['-4', '-6'] }, 'a cluster of flags');
});

test('parseSshArgs: dangerous options are dropped, not carried over', () => {
  assert.deepEqual(parse('ssh -o "ProxyCommand=calc.exe" myserver'), { destination: 'myserver', options: [] });
  assert.deepEqual(parse('ssh -oProxyCommand=calc myserver'), { destination: 'myserver', options: [] });
  assert.deepEqual(parse('ssh -F C:\\evil\\config -E log -L 8080:x:80 -R 9:y:9 -D 1080 -S sock -O check -W h:1 -A -X myserver'), { destination: 'myserver', options: [] });
  assert.deepEqual(parse('ssh -v -c aes128-ctr -m hmac-sha2-256 -b 10.0.0.1 -e none myserver'), { destination: 'myserver', options: [] });
});

test('parseSshArgs: --, options after the destination, the remote command, URIs', () => {
  assert.deepEqual(parse('ssh -- myserver'), { destination: 'myserver', options: [] });
  assert.deepEqual(parse('ssh -- myserver -p 99'), { destination: 'myserver', options: [] }, 'after -- everything is the command');
  assert.deepEqual(parse('ssh myserver -p 2222'), { destination: 'myserver', options: ['-p', '2222'] }, 'ssh takes options after the host too');
  assert.deepEqual(parse('ssh -t myserver tmux attach -t main'), { destination: 'myserver', options: [] });
  assert.deepEqual(parse('ssh myserver -- -p 1'), { destination: 'myserver', options: [] });
  assert.deepEqual(parse('ssh ssh://leo@myserver:2222'), { destination: 'leo@myserver', options: ['-p', '2222'] });
});

test('parseSshArgs: nothing usable -> null', () => {
  assert.equal(parse('ssh'), null);
  assert.equal(parse('ssh -p'), null, 'an option without its argument');
  assert.equal(parse('ssh -V'), null);
  assert.equal(parse('ssh -p 99999 myserver'), null, 'a port out of range');
  assert.equal(parse('ssh "my server"'), null);
});

test('-i written the msys way (Git Bash ssh) becomes a Windows path', () => {
  assert.deepEqual(parse('ssh -i /c/Users/leo/.ssh/id_ed25519 myserver').options, ['-i', 'C:\\Users\\leo\\.ssh\\id_ed25519']);
  assert.deepEqual(parse('ssh -i ~/.ssh/id myserver').options, ['-i', '~/.ssh/id']);
});

test('buildSshArgs: terminal, SendEnv, options, then -- destination and the command as one argument', () => {
  assert.deepEqual(R.buildSshArgs({ destination: 'leo@myserver', options: ['-p', '2222'], cmd: 'cd ~/x && claude' }),
    ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', '-p', '2222', '--', 'leo@myserver', 'cd ~/x && claude']);
  assert.deepEqual(R.buildSshArgs({ destination: 'myserver', options: [], cmd: '' }).slice(-2), ['--', 'myserver'], 'no command: a login shell');
});

test('normalizeSsh rejects what could not have come from parseSshArgs', () => {
  assert.deepEqual(R.normalizeSsh({ destination: 'myserver', options: ['-p', '22'], cmd: 'ls' }), { destination: 'myserver', options: ['-p', '22'], cmd: 'ls' });
  assert.equal(R.normalizeSsh({ destination: 'myserver', options: ['-o', 'ProxyCommand=calc'] }), null);
  assert.equal(R.normalizeSsh({ destination: '-oProxyCommand=calc' }), null);
  assert.equal(R.normalizeSsh({ destination: 'myserver', options: ['-p', '-oX'] }), null);
  assert.equal(R.normalizeSsh({ destination: 'myserver', cmd: 'a\rb' }), null);
  assert.equal(R.normalizeSsh(null), null);
});

test('validHost', () => {
  for (const h of ['myserver', 'leo@myserver', '100.64.0.1', 'my-host.example.com', '[fe80::1]', 'leo@[::1]']) assert.ok(R.validHost(h), h);
  for (const h of ['', '-p', '-oProxyCommand=x', 'a b', 'a;b', 'a/b', 'a$(x)', '`x`', 'a\nb', 'x'.repeat(256)]) assert.ok(!R.validHost(h), h);
});

// ---------- ssh.exe ----------

test('findSshExe: the setting, then Windows OpenSSH, then Git for Windows', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const path = require('path');
  const win = path.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const git = path.join('C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe');
  const has = (...files) => (p) => files.includes(p);
  assert.equal(R.findSshExe('', { env, platform: 'win32', exists: has(win, git) }), win);
  assert.equal(R.findSshExe('', { env, platform: 'win32', exists: has(git) }), git);
  assert.equal(R.findSshExe('', { env, platform: 'win32', exists: has() }), null);
  assert.equal(R.findSshExe('D:\\tools\\ssh.exe', { env, platform: 'win32', exists: has('D:\\tools\\ssh.exe', win) }), 'D:\\tools\\ssh.exe');
  assert.equal(R.findSshExe('D:\\missing.exe', { env, platform: 'win32', exists: has(win) }), null, 'a set path that does not exist is not replaced');
});

// ---------- the process tree ----------

// pty pid 100 = the shell (bash.exe) under ConPTY
const TREE = [
  { pid: 4, ppid: 0, name: 'System', started: 1 },
  { pid: 100, ppid: 50, name: 'bash.exe', started: 1000 },
  { pid: 101, ppid: 100, name: 'bash.exe', started: 1100 }, // Git Bash's fork stub
  { pid: 102, ppid: 101, name: 'ssh.exe', cmd: '/usr/bin/ssh -p 2222 leo@myserver', started: 1200 },
  { pid: 103, ppid: 102, name: 'ssh.exe', cmd: 'ssh -W myserver:22 jump', started: 1210 }, // a ProxyJump helper below it
  { pid: 200, ppid: 7, name: 'ssh.exe', cmd: 'ssh other', started: 900 }, // another tab
];

test('sshOriginFromTree: the ssh under the tab\'s shell, not its helper, not another tab\'s', () => {
  assert.deepEqual(R.sshOriginFromTree(100, TREE), { destination: 'leo@myserver', options: ['-p', '2222'] });
  assert.equal(R.findSshInTree(100, TREE).pid, 102);
  assert.equal(R.sshOriginFromTree(7777, TREE), null, 'unknown pid');
  assert.equal(R.sshOriginFromTree(100, TREE.filter((p) => p.pid < 102)), null, 'no ssh: a local tab');
});

test('sshOriginFromTree: a reused parent pid of an older process is not followed', () => {
  const procs = [
    { pid: 100, ppid: 1, name: 'pwsh.exe', started: 5000 },
    { pid: 300, ppid: 100, name: 'ssh.exe', cmd: 'ssh stale', started: 10 }, // its real parent died long ago
  ];
  assert.equal(R.sshOriginFromTree(100, procs), null);
});

test('sshOriginFromTree: the newest of two connections; the tab itself being ssh', () => {
  const procs = [
    { pid: 100, ppid: 1, name: 'pwsh.exe', started: 10 },
    { pid: 110, ppid: 100, name: 'ssh.exe', cmd: 'ssh old', started: 20 },
    { pid: 120, ppid: 100, name: 'SSH.EXE', cmd: '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" new', started: 30 },
    { pid: 130, ppid: 1, name: 'ssh.exe', cmd: 'ssh.exe -l leo myserver', started: 40 },
  ];
  assert.equal(R.sshOriginFromTree(100, procs).destination, 'new');
  assert.deepEqual(R.sshOriginFromTree(130, procs), { destination: 'myserver', options: ['-l', 'leo'] });
});

test('parseProcessList reads the PowerShell output (one object or an array)', () => {
  assert.deepEqual(R.parseProcessList('{"p":1,"q":0,"n":"a","c":null,"t":5}'), [{ pid: 1, ppid: 0, name: 'a', cmd: null, started: 5 }]);
  assert.equal(R.parseProcessList('[{"p":1,"q":0,"n":"a"},{"p":2,"q":1,"n":"ssh.exe","c":"ssh x","t":0}]').length, 2);
  assert.deepEqual(R.parseProcessList('garbage'), []);
  assert.deepEqual(R.parseProcessList(''), []);
});

// ---------- limits and hosts ----------

test('RateLimiter: N per window per key, a sliding window', () => {
  const l = new R.RateLimiter(3, 1000);
  assert.deepEqual([0, 1, 2, 3].map((i) => l.take('a', i)), [true, true, true, false]);
  assert.equal(l.take('b', 4), true, 'per key');
  assert.equal(l.take('a', 1000), true, 'the first one has left the window');
  assert.equal(l.take('a', 1000), false, 'still 3 in the last second');
  assert.equal(l.take('a', 1001), true);
  assert.equal(l.take('a', 1001), false);
});

test('hostMatches: a host entry covers user@host; a user@host entry only itself', () => {
  assert.ok(R.hostMatches('myserver', 'myserver'));
  assert.ok(R.hostMatches('MyServer', 'leo@myserver'));
  assert.ok(R.hostMatches('leo@myserver', 'leo@myserver'));
  assert.ok(!R.hostMatches('leo@myserver', 'root@myserver'));
  assert.ok(!R.hostMatches('leo@myserver', 'myserver'));
  assert.ok(!R.hostMatches('myserver', 'myserver.evil.com'));
  assert.ok(!R.hostMatches('', 'x'));
});
