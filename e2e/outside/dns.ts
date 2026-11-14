// A name server that knows only the test's names. Every one of them is this
// container; anything else does not exist, so nothing of the test leaves the
// machine. It answers A queries; other types of a known name get no records.
import dgram from "node:dgram";

const TYPE_A = 1;

export type Lookup = { name: string; qtype: number };

/** The reply to one query, or undefined when it cannot be read. */
export function answer(query: Buffer, names: ReadonlySet<string>, address: string): { reply: Buffer; lookup: Lookup } | undefined {
  if (query.length < 12) return undefined;
  let offset = 12;
  const labels: string[] = [];
  for (;;) {
    const length = query[offset];
    if (length === undefined) return undefined;
    offset++;
    if (length === 0) break;
    if (length > 63 || offset + length > query.length) return undefined;
    labels.push(query.subarray(offset, offset + length).toString("latin1"));
    offset += length;
  }
  if (offset + 4 > query.length) return undefined;
  const qtype = query.readUInt16BE(offset);
  const question = query.subarray(12, offset + 4);
  const name = labels.join(".").toLowerCase();
  const known = names.has(name);
  const records: Buffer[] = [];
  if (known && qtype === TYPE_A) {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0); // the name, as in the question
    record.writeUInt16BE(TYPE_A, 2);
    record.writeUInt16BE(1, 4); // IN
    record.writeUInt32BE(30, 6); // TTL
    record.writeUInt16BE(4, 10);
    address.split(".").forEach((part, index) => record.writeUInt8(Number(part), 12 + index));
    records.push(record);
  }
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0); // id
  const rd = query.readUInt16BE(2) & 0x0100;
  header.writeUInt16BE(0x8000 | 0x0400 | rd | 0x0080 | (known ? 0 : 3), 2); // QR, AA, RD, RA, NXDOMAIN
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(records.length, 6);
  return { reply: Buffer.concat([header, question, ...records]), lookup: { name, qtype } };
}

export function serveDns(port: number, names: ReadonlySet<string>, address: string, seen: (lookup: Lookup) => void): dgram.Socket {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, from) => {
    const result = answer(message, names, address);
    if (!result) return;
    seen(result.lookup);
    socket.send(result.reply, from.port, from.address);
  });
  socket.bind(port);
  return socket;
}
