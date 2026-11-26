'use strict';
// Remote control over ssh, the pure parts: OSC 7711 / 9 / 777, the token, ssh command lines and their
// quoting, the process tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
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

test('open: all fields decoded; select defaults to 1; rerun and token only when sent', () => {
  const r = R.parseRemoteOsc(`open;host=${b('@same')};cmd=${b('htop -d 5')};name=${b('top')};ws=${b('ops')};select=0;rerun=0;token=${b('t0k')}`);
  assert.deepEqual(r, { action: 'open', host: '@same', cmd: 'htop -d 5', name: 'top', ws: 'ops', select: false, rerun: false, token: 't0k' });
  const d = R.parseRemoteOsc(`open;host=${b('leo@myserver')}`);
  assert.deepEqual(d, { action: 'open', host: 'leo@myserver', cmd: '', name: '', ws: '', select: true });
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};rerun=yes`).error, /rerun/);
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
  assert.match(R.parseRemoteOsc(`open;host=${b('@\\\\evil\\s')}`).error, /host/, 'an msys @file argument');
  assert.match(R.parseRemoteOsc(`open;host=${b('@other')}`).error, /host/);
  assert.match(R.parseRemoteOsc(`open;host=${b('[::1]')}`).error, /host/, 'no brackets');
  assert.match(R.parseRemoteOsc(`open;host=${b('my server')}`).error, /host/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a;b')}`).error, /host/);
  assert.match(R.parseRemoteOsc('open;host=@@@').error, /base64/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};host=${b('b')}`).error, /duplicate/);
  assert.match(R.parseRemoteOsc(`open;host=${b('a')};select=yes`).error, /select/);
  assert.match(R.parseRemoteOsc('x'.repeat(20000)).error, /longer/);
});

test('open: cmd must be one visible line of at most 512 characters', () => {
  const bad = ['ls\nrm -rf ~', 'ls\r', 'a\u2028b', 'a\u2029b', 'ls \u202erm', 'a\u061cb', 'a\u2060b', 'a\u2064b', 'a\u00adb', 'a\u180eb', 'a\u3164b', 'a\u{e0041}b', 'x'.repeat(513)];
  for (const c of bad) assert.match(R.parseRemoteOsc(`open;host=${b('a')};cmd=${b(c)}`).error, /cmd/, JSON.stringify(c));
  assert.equal(R.parseRemoteOsc(`open;host=${b('a')};cmd=${b('x'.repeat(512))}`).cmd.length, 512);
  assert.equal(R.parseRemoteOsc(`open;host=${b('a')};cmd=${b('make\ttest')}`).cmd, 'make\ttest', 'a tab is fine');
  assert.equal(R.displayCmd('ls      -la\t\t /'), 'ls -la /', 'shown with runs of spaces collapsed');
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

  const r = R.parseRemoteOsc(`rename;name=${b('\u202e\u2028\u00ad\u{e0041}' + 'n'.repeat(100))}`);
  assert.equal(r.name, 'n'.repeat(80), 'invisible characters removed, cut to 80');
  assert.match(R.parseRemoteOsc(`rename;name=${b('\x1b\x07')}`).error, /needs name/);
  assert.match(R.parseRemoteOsc('launch;x=1').error, /unknown action/);
});

// ---------- the token ----------

test('tokens: random per call; compared in constant time, nothing matches an empty one', () => {
  const t1 = R.newToken();
  assert.match(t1, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(R.newToken(), t1);
  assert.ok(R.tokenEquals(t1, t1));
  assert.ok(!R.tokenEquals(t1 + 'x', t1));
  assert.ok(!R.tokenEquals('', ''));
  assert.ok(!R.tokenEquals(undefined, t1));
  assert.ok(!R.tokenEquals(t1, undefined));
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
const ok = (destination, options = [], dropped = []) => ({ destination, options, dropped });

test('parseSshArgs: destination and the options that are carried over', () => {
  assert.deepEqual(parse('ssh leo@myserver'), ok('leo@myserver'));
  assert.deepEqual(parse('ssh 100.64.1.2'), ok('100.64.1.2'));
  assert.deepEqual(parse('ssh -p 2222 myserver'), ok('myserver', ['-p', '2222']));
  assert.deepEqual(parse('ssh -p2222 -lleo myserver'), ok('myserver', ['-p', '2222', '-l', 'leo']));
  assert.deepEqual(parse('ssh.exe -i "C:\\Users\\a b\\.ssh\\id" myserver'), ok('myserver', ['-i', 'C:\\Users\\a b\\.ssh\\id']));
  assert.deepEqual(parse('ssh -4 -J jump@bastion:22 myserver'), ok('myserver', ['-4', '-J', 'jump@bastion:22']));
  assert.deepEqual(parse('ssh -46vAtTqC myserver'), ok('myserver', ['-4', '-6']), 'harmless flags (and -A) are left out quietly');
});

test('parseSshArgs: options that change the connection are never carried over, and are reported', () => {
  assert.deepEqual(parse('ssh -o "ProxyCommand=calc.exe" myserver'), ok('myserver', [], ['-o']));
  assert.deepEqual(parse('ssh -oProxyCommand=calc myserver'), ok('myserver', [], ['-o']));
  assert.deepEqual(parse('ssh -F C:\\evil\\config -E log -L 8080:x:80 -R 9:y:9 -D 1080 -S sock -O check -W h:1 -X myserver'),
    ok('myserver', [], ['-F', '-E', '-L', '-R', '-D', '-S', '-O', '-W', '-X']));
  assert.deepEqual(parse('ssh -o Port=2222 -o Port=2 myserver').dropped, ['-o'], 'reported once');
});

test('parseSshArgs: --, options after the destination, the remote command, URIs', () => {
  assert.deepEqual(parse('ssh -- myserver'), ok('myserver'));
  assert.deepEqual(parse('ssh -- myserver -p 99'), ok('myserver'), 'after -- everything is the command');
  assert.deepEqual(parse('ssh myserver -p 2222'), ok('myserver', ['-p', '2222']), 'ssh takes options after the host too');
  assert.deepEqual(parse('ssh -t myserver tmux attach -t main'), ok('myserver'));
  assert.deepEqual(parse('ssh myserver -- -p 1'), ok('myserver'));
  assert.deepEqual(parse('ssh ssh://leo@myserver:2222'), ok('leo@myserver', ['-p', '2222']));
});

test('parseSshArgs: nothing usable -> null', () => {
  assert.equal(parse('ssh'), null);
  assert.equal(parse('ssh -p'), null, 'an option without its argument');
  assert.equal(parse('ssh -V'), null);
  assert.equal(parse('ssh -p 99999 myserver'), null, 'a port out of range');
  assert.equal(parse('ssh "my server"'), null);
  assert.equal(parse('ssh @hosts.txt'), null);
});

test('-i written the msys way (Git Bash ssh) becomes a Windows path', () => {
  assert.deepEqual(parse('ssh -i /c/Users/leo/.ssh/id_ed25519 myserver').options, ['-i', 'C:\\Users\\leo\\.ssh\\id_ed25519']);
  assert.deepEqual(parse('ssh -i ~/.ssh/id myserver').options, ['-i', '~/.ssh/id']);
});

test('destKey: user@host:port, the user and port from -l / -p too; port 22 is the default', () => {
  assert.equal(R.destKey({ destination: 'myserver' }), 'myserver');
  assert.equal(R.destKey({ destination: 'root@prod' }), 'root@prod');
  assert.equal(R.destKey({ destination: 'prod', options: ['-l', 'leo', '-p', '2222'] }), 'leo@prod:2222');
  assert.equal(R.destKey({ destination: 'a@prod', options: ['-l', 'b', '-p', '22'] }), 'a@prod', 'user@ wins over -l, like ssh');
});

test('IPv6 with a port: the key is bracketed, and the fields decide what is the same host', () => {
  const origin = { destination: 'leo@2001:db8::1', options: ['-p', '2222'] };
  const named = { destination: 'leo@2001:db8::1:2222' }; // another address, port 22
  assert.equal(R.destKey(origin), 'leo@[2001:db8::1]:2222');
  assert.equal(R.destKey(named), 'leo@[2001:db8::1:2222]');
  assert.notEqual(R.destKey(origin), R.destKey(named));
  assert.ok(!R.sameDest(named, origin));
  assert.ok(R.sameDest({ destination: 'leo@MyServer' }, { destination: 'leo@myserver', options: ['-p', '22'] }), 'host in any case, port 22 = none');
  assert.ok(!R.sameDest({ destination: 'Leo@myserver' }, { destination: 'leo@myserver' }), 'the user exactly');
  assert.ok(R.sameDest({ destination: 'myserver' }, { destination: 'myserver', options: ['-J', 'bastion'] }), '-J does not change the target');
  assert.ok(R.validKey('leo@[2001:db8::1]:2222'));
  assert.ok(!R.validKey('-x') && !R.validKey('@x') && !R.validKey('a b'));
});

test('hostMatches: the whole key, case-insensitively; "prod" does not cover "root@prod"', () => {
  assert.ok(R.hostMatches('myserver', 'myserver'));
  assert.ok(R.hostMatches('Leo@MyServer', 'leo@myserver'));
  assert.ok(!R.hostMatches('prod', 'root@prod'));
  assert.ok(!R.hostMatches('prod', 'prod:2222'));
  assert.ok(!R.hostMatches('leo@myserver', 'myserver'));
  assert.ok(!R.hostMatches('', 'x'));
});

test('buildSshArgs: terminal, SendEnv (with the token), options, then -- destination and the command as one argument', () => {
  assert.deepEqual(R.buildSshArgs({ destination: 'leo@myserver', options: ['-p', '2222'], cmd: 'cd ~/x && claude' }),
    ['-t', '-o', 'SendEnv=LC_TERMINAL', '-o', 'SendEnv=LC_TERMINAL_VERSION', '-o', 'SendEnv=KOLONKA_TOKEN', '-p', '2222', '--', 'leo@myserver', 'cd ~/x && claude']);
  assert.deepEqual(R.buildSshArgs({ destination: 'myserver', options: [], cmd: '' }).slice(-2), ['--', 'myserver'], 'no command: a login shell');
});

// ---------- quoting the command line ----------

const NASTY = ['@C:\\x', 'a*b', '~', '{a,b}', "'q'", '"', '\\"', 'a b', 'C:\\dir\\', 'x\\\\y', ''];

test('MSVCRT quoting (Windows OpenSSH): every argument in quotes, exact strings, and it parses back', () => {
  const want = ['"@C:\\x"', '"a*b"', '"~"', '"{a,b}"', '"\'q\'"', '"\\""', '"\\\\\\""', '"a b"', '"C:\\dir\\\\"', '"x\\\\y"', '""'];
  assert.deepEqual(NASTY.map(R.quoteMsvcrt), want);
  const line = 'ssh.exe ' + NASTY.map(R.quoteMsvcrt).join(' ');
  assert.deepEqual(R.parseWinCommandLine(line).slice(1), NASTY, 'the C runtime gets the arguments back unchanged');
});

// What the msys runtime of Git's ssh.exe does with a word that starts with a quote (dcrt0.cc:
// build_argv / quoted / globify): no @file, no glob; inside the quotes \ escapes the next character.
function msysUnquote(word) {
  assert.equal(word[0], '"');
  let out = '';
  let i = 1;
  for (; i < word.length; i++) {
    if (word[i] === '\\' && i + 1 < word.length) { out += word[++i]; continue; }
    if (word[i] === '"') break;
    out += word[i];
  }
  assert.equal(i, word.length - 1, 'the closing quote ends the word: ' + word);
  return out;
}

test('msys quoting (ssh.exe of Git for Windows): every argument starts with a quote, exact strings', () => {
  const want = ['"@C:\\\\x"', '"a*b"', '"~"', '"{a,b}"', '"\'q\'"', '"\\""', '"\\\\\\""', '"a b"', '"C:\\\\dir\\\\"', '"x\\\\\\\\y"', '""'];
  assert.deepEqual(NASTY.map(R.quoteMsys), want);
  assert.deepEqual(want.map(msysUnquote), NASTY);
});

test('sshCommandLine picks the quoting by the ssh.exe; nothing starts unquoted', () => {
  const argv = R.buildSshArgs({ destination: 'myserver', options: [], cmd: '@C:\\x' });
  const win = R.sshCommandLine('C:\\Windows\\System32\\OpenSSH\\ssh.exe', argv);
  const git = R.sshCommandLine('C:\\Program Files\\Git\\usr\\bin\\ssh.exe', argv);
  assert.equal(win, '"-t" "-o" "SendEnv=LC_TERMINAL" "-o" "SendEnv=LC_TERMINAL_VERSION" "-o" "SendEnv=KOLONKA_TOKEN" "--" "myserver" "@C:\\x"');
  assert.ok(git.endsWith('"--" "myserver" "@C:\\\\x"'));
  for (const line of [win, git]) for (const w of line.split(' ')) assert.equal(w[0], '"');
  assert.ok(R.isMsysSsh('C:/Program Files/Git/usr/bin/ssh.exe'));
  assert.ok(!R.isMsysSsh('C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe'));
  assert.ok(!R.isMsysSsh('D:\\tools\\ssh.exe'));
});

test('normalizeSsh rejects what could not have come from parseSshArgs; exe only if allowed', () => {
  assert.deepEqual(R.normalizeSsh({ destination: 'myserver', options: ['-p', '22'], cmd: 'ls' }), { destination: 'myserver', options: ['-p', '22'], cmd: 'ls' });
  assert.equal(R.normalizeSsh({ destination: 'myserver', options: ['-o', 'ProxyCommand=calc'] }), null);
  assert.equal(R.normalizeSsh({ destination: '-oProxyCommand=calc' }), null);
  assert.equal(R.normalizeSsh({ destination: '@x' }), null);
  assert.equal(R.normalizeSsh({ destination: 'myserver', options: ['-p', '-oX'] }), null);
  assert.equal(R.normalizeSsh({ destination: 'myserver', options: ['-i', '@\\\\evil\\s'] }), null);
  assert.equal(R.normalizeSsh({ destination: 'myserver', cmd: 'a\rb' }), null);
  assert.equal(R.normalizeSsh(null), null);
  assert.equal(R.normalizeSsh({ destination: 'x', exe: 'C:\\evil.exe' }, () => false).exe, undefined);
  assert.equal(R.normalizeSsh({ destination: 'x', exe: 'C:\\ok.exe' }, (p) => p === 'C:\\ok.exe').exe, 'C:\\ok.exe');
});

test('validHost', () => {
  for (const h of ['myserver', 'leo@myserver', '100.64.0.1', 'my-host.example.com', 'fe80::1']) assert.ok(R.validHost(h), h);
  for (const h of ['', '-p', '-oProxyCommand=x', '@file', '@same', '[fe80::1]', 'a b', 'a;b', 'a/b', 'a$(x)', '`x`', 'a\nb', 'x'.repeat(256)]) assert.ok(!R.validHost(h), h);
});

// ---------- ssh.exe ----------

test('findSshExe: the setting, then Windows OpenSSH, then Git for Windows', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const win = path.win32.join('C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const git = path.win32.join('C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe');
  const has = (...files) => (p) => files.includes(p);
  assert.equal(R.findSshExe('', { env, platform: 'win32', exists: has(win, git) }), win);
  assert.equal(R.findSshExe('', { env, platform: 'win32', exists: has(git) }), git);
  assert.equal(R.findSshExe('', { env, platform: 'win32', exists: has() }), null);
  assert.equal(R.findSshExe('D:\\tools\\ssh.exe', { env, platform: 'win32', exists: has('D:\\tools\\ssh.exe', win) }), 'D:\\tools\\ssh.exe');
  assert.equal(R.findSshExe('D:\\missing.exe', { env, platform: 'win32', exists: has(win) }), null, 'a set path that does not exist is not replaced');
});

test('isAllowedSshExe: only remote.ssh, Windows OpenSSH and an installed Git\'s ssh.exe', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const git = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';
  const has = (...files) => (p) => files.includes(p);
  assert.ok(R.isAllowedSshExe('c:\\windows\\system32\\OpenSSH\\SSH.EXE', '', { env, exists: has() }));
  assert.ok(R.isAllowedSshExe(git, '', { env, exists: has(git) }));
  assert.ok(!R.isAllowedSshExe(git, '', { env, exists: has() }), 'Git is not installed');
  assert.ok(R.isAllowedSshExe('D:\\tools\\ssh.exe', 'D:\\tools\\ssh.exe', { env, exists: has() }));
  assert.ok(!R.isAllowedSshExe('C:\\Users\\x\\Downloads\\ssh.exe', '', { env, exists: has('C:\\Users\\x\\Downloads\\ssh.exe') }));
  assert.ok(!R.isAllowedSshExe('', '', { env }));
});

// ---------- the process tree ----------

// pty pid 100 = the shell (bash.exe) under ConPTY
const TREE = [
  { pid: 4, ppid: 0, name: 'System', started: 1 },
  { pid: 100, ppid: 50, name: 'bash.exe', started: 1000 },
  { pid: 101, ppid: 100, name: 'bash.exe', started: 1100 }, // Git Bash's fork stub
  { pid: 102, ppid: 101, name: 'ssh.exe', cmd: '/usr/bin/ssh -p 2222 leo@myserver', exe: 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe', started: 1200 },
  { pid: 103, ppid: 102, name: 'ssh.exe', cmd: 'ssh -W myserver:22 jump', started: 1210 }, // a ProxyJump helper below it
  { pid: 200, ppid: 7, name: 'ssh.exe', cmd: 'ssh other', started: 900 }, // another tab
];

test('sshOriginFromTree: the ssh under the tab\'s shell, not its helper, not another tab\'s', () => {
  assert.deepEqual(R.sshOriginFromTree(100, TREE), { destination: 'leo@myserver', options: ['-p', '2222'], dropped: [], exe: 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe' });
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
  assert.deepEqual(R.sshOriginFromTree(130, procs), { destination: 'myserver', options: ['-l', 'leo'], dropped: [], exe: null });
});

test('parseProcessList reads the PowerShell output (one object or an array)', () => {
  assert.deepEqual(R.parseProcessList('{"p":1,"q":0,"n":"a","c":null,"t":5}'), [{ pid: 1, ppid: 0, name: 'a', cmd: null, exe: null, started: 5 }]);
  assert.equal(R.parseProcessList('[{"p":1,"q":0,"n":"a"},{"p":2,"q":1,"n":"ssh.exe","c":"ssh x","e":"C:\\\\x\\\\ssh.exe","t":0}]')[1].exe, 'C:\\x\\ssh.exe');
  assert.deepEqual(R.parseProcessList('garbage'), []);
  assert.deepEqual(R.parseProcessList(''), []);
});

// ---------- limits ----------

test('RateLimiter: N per window per key, a sliding window, a limit per call', () => {
  const l = new R.RateLimiter(3, 1000);
  assert.deepEqual([0, 1, 2, 3].map((i) => l.take('a', i)), [true, true, true, false]);
  assert.equal(l.take('b', 4), true, 'per key');
  assert.equal(l.take('a', 1000), true, 'the first one has left the window');
  assert.equal(l.take('a', 1000), false, 'still 3 in the last second');
  assert.equal(l.take('a', 1001), true);
  assert.equal(l.take('a', 1001), false);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => l.take('c', i, 5)), [true, true, true, true, true]);
});
