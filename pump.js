'use strict';

const log = require('npmlog');
const config = require('config');
const level = require('levelup');
const leveldown = require(config.backend);
const mailsplit = require('mailsplit');
const SMTPConnection = require('smtp-connection');
const levelStreamAccess = require('level-stream-access');
const PassThrough = require('stream').PassThrough;
const fs = require('fs');

let lastProcessedIndex;
let fpath = __dirname + '/.lastsync.txt';
let streamer;
let connection;

log.info('Pump', 'Pump messages from DB to SMTP');
log.info('Pump', 'ZoneMTA queue location: "%s"', config.queue);
log.info('Pump', 'Target host : "%s"', config.smtp.host || 'unset');
log.info('Pump', 'Target port : "%s"', config.smtp.port || 'unset');
log.info('Pump', 'Use SSL     : "%s"', config.smtp.secure ? 'YES' : 'NO');
log.info('Pump', 'Use auth    : "%s"', config.smtp.auth ? 'YES' : 'NO');

try {
    lastProcessedIndex = fs.readFileSync(fpath, 'utf-8').trim();
    log.info('Pump', 'Enumerating messages from "%s"', lastProcessedIndex);
} catch (E) {
    lastProcessedIndex = 'seq ';
    log.info('Pump', 'Enumerating messages from start');
}

let db = level(config.queue, {
    createIfMissing: true,
    db: leveldown
}, () => {
    log.info('Pump', 'Database opened at "%s"', config.queue);
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
        log.error('Pump', 'Failed reading from stream. error="%s"', err.message);
        db.close();
    }).on('close', () => {
        log.info('Pump', 'Stream closed');
    }).on('end', () => {
        log.info('Pump', 'Stream ended. Retrieved %s messages', messages.length);
        if(!messages.length){
            return setTimeout(close, 100);
        }
        sendMessages(db, messages);
    });
});

db.on('error', err => {
    log.error('Pump', 'Databse error. error="%s"', err.message);
    process.exit(1);
});

db.on('closing', () => {
    log.info('Pump', 'Database closing...');
});

db.on('closed', () => {
    log.info('Pump', 'Database closed');
});

function close() {
    if (connection) {
        connection.close();
    }
    db.close();
}

function sendMessages(db, messages) {
    let pos = 0;
    let processNext = () => {
        if (pos >= messages.length) {
            log.info('Pump', 'All messages processed');
            return close();
        }
        let seqKey = messages[pos++];

        if (!seqKey) {
            log.error('Pump', 'Invalid sequence key retrieved from stream');
            return processNext();
        }

        try {
            fs.writeFileSync(fpath, seqKey);
        } catch (E) {
            log.error('Pump', 'Failed updating sequence key. key="%s" error="%s"', seqKey, E.message);
            return close();
        }

        sendMessage(seqKey, err => {
            if (err) {
                log.error('Pump', 'Failed sending message. key="%s" error="%s"', seqKey, err.message);
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
        log.info('Pump', 'Processing next message. seq="%s" ref="%s"', seqKey, refKey);
        db.get(refKey, (err, data) => {
            if (err) {
                return callback(err);
            }
            let message;
            try {
                message = JSON.parse(data);
            } catch (E) {
                log.error('Pump', 'Invalid content for ref key. error="%s" data="%s"', E.message, Buffer.from(data).toString('base64'));
                return callback(E);
            }

            streamer.getMeta('message ' + message.id, (err, meta) => {
                if (err) {
                    return callback(err);
                }

                if (!meta) {
                    log.error('Pump', 'No metadata found for ref key, skipping');
                    return callback(null);
                }

                Object.keys(meta || {}).forEach(key => {
                    if (!(key in message)) {
                        message[key] = meta[key];
                    }
                });

                message.headers = new mailsplit.Headers(message.headers);
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
                            log.info('Pump', '%s.%s FAILED from=%s to=%s response="%s" error="%s"', message.id, message.seq, message.from, message.recipient, err.response || err.message);
                            return callback();
                        }
                        log.info('Pump', '%s.%s ACCEPTED from=%s to=%s response="%s"', message.id, message.seq, message.from, message.recipient, info.response);
                        return callback();
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
        log.error('Pump', 'Connection error. error="%s"', err.message);
        db.close(() => process.exit(1));
        setTimeout(() => process.exit(1), 100);
    });

    connection.connect(() => callback(null, connection));
}
