// The connection address as the platform reports it (`CF-Connecting-IP`), normalized for use as a rate-limit key.
// It is only ever hashed under the rotating salt; it is never stored or logged.
//
// - IPv4 addresses are used as they are.
// - IPv6 addresses collapse to their /64 prefix (an end user typically holds a whole /64, so a per-address key
//   would give one household 2^64 free identities). An IPv4-mapped IPv6 address counts as the IPv4 address.
// - A missing or unparseable header fails SAFE: every such request shares ONE bucket, and that bucket has much
//   stricter limits (see `UNKNOWN_*` in constants.ts), so removing the header can never earn more allowance.

export const UNKNOWN_CONNECTION = "unknown";

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Expands an IPv6 text form to eight 16-bit groups, or null when it is not one. */
function ipv6Groups(text: string): number[] | null {
  let rest = text;
  const zone = rest.indexOf("%");
  if (zone >= 0) rest = rest.slice(0, zone);
  if (rest.startsWith("[") && rest.endsWith("]")) rest = rest.slice(1, -1);
  if (!rest.includes(":") || /[^0-9a-fA-F:.]/.test(rest)) return null;
  // A trailing dotted IPv4 stands for the last two groups.
  const lastColon = rest.lastIndexOf(":");
  const tail = rest.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    rest = `${rest.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return groups.map((g) => parseInt(g, 16));
  };
  const head = parse(halves[0]!);
  const back = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !back) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - back.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...back];
}

/** The key material for a raw address: `1.2.3.4`, `v6:2001:db8:0:1` (the /64) or `unknown`. */
export function normalizeConnection(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return UNKNOWN_CONNECTION;
  if (IPV4.test(value)) return value;
  const groups = ipv6Groups(value);
  if (!groups) return UNKNOWN_CONNECTION;
  // ::ffff:a.b.c.d is IPv4 in IPv6 clothes.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `v6:${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}`;
}

export function connectionAddress(request: Request): string {
  return normalizeConnection(request.headers.get("CF-Connecting-IP"));
}

/** False when the platform did not tell us who is connecting: the strict shared bucket applies. */
export function isKnownConnection(request: Request): boolean {
  return connectionAddress(request) !== UNKNOWN_CONNECTION;
}
