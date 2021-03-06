import {
  assert,
  assertEquals,
  BufReader,
  Deferred,
  deferred,
} from "../deps.ts";
import { MessageHeader, parseHeader, serializeHeader } from "./header.ts";
import { parseOpMsg, Section, serializeOpMsg } from "./op_msg.ts";

export class MongoProtocol {
  #reader: BufReader;
  #socket: Deno.Writer & Deno.Closer;
  #requestIDCounter = 0;
  #ops: Record<number, Deferred<[MessageHeader, Uint8Array]>> = {};
  #polling = false;

  constructor(socket: Deno.Reader & Deno.Writer & Deno.Closer) {
    this.#reader = new BufReader(socket);
    this.#socket = socket;
  }

  private async send(header: MessageHeader, body: Uint8Array) {
    const buf = serializeHeader(header);
    await Deno.writeAll(this.#socket, buf);
    await Deno.writeAll(this.#socket, body);
  }

  private async wake() {
    if (this.#polling) return;
    await this.receiveLoop();
  }

  private async receiveLoop() {
    this.#polling = true;
    while (Object.keys(this.#ops).length > 0) {
      const headerBuf = await this.#reader.readFull(new Uint8Array(16));
      assert(headerBuf);
      const header = parseHeader(headerBuf);

      const buf = await this.#reader.readFull(
        new Uint8Array(header.messageLength - 16),
      );
      assert(buf);

      this.#ops[header.responseTo].resolve([header, buf]);
      delete this.#ops[header.responseTo];
    }
    this.#polling = false;
  }

  private async receive(reqID: number): Promise<[MessageHeader, Uint8Array]> {
    this.#ops[reqID] = deferred();
    this.wake();
    const resp = await this.#ops[reqID];
    return resp;
  }

  private nextRequestID(): number {
    this.#requestIDCounter++;
    return this.#requestIDCounter;
  }

  async executeOpMsg(sections: Section[]): Promise<Section[]> {
    const reqID = this.nextRequestID();
    const op = serializeOpMsg({
      sections,
    });
    await this.send({
      messageLength: 16 + op.byteLength,
      opCode: 2013,
      requestID: reqID,
      responseTo: 0,
    }, op);
    const [header, buf] = await this.receive(reqID);
    assertEquals(header.opCode, 2013);

    const res = parseOpMsg(buf);

    return res.sections;
  }

  close() {
    this.#socket.close();
  }
}
