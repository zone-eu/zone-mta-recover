# ZoneMTA Recovery tool

## What is this?

It's a recovery tool to use when things go bad with ZoneMTA queue. You can use it to repair a failed queue and pump messages from a queue folder to a MTA.

**NB!** you need read/write rights for the queue folder if you want to run these commands

## Setup

1. Install dependencies

```
npm install
```

2. Modify config file config/default.js

## Repair

Repair command tries to repair a bad LevelDB database. It might be destructive, so handle with care. Do not repair databases that do not need repairing.

```
npm run repair
```

Example output

```
info REPAIR Database repair completed
```

## Pump

Pump command pumps all messages from the queue folder to the next MTA over SMTP.

You need write rights for the queue folder (pump does not modify data but leveldb driver might want to process some compactions etc.) and current folder (command stores last processed index to the file *.lastsync.txt*). Messages are processed in sequence in the order the messages were stored to the queue (so in most cases you start with older deferred messages and end up with the newest messages).

```
npm run pump
```

Example output

```
info Pump Pump messages from DB to SMTP
info Pump ZoneMTA queue location: "/Users/andris/Projects/test-mta/data"
info Pump Target host : "localhost"
info Pump Target port : "2525"
info Pump Use SSL     : "NO"
info Pump Use auth    : "NO"
info Pump Enumerating messages from "seq 15949d9641e00020bb 009"
info Pump Database opened at "/Users/andris/Projects/test-mta/data"
info Pump Stream ended. Retrieved 201 messages
info Pump Stream closed
info Pump Processing next message. seq="seq 15949d9641e00020bb 00a" ref="ref 15949d9641e00020bb default rcpt-15949d958ec046%40sub-0.localtest.me"
info Pump 15949d9641e00020bb.00a ACCEPTED from=andris@localtest.me to=rcpt-15949d958ec046@sub-0.localtest.me response="250 Message queued as c933796ada0b072085a2a16b21e29629.1.1483002918069"
...
```

If you get C assertion errors then you might try removing that particular assertion from the leveldb module in node_modules and rebuilding this module. Pump command does not write anything to the database, only reads from it, so partial failures are tolerable.

If you want to restart message pumping or pump to another location, then delete the *.lastsync.txt* file that holds the last processed message index.
