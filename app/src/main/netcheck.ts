/**
 * What else on this PC handles the network, written to tracker.log when Aion 2 starts: a player
 * whose capture got 2-10% of the game stream (2026-10-28) could not be helped from a log that said
 * nothing about their PC.
 *
 * - Programs running that capture, tunnel or shape traffic (another meter, a ping reducer, a VPN,
 *   a motherboard's "gaming LAN" tool), from tasklist.
 * - Npcap's version, and for each connected adapter what else is bound to it (anything not
 *   Windows' own: a traffic shaper's filter driver sits there) and whether it merges received
 *   segments (receive segment coalescing), from PowerShell.
 *
 * Only names are read; nothing here touches another program.
 */
import { execFile } from 'node:child_process'

/** Programs known to capture, tunnel or reshape traffic, by what they are, matched on the image name. */
const KNOWN: { kind: string; name: RegExp }[] = [
  { kind: 'capture', name: /^(notmeter|a2tools|wireshark|dumpcap|tshark|fiddler|networkminer)/i },
  { kind: 'ping reducer', name: /^(exitlag|wtfast|noping|haste|mudfish|gearup|lagofast|outfox)/i },
  { kind: 'VPN', name: /^(nordvpn|protonvpn|expressvpn|surfshark|mullvad|openvpn|wireguard|tailscale|zerotier|hamachi|radmin ?vpn)/i },
  { kind: 'network tool', name: /^(cfosspeed|gamefirst|msi\.centralserver|dragoncenter|lanmanager|killer|netlimiter|glasswire|speedify)/i },
]

/** The known programs among tasklist's CSV lines, each once, as "Name.exe (kind)". */
export function knownPrograms(tasklist: string): string[] {
  const found = new Set<string>()
  for (const line of tasklist.split(/\r?\n/)) {
    const image = /^"([^"]+)"/.exec(line)?.[1]
    const known = image && KNOWN.find((k) => k.name.test(image))
    if (known) found.add(`${image} (${known.kind})`)
  }
  return [...found].sort((a, b) => a.localeCompare(b))
}

// One line per fact, tab-separated: `npcap <version>`, then `adapter <name> <bound> <rsc>`.
const SCRIPT = [
  "$v = (Get-ItemProperty 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NpcapInst' -ErrorAction SilentlyContinue).DisplayVersion",
  '"npcap`t$v"',
  "Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {",
  "  $b = (Get-NetAdapterBinding -Name $_.Name -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -and $_.ComponentID -notmatch '^ms_' } | ForEach-Object DisplayName) -join ', '",
  '  $r = (Get-NetAdapterRsc -Name $_.Name -ErrorAction SilentlyContinue).IPv4Enabled',
  '  "adapter`t$($_.Name)`t$b`t$r"',
  '}',
].join('\n')

/** The log lines for SCRIPT's output. */
export function adapterLines(out: string): string[] {
  const lines: string[] = []
  for (const line of out.split(/\r?\n/)) {
    const [what, a = '', b = '', c = ''] = line.trim().split('\t')
    if (what === 'npcap') lines.push(`network: Npcap ${a || 'not found in the installed programs'}`)
    if (what === 'adapter' && a) {
      const rsc = c === 'True' ? 'merges received segments (receive segment coalescing on)' : c === 'False' ? 'receive segment coalescing off' : null
      lines.push(`network: ${a}: ${b ? `also bound to ${b}` : 'nothing bound but Windows'}${rsc ? `; ${rsc}` : ''}`)
    }
  }
  return lines
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20_000 }, (err, out) => done(err ? null : out))
  })
}

/** Look, then log what was found. Never throws: a look that fails is said and skipped. */
export async function logNetworkSoftware(log: (line: string) => void): Promise<void> {
  if (process.platform !== 'win32') return
  const tasks = await run('tasklist', ['/FO', 'CSV', '/NH'])
  if (tasks === null) log('network: could not list the programs running')
  else {
    const known = knownPrograms(tasks)
    log(known.length ? `network: also running: ${known.join(', ')}` : 'network: no known capture, ping reducer, VPN or network tool running')
  }
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT])
  if (out === null) log('network: could not read the adapters')
  else for (const line of adapterLines(out)) log(line)
}
