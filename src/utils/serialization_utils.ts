/*
 *    Copyright 2016 Rethink Robotics
 *
 *    Copyright 2016 Chris Smith
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

import { Transform } from 'stream';
import * as ros_msg_utils from '../ros_msg_utils/index';
const base_serializers = ros_msg_utils.Serialize;
const base_deserializers = ros_msg_utils.Deserialize;

//-----------------------------------------------------------------------

/**
 * DeserializeStream handles parsing of message chunks for TCPROS
 * encoded messages. When a full message has been received, it
 * emits 'message' with the data for that message. All socket
 * communications should be piped through this.
 */
export class DeserializeStream extends Transform  {
  private _inBody: boolean;
  private _messageConsumed: number;
  private _messageLen: number;
  private _messageBuffer: Buffer[];
  private _deserializeServiceResp: boolean;
  private _serviceRespSuccess: null|number;

  constructor(options?: any) {
    super(options);

    // Transform.call(this, options);
    // true once we've pulled off the message length
    // for the next message we'll need to deserialize
    this._inBody = false;

    // track how many bytes of this message we've received so far
    this._messageConsumed = 0;

    // how long this message will be
    this._messageLen = -1;

    // as bytes of this message arrive, store them in this
    // buffer until we have the whole thing
    this._messageBuffer = [];

    // TODO: These are specific to parsing a service response...
    //   don't use them everywhere
    // the first byte in a service response is true/false service success/fail
    this._deserializeServiceResp = false;

    this._serviceRespSuccess = null;
  }

  _transform(chunk: Buffer, encoding: string, done: () => void) {
    let pos = 0;
    let chunkLen = chunk.length;

    while (pos < chunkLen) {
      if (this._inBody) {
        let messageRemaining = this._messageLen - this._messageConsumed;

        // if the chunk is longer than the amount of the message we have left
        // just pull off what we need
        if (chunkLen >= messageRemaining + pos) {
          let slice = chunk.slice(pos, pos + messageRemaining);
          this._messageBuffer.push(slice);
          let concatBuf = Buffer.concat(this._messageBuffer, this._messageLen);
          this.emitMessage(concatBuf);

          // message finished, reset
          this._messageBuffer = [];
          pos += messageRemaining;
          this._inBody = false;
          this._messageConsumed = 0;
        }
        else {
          // rest of the chunk does not complete the message
          // cache it and move on
          this._messageBuffer.push(chunk.slice(pos));
          this._messageConsumed += chunkLen - pos;
          pos = chunkLen;
        }
      }
      else {
        // if we're deserializing a service response, first byte is 'success'
        if (this._deserializeServiceResp &&
            this._serviceRespSuccess === null) {
          this._serviceRespSuccess = chunk.readUInt8(pos);
          ++pos;
        }

        let bufLen = 0;
        this._messageBuffer.forEach((bufferEntry) => {
          bufLen += bufferEntry.length;
        });

        // first 4 bytes of the message are a uint32 length field
        if (chunkLen - pos >= 4 - bufLen) {
          this._messageBuffer.push(chunk.slice(pos, pos + 4 - bufLen));
          const buffer = Buffer.concat(this._messageBuffer, 4);
          this._messageLen = buffer.readUInt32LE(0);
          pos += 4 - bufLen;

          this._messageBuffer = []
          // if its an empty message, there won't be any bytes left and message
          // will never be emitted -- handle that case here
          if (this._messageLen === 0 && pos === chunkLen) {
            this.emitMessage(new Buffer([]));
          }
          else {
            this._inBody = true;
          }
        }
        else {
          // the length field is split on a chunk
          this._messageBuffer.push(chunk.slice(pos));
          pos = chunkLen;
        }
      }
    }
    done();
  }

  emitMessage(buffer: Buffer): void {
    if (this._deserializeServiceResp) {
      this.emit('message', buffer, this._serviceRespSuccess);
      this._serviceRespSuccess = null;
    }
    else {
      this.emit('message', buffer);
    }
  }

  setServiceRespDeserialize(): void {
    this._deserializeServiceResp = true;
  }
};


//-----------------------------------------------------------------------

export function PrependLength(buffer: Buffer): Buffer {
  let lenBuf = new Buffer(4);
  lenBuf.writeUInt32LE(buffer.length, 0);
  return Buffer.concat([lenBuf, buffer], buffer.length + 4);
}

export function serializeStringFields(fields: string[]): Buffer {
  let length = 0;
  for (const field of fields) {
    length += (Buffer.byteLength(field) + 4);
  }
  let buffer = Buffer.allocUnsafe(4 + length);
  let offset = base_serializers.uint32(length, buffer, 0);

  for (const field of fields) {
    offset = base_serializers.string(field, buffer, offset);
  }
  return buffer;
}

export function deserializeStringFields(buffer: Buffer): string[] {
  const fields: string[] = [];
  const offset = [0];
  while (offset[0] < buffer.length) {
    const str = base_deserializers.string(buffer, offset);
    fields.push(str);
  }

  return fields;
}

export function serializeString(str: string): Buffer {
  const buf = Buffer.allocUnsafe(str.length + 4);
  base_serializers.string(str, buf, 0);
  return buf;
}

export function deserializeString(buffer: Buffer): string {
  return base_deserializers.string(buffer, [0]);
}
