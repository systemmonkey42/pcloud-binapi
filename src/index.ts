import * as dotenv from 'dotenv';
import { Socket, connect, NetConnectOpts } from 'net';

dotenv.config({ path: __dirname + '/../.env' });

let pack_request = (b: Buffer[]): Buffer => {
    let len: number = b.reduce((i: number, e: Buffer): number => i + e.length, 0);
    let header: Buffer = Buffer.alloc(2);
    header.writeUint16LE(len);
    return Buffer.concat([ header, ...b ]);
};

let gen_request = (id: string, data: number, params: Buffer[]): Buffer => {
    let len = id.length + 2;
    let o = 0;
    if (data > 0) {
        len += 8;
    }
    let b: Buffer = Buffer.alloc(len);

    b[o++] = id.length;
    if (data) {
        b[o - 1] |= 0x80;
        b.writeBigUint64LE(BigInt(data), o);
        o += 8;
    }

    b.write(id, o);
    o += id.length;
    b.writeUint8(params.length, o++);

    return pack_request([ b, ...params ]);
};

let gen_string_param = (id: string, data: string): Buffer => {
    let b: Buffer = Buffer.alloc(id.length + data.length + 5);

    let o = 0;
    b[o++] = id.length;
    b.write(id, o);
    o += id.length;

    b.writeUint32LE(data.length, o);
    o += 4;
    b.write(data, o);

    return b;
};

let gen_number_param = (id: string, data: number): Buffer => {
    let b: Buffer = Buffer.alloc(9 + id.length);
    let o = 0;

    b[o++] = id.length + 0x40;
    b.write(id, o);
    o += id.length;
    b.writeBigUint64LE(BigInt(data), o);

    return b;
};

type ResultType = { [key: string]: any } | string | number | boolean | undefined;

let unpack_response = (data: Buffer): ResultType => {
    let cache: string[] = [];
    let id = 0;
    let unpack_hash = (): ResultType => {
        let r: ResultType = {};
        while (true) {
            let n = unpack_payload();
            if (typeof n === 'string') {
                r[n] = unpack_payload();
            } else {
                break;
            }
        }
        return r;
    };
    let unpack_variable_length_number = (l: number): number => {
        let val = 0;
        let s = o;
        let v = (o += l);
        while (v > s) {
            val = 256 * val + data[--v];
        }
        return val;
    };
    let unpack_string = (code: number): string | undefined => {
        if (code >= 0 && code <= 3) {
            let len = unpack_variable_length_number(code + 1);
            let str = data.slice(o, o + len).toString('utf-8');
            o += len;
            cache[id++] = str;
            return str;
        } else if (code >= 100 && code <= 149) {
            let len = code - 100;
            let str = data.slice(o, o + len).toString('utf-8');
            o += len;
            cache[id++] = str;
            return str;
        } else {
            console.log('Error: Unpack string: code = %d\n', code);
        }
        return undefined;
    };
    let unpack_number = (code: number): number | undefined => {
        if (code >= 200 && code <= 219) {
            return code - 200;
        } else if (code >= 8 && code <= 15) {
            return unpack_variable_length_number(code - 7);
        } else {
            console.log('Unknown number code', code);
        }
        return undefined;
    };
    let unpack_boolean = (code: number): boolean => code === 19;
    let unpack_array = (): ResultType[] => {
        let r: ResultType[] = [];
        while (true) {
            let n = unpack_payload();
            if (typeof n === 'undefined') {
                break;
            } else {
                r.push(n);
            }
        }
        return r;
    };
    let unpack_payload = (): ResultType | ResultType[] => {
        let code = data[o++];
        if (code === 16) {
            return unpack_hash();
        } else if ((code >= 0 && code <= 3) || (code >= 100 && code <= 149)) {
            return unpack_string(code);
        } else if (code >= 150 && code <= 199) {
            return cache[code - 150];
        } else if ((code >= 8 && code <= 15) || (code >= 200 && code <= 219)) {
            return unpack_number(code);
        } else if (code >= 18 && code <= 19) {
            return unpack_boolean(code);
        } else if (code === 17) {
            return unpack_array();
        } else if (code == 255) {
            return undefined;
        } else {
            console.log(`code type ${code} not supported\n`);
        }
        return undefined;
    };

    let o = 0;
    let len = data.readUint32LE(o);
    o += 4;
    return unpack_payload();
};

let token = process.env.TOKEN || '';

let datalen: number = 0;

let last_req: (val: ResultType) => void;
let request = (data: Buffer): Promise<ResultType> => {
    return new Promise(ok => {
        last_req = ok;
        sock.write(data);
    });
};

let req_stat = (type: string, name: string | number): Promise<ResultType> => {
    let req: Buffer[] = [];
    req.push(gen_string_param('access_token', token));
    if (typeof name === 'string') {
        req.push(gen_string_param(type, name));
    } else {
        req.push(gen_number_param(type, name));
    }
    return request(gen_request('stat', datalen, req));
};

let req_getfilelink = (type: string, name: string | number): Promise<ResultType> => {
    let req: Buffer[] = [];
    req.push(gen_string_param('access_token', token));
    if (typeof name === 'string') {
        req.push(gen_string_param(type, name));
    } else {
        req.push(gen_number_param(type, name));
    }
    return request(gen_request('getfilelink', datalen, req));
};

let file_id = process.argv[2];

let sock: Socket = connect({
    host: 'api.pcloud.com',
    port: 8398,
} as NetConnectOpts)
    .on('connect', () => {
        req_stat('fileid', file_id).then((r: ResultType) => {
            console.log(JSON.stringify(r, undefined, 4));
            req_getfilelink(`fileid`, file_id).then((r: ResultType) => {
                console.log(JSON.stringify(r, undefined, 4));
                if (typeof r === 'object') {
                    console.log(`curl -s https://${r.hosts[0]}${r.path}`);
                }
            });

            sock.end();
        });
    })
    .on('data', (data: Buffer) => {
        let r = unpack_response(data);
        last_req(r);
    });
