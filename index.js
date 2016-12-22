/* eslint no-console: 0 */

'use strict';

const config = require('config');
const level = require('levelup');
const leveldown = require('leveldown-basho-andris');
const mailsplit = require('mailsplit');
const SMTPConnection = require('smtp-connection');
const levelStreamAccess = require('level-stream-access');
const PassThrough = require('stream').PassThrough;
const fs = require('fs');
let lastProcessedIndex;
let fpath = __dirname + '/.lastsync.txt';
let streamer;
let connection;

console.log('Pump messages from db to SMTP');

try {
    lastProcessedIndex = fs.readFileSync(fpath, 'utf-8').trim();
    console.log('Starting from %s', lastProcessedIndex);
} catch (E) {
    lastProcessedIndex = 'seq ';
}

let db = level(config.queue, {
    createIfMissing: true,
    db: leveldown
}, () => {
    let messages = [];
    streamer = levelStreamAccess(db);

    db.createReadStream({
        gt: lastProcessedIndex,
        lt: 'seq ~',
        values: false,
        keys: true
    }).on('data', key => {
        messages.push(key);
    }).on('error', err => {
        console.log('Oh my!', err);
        db.close();
    }).on('close', () => {
        console.log('Stream closed');
    }).on('end', () => {
        console.log('Stream ended');
        sendMessages(db, messages);
    });
});

db.on('error', err => {
    console.log('ERROR');
    console.log(err);
    process.exit(1);
});

db.on('closing', () => {
    console.log('Database closing...');
});

db.on('closed', () => {
    console.log('Database closed');
});

function sendMessages(db, messages) {
    let pos = 0;
    let processNext = () => {
        if (pos >= messages.length) {
            console.log('DONE');
            return db.close();
        }
        let seqKey = messages[pos++];

        if (!seqKey) {
            console.log('NO SEQ KEY');
            return processNext();
        }

        try {
            fs.writeFileSync(fpath, seqKey);
        } catch (E) {
            console.log('FAILED writing %s', seqKey);
            console.log(E);
            return db.close();
        }

        sendMessage(seqKey, err => {
            if (err) {
                console.log('FAILED message "%s"', seqKey);
                console.log(err);
            }

            setImmediate(processNext);
        });
    };
    processNext();
}


function sendMessage(seqKey, callback) {
    db.get(seqKey, (err, refKey) => {
        if (err) {
            return callback(err);
        }
        console.log('Processing %s', refKey);
        db.get(refKey, (err, data) => {
            if (err) {
                return callback(err);
            }
            let message;
            try {
                message = JSON.parse(data);
            } catch (E) {
                console.log('PARSE ERROR');
                console.log(data);
                return callback(E);
            }

            streamer.getMeta('message ' + message.id, (err, meta) => {
                if (err) {
                    return callback(err);
                }

                if (!meta) {
                    console.log('NO META FOUND FOR %s', message.id);
                    return callback(null);
                }

                Object.keys(meta || {}).forEach(key => {
                    if (!(key in message)) {
                        message[key] = meta[key];
                    }
                });

                message.headers = new mailsplit.Headers(message.headers);

                console.log('Message %s from=%s to=%s', message.id, message.from, message.recipient);

                message.headers.add('X-Sending-Zone', 'rescue');

                getConnection((err, connection) => {
                    if (err) {
                        return callback(err);
                    }
                    connection.send({
                        from: message.from,
                        to: [message.recipient]
                    }, getMessageStream(message), (err, info) => {
                        if (err) {
                            return callback(err);
                        }
                        console.log(info.response);
                        return callback(null, true);
                    });
                });
            });
        });
    });

}

function getMessageStream(message) {
    let s = new PassThrough();
    s.write(message.headers.build());
    streamer.createReadStream('message ' + message.id).pipe(s);
    return s;
}

function getConnection(callback) {
    if (connection) {
        return setImmediate(() => callback(null, connection));
    }
    connection = new SMTPConnection(config.smtp);
    connection.on('error', err => {
        console.log('CONNECTION ERROR');
        console.log(err);
        db.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 100);
    });

    connection.connect(() => callback(null, connection));
}
